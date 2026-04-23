// Auto-discovery. Looks at company names surfaced by aggregator adapters
// (Adzuna, RemoteOK, TheMuse, Jobicy, Himalayas, HN), derives likely ATS
// slugs, and probes Greenhouse / Lever / Ashby endpoints. 200s are upserted
// into ats_tenants with discovered_via='auto'. 404s land in
// ats_probe_failures for a 30-day negative cache.

import type { Deps } from "./util/deps";
import { UA_GENERIC } from "./util/ua";
import { normalizeCompany } from "./normalize";
import type { AtsKind } from "./ats-registry";

type ProbeAts = Extract<AtsKind, "greenhouse" | "lever" | "ashby">;
const PROBE_ORDER: readonly ProbeAts[] = ["greenhouse", "lever", "ashby"] as const;

// Aggregator source tags whose company names we want to probe. Excludes the
// ATS-direct sources (their company names are already slugs we know).
const AGGREGATOR_SOURCES = [
  "adzuna",
  "remoteok",
  "themuse",
  "jobicy",
  "himalayas",
];

export interface DiscoverySummary {
  companies_scanned: number;
  probes_issued: number;
  hits: number;
  hit_detail: { ats: ProbeAts; slug: string; company: string }[];
}

// Derive plausible slug candidates from a company name. Kept small — each
// extra candidate costs a probe subrequest, and hit rates fall off fast past
// the first 2–3 forms. Reuses normalizeCompany so suffix stripping stays
// consistent with the dedup pipeline (Lever "Acme S.A." would otherwise
// slug differently than it dedups).
export function slugCandidates(company: string): string[] {
  // Drop apostrophes before normalizeCompany so "O'Reilly" collapses to
  // "oreilly" rather than "o reilly" (normalizeCompany inserts whitespace
  // for non-alphanumerics).
  const normalized = normalizeCompany(company.replace(/['‘’]/g, ""));
  if (!normalized) return [];
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const compact = tokens.join("");
  const hyphenated = tokens.join("-");
  const first = tokens[0]!;
  const candidates = new Set<string>();
  for (const c of [first, compact, hyphenated]) {
    if (c && c.length <= 40 && c.length >= 2) candidates.add(c);
  }
  return [...candidates];
}

function probeUrl(ats: ProbeAts, slug: string): string {
  switch (ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
  }
}

async function probe(
  ats: ProbeAts,
  slug: string,
  deps: Deps,
): Promise<number> {
  try {
    const resp = await deps.fetch(probeUrl(ats, slug), {
      method: "GET",
      headers: { "User-Agent": UA_GENERIC, Accept: "application/json" },
    });
    return resp.status;
  } catch {
    return 0;
  }
}

async function loadKnownSlugs(db: D1Database): Promise<Record<ProbeAts, Set<string>>> {
  const map: Record<ProbeAts, Set<string>> = {
    greenhouse: new Set(),
    lever: new Set(),
    ashby: new Set(),
  };
  const res = await db
    .prepare(
      `SELECT ats, slug FROM ats_tenants WHERE ats IN ('greenhouse','lever','ashby')`,
    )
    .all<{ ats: string; slug: string }>();
  for (const r of res.results ?? []) {
    const set = map[r.ats as ProbeAts];
    if (set) set.add(r.slug);
  }
  return map;
}

async function loadRecentFailures(db: D1Database): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await db
    .prepare(
      `SELECT ats, slug FROM ats_probe_failures
       WHERE last_probed_at > datetime('now', '-30 days')`,
    )
    .all<{ ats: string; slug: string }>();
  for (const r of res.results ?? []) out.add(`${r.ats}:${r.slug}`);
  return out;
}

async function loadRecentAggregatorCompanies(
  db: D1Database,
  limit: number,
): Promise<string[]> {
  const placeholders = AGGREGATOR_SOURCES.map(() => "?").join(",");
  const res = await db
    .prepare(
      `SELECT company, COUNT(*) AS n
       FROM jobs
       WHERE (source IN (${placeholders}) OR source LIKE 'hn:%')
         AND first_seen_at > datetime('now', '-48 hours')
       GROUP BY LOWER(company)
       ORDER BY n DESC
       LIMIT ?`,
    )
    .bind(...AGGREGATOR_SOURCES, limit)
    .all<{ company: string; n: number }>();
  return (res.results ?? []).map((r) => r.company);
}

export interface DiscoveryConfig {
  maxProbes?: number;      // default 30
  companyLimit?: number;   // default 80 — how many candidate companies to consider
}

export async function runDiscovery(
  db: D1Database,
  deps: Deps,
  nowIso: string,
  config: DiscoveryConfig = {},
): Promise<DiscoverySummary> {
  const maxProbes = config.maxProbes ?? 30;
  const companyLimit = config.companyLimit ?? 80;

  const [companies, known, failures] = await Promise.all([
    loadRecentAggregatorCompanies(db, companyLimit),
    loadKnownSlugs(db),
    loadRecentFailures(db),
  ]);

  const summary: DiscoverySummary = {
    companies_scanned: companies.length,
    probes_issued: 0,
    hits: 0,
    hit_detail: [],
  };

  const insertHits: { ats: ProbeAts; slug: string; meta: string | null }[] = [];
  const insertFails: { ats: ProbeAts; slug: string; status: number }[] = [];

  outer: for (const company of companies) {
    const candidates = slugCandidates(company);
    for (const slug of candidates) {
      // Short-circuit: if we hit once on any ATS for this company, don't
      // keep probing other ATSes with the same or other candidates.
      let hit = false;
      for (const ats of PROBE_ORDER) {
        if (summary.probes_issued >= maxProbes) break outer;
        if (known[ats].has(slug)) continue;
        if (failures.has(`${ats}:${slug}`)) continue;

        const status = await probe(ats, slug, deps);
        summary.probes_issued += 1;

        if (status === 200) {
          insertHits.push({ ats, slug, meta: null });
          summary.hits += 1;
          summary.hit_detail.push({ ats, slug, company });
          // Ensure we don't re-probe the same slug in this run.
          known[ats].add(slug);
          hit = true;
          break;
        } else if (status === 404) {
          insertFails.push({ ats, slug, status });
          failures.add(`${ats}:${slug}`);
        }
        // Other statuses (429, 500, 0/network): don't cache, try again next cron.
      }
      if (hit) break;
    }
  }

  // Batch writes after the probe loop so no extra subrequests mid-loop.
  if (insertHits.length > 0) {
    await db.batch(
      insertHits.map((h) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO ats_tenants
               (ats, slug, added_at, discovered_via, status)
             VALUES (?, ?, ?, 'auto', 'active')`,
          )
          .bind(h.ats, h.slug, nowIso),
      ),
    );
  }
  if (insertFails.length > 0) {
    await db.batch(
      insertFails.map((f) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO ats_probe_failures
               (ats, slug, last_probed_at, status_code)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(f.ats, f.slug, nowIso, f.status),
      ),
    );
  }

  return summary;
}
