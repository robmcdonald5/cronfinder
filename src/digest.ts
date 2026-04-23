// Build a daily Markdown digest of new jobs and persist it into the `digests`
// table. Local `npm run pull-digests` later syncs it to ./digests/.
//
// Filtering lives in src/config/filters.ts and is applied in-memory here.
// D1 keeps every job — edit filters.ts and re-trigger the slow cron to
// re-filter without refetching.

import { shouldAccept } from "./config/filters";
import type { Clearance } from "./normalize";
import { dedupKey } from "./dedup";

interface JobRow {
  source: string;
  company: string;
  title: string;
  location: string | null;
  remote: 0 | 1 | null;
  clearance: Clearance;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  apply_url: string;
  first_seen_at: string;
  description_text: string | null;
}

interface Digest {
  date: string;              // 'YYYY-MM-DD'
  body: string;              // Markdown
  jobsCount: number;         // count after dedup (what's in the digest)
  totalBeforeFilter: number; // count before filtering (new in window, any criteria)
  duplicatesCollapsed: number; // same role on multiple sources, folded
  windowStartIso: string;
  windowEndIso: string;
}

export async function buildDigest(
  db: D1Database,
  windowEndIso: string,
  windowHours = 24,
): Promise<Digest> {
  const windowEnd = new Date(windowEndIso);
  const windowStart = new Date(windowEnd.getTime() - windowHours * 3600 * 1000);
  const windowStartIso = windowStart.toISOString();

  const { results } = await db
    .prepare(
      `SELECT source, company, title, location, remote, clearance,
              salary_min, salary_max, salary_currency, apply_url, first_seen_at,
              description_text
         FROM jobs
        WHERE first_seen_at >= ? AND first_seen_at < ?
        ORDER BY source, company, title`,
    )
    .bind(windowStartIso, windowEndIso)
    .all<JobRow>();

  const totalBeforeFilter = results.length;
  const accepted = results.filter((row) => shouldAccept(row).accept);
  const deduped = dedupeRows(accepted);
  const duplicatesCollapsed = accepted.length - deduped.length;

  const date = windowEndIso.slice(0, 10);
  const body = renderMarkdown(deduped, windowStartIso, windowEndIso, {
    totalBeforeFilter,
    duplicatesCollapsed,
  });
  return {
    date,
    body,
    jobsCount: deduped.length,
    totalBeforeFilter,
    duplicatesCollapsed,
    windowStartIso,
    windowEndIso,
  };
}

// --- dedup ---------------------------------------------------------------

// Lower number wins when two rows share a dedup key. Direct ATS links are
// preferred over aggregators so the digest points at first-party apply URLs.
// Aggregators with heavy tracker redirects score worst; those that surface
// mostly-direct links (Himalayas, sometimes RemoteOK) score in between.
function sourcePriority(source: string): number {
  if (source === "adzuna" || source === "themuse" || source === "jobicy") return 10;
  if (source === "remoteok") return 9;
  if (source.startsWith("hn")) return 9;
  if (source === "himalayas") return 8;
  // Direct ATS (greenhouse:*, lever:*, ashby:*, workday:*, eightfold:*) and
  // usajobs all keep priority 0 — their apply URLs are first-party.
  return 0;
}

export function dedupeRows(rows: readonly JobRow[]): JobRow[] {
  const byKey = new Map<string, JobRow>();
  for (const row of rows) {
    const k = dedupKey(row.company, row.title, row.location);
    const existing = byKey.get(k);
    if (!existing || sourcePriority(row.source) < sourcePriority(existing.source)) {
      byKey.set(k, row);
    }
  }
  return [...byKey.values()];
}

export async function storeDigest(
  db: D1Database,
  digest: Digest,
  generatedAtIso: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO digests (id, generated_at, window_start_iso, window_end_iso, jobs_count, body)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         generated_at     = excluded.generated_at,
         window_start_iso = excluded.window_start_iso,
         window_end_iso   = excluded.window_end_iso,
         jobs_count       = excluded.jobs_count,
         body             = excluded.body`,
    )
    .bind(
      digest.date,
      generatedAtIso,
      digest.windowStartIso,
      digest.windowEndIso,
      digest.jobsCount,
      digest.body,
    )
    .run();
}

type Category =
  | "Defense / Government Contractors"
  | "Federal"
  | "Big Tech + Commercial"
  | "Other";

function categoryOf(source: string): Category {
  if (source === "usajobs") return "Federal";
  if (source.startsWith("workday:") || source.startsWith("eightfold:")) {
    return "Defense / Government Contractors";
  }
  if (
    source.startsWith("greenhouse:") ||
    source.startsWith("lever:") ||
    source.startsWith("ashby:")
  ) {
    return "Big Tech + Commercial";
  }
  return "Other";
}

const CATEGORY_ORDER: Category[] = [
  "Defense / Government Contractors",
  "Federal",
  "Big Tech + Commercial",
  "Other",
];

export interface RenderOptions {
  totalBeforeFilter?: number;
  duplicatesCollapsed?: number;
}

export function renderMarkdown(
  rows: JobRow[],
  windowStartIso: string,
  windowEndIso: string,
  opts: RenderOptions = {},
): string {
  const date = windowEndIso.slice(0, 10);
  const lines: string[] = [];
  lines.push(`# New jobs — ${date}`);
  lines.push("");
  const total = opts.totalBeforeFilter ?? rows.length;
  const dupNote = opts.duplicatesCollapsed && opts.duplicatesCollapsed > 0
    ? `, ${opts.duplicatesCollapsed} cross-source duplicates collapsed`
    : "";
  const suffix =
    total > rows.length || opts.duplicatesCollapsed
      ? ` (${rows.length} unique out of ${total} new${dupNote}).`
      : ".";
  lines.push(
    `**${rows.length} new postings** between ${windowStartIso} and ${windowEndIso}${suffix}`,
  );
  lines.push("");

  if (rows.length === 0) {
    lines.push("_No new postings matched the filter in this window._");
    return lines.join("\n") + "\n";
  }

  const byCategory = new Map<Category, Map<string, JobRow[]>>();
  for (const row of rows) {
    const cat = categoryOf(row.source);
    let byCompany = byCategory.get(cat);
    if (!byCompany) {
      byCompany = new Map();
      byCategory.set(cat, byCompany);
    }
    const list = byCompany.get(row.company) ?? [];
    list.push(row);
    byCompany.set(row.company, list);
  }

  for (const cat of CATEGORY_ORDER) {
    const byCompany = byCategory.get(cat);
    if (!byCompany || byCompany.size === 0) continue;
    const catCount = [...byCompany.values()].reduce((n, list) => n + list.length, 0);
    lines.push(`## ${cat} (${catCount})`);
    lines.push("");

    const companies = [...byCompany.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [company, jobs] of companies) {
      lines.push(`### ${company} — ${jobs.length} new`);
      for (const j of jobs) {
        lines.push(`- ${renderJobLine(j)}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderJobLine(j: JobRow): string {
  const title = `[${escapeMd(j.title)}](${j.apply_url})`;
  const bits: string[] = [];
  if (j.location) bits.push(escapeMd(j.location));
  if (j.remote === 1) bits.push("remote");
  if (j.salary_min != null || j.salary_max != null) bits.push(formatSalary(j));
  if (j.clearance) bits.push(j.clearance);
  const tail = bits.length > 0 ? ` — ${bits.join(" · ")}` : "";
  return `${title}${tail}`;
}

function formatSalary(j: JobRow): string {
  const cur = j.salary_currency ?? "USD";
  const fmt = (n: number) =>
    n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  if (j.salary_min != null && j.salary_max != null) {
    return `${fmt(j.salary_min)}–${fmt(j.salary_max)} ${cur}`;
  }
  if (j.salary_min != null) return `from ${fmt(j.salary_min)} ${cur}`;
  if (j.salary_max != null) return `up to ${fmt(j.salary_max)} ${cur}`;
  return "";
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
