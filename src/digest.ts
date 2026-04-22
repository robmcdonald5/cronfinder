// Build a daily Markdown digest of new jobs and persist it into the `digests`
// table. Local `npm run pull-digests` later syncs it to ./digests/.
//
// Filtering lives in src/config/filters.ts and is applied in-memory here.
// D1 keeps every job — edit filters.ts and re-trigger the slow cron to
// re-filter without refetching.

import type { Job } from "./normalize";
import type { Clearance, EmploymentType } from "./normalize";
import { shouldAccept } from "./config/filters";

interface JobRow {
  source: string;
  company: string;
  title: string;
  location: string | null;
  remote: number | null;
  clearance: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  apply_url: string;
  first_seen_at: string;
  employment_type: string | null;
  description_text: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    source: row.source,
    external_id: "",
    company: row.company,
    title: row.title,
    location: row.location,
    remote: row.remote === null ? null : row.remote === 1,
    employment_type: (row.employment_type ?? null) as EmploymentType,
    department: null,
    description_html: null,
    description_text: row.description_text,
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_currency: row.salary_currency,
    clearance: (row.clearance ?? null) as Clearance,
    apply_url: row.apply_url,
    posted_at: null,
  };
}

interface Digest {
  date: string;              // 'YYYY-MM-DD'
  body: string;              // Markdown
  jobsCount: number;         // count after filtering (what's in the digest)
  totalBeforeFilter: number; // count before filtering (new in window, any criteria)
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
              employment_type, description_text
         FROM jobs
        WHERE first_seen_at >= ? AND first_seen_at < ?
        ORDER BY source, company, title`,
    )
    .bind(windowStartIso, windowEndIso)
    .all<JobRow>();

  const totalBeforeFilter = results.length;
  const accepted = results.filter((row) => shouldAccept(rowToJob(row)).accept);

  const date = windowEndIso.slice(0, 10);
  const body = renderMarkdown(accepted, windowStartIso, windowEndIso, totalBeforeFilter);
  return {
    date,
    body,
    jobsCount: accepted.length,
    totalBeforeFilter,
    windowStartIso,
    windowEndIso,
  };
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

// ---------- Markdown rendering ----------

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

export function renderMarkdown(
  rows: JobRow[],
  windowStartIso: string,
  windowEndIso: string,
  totalBeforeFilter?: number,
): string {
  const date = windowEndIso.slice(0, 10);
  const lines: string[] = [];
  lines.push(`# New jobs — ${date}`);
  lines.push("");
  const total = totalBeforeFilter ?? rows.length;
  const suffix =
    total > rows.length
      ? ` (${rows.length} passed filters out of ${total} new).`
      : ".";
  lines.push(
    `**${rows.length} new postings** between ${windowStartIso} and ${windowEndIso}${suffix}`,
  );
  lines.push("");

  if (rows.length === 0) {
    lines.push("_No new postings matched the filter in this window._");
    return lines.join("\n") + "\n";
  }

  // Bucket by category -> company -> rows.
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
  if (j.salary_min || j.salary_max) bits.push(formatSalary(j));
  if (j.clearance) bits.push(j.clearance);
  const tail = bits.length > 0 ? ` — ${bits.join(" · ")}` : "";
  return `${title}${tail}`;
}

function formatSalary(j: JobRow): string {
  const cur = j.salary_currency ?? "USD";
  const fmt = (n: number) =>
    n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  if (j.salary_min && j.salary_max) return `${fmt(j.salary_min)}–${fmt(j.salary_max)} ${cur}`;
  if (j.salary_min) return `from ${fmt(j.salary_min)} ${cur}`;
  if (j.salary_max) return `up to ${fmt(j.salary_max)} ${cur}`;
  return "";
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
