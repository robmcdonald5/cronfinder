import type { Job } from "./normalize";
import { jobId } from "./util/hash";

export interface UpsertResult {
  id: string;
  inserted: boolean;     // true -> first time we've seen this job
}

const UPSERT_JOB_SQL = `
INSERT INTO jobs (
  id, source, external_id, company, title, location, remote, employment_type,
  department, description_html, description_text, salary_min, salary_max,
  salary_currency, clearance, apply_url, posted_at, first_seen_at, last_seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source, external_id) DO UPDATE SET
  company          = excluded.company,
  title            = excluded.title,
  location         = excluded.location,
  remote           = excluded.remote,
  employment_type  = excluded.employment_type,
  department       = excluded.department,
  description_html = excluded.description_html,
  description_text = excluded.description_text,
  salary_min       = excluded.salary_min,
  salary_max       = excluded.salary_max,
  salary_currency  = excluded.salary_currency,
  clearance        = excluded.clearance,
  apply_url        = excluded.apply_url,
  posted_at        = excluded.posted_at,
  last_seen_at     = excluded.last_seen_at
RETURNING id, (first_seen_at = last_seen_at) AS was_inserted
`;

async function buildUpsertStatement(
  db: D1Database,
  job: Job,
  nowIso: string,
): Promise<D1PreparedStatement> {
  const id = await jobId(job.source, job.external_id);
  return db
    .prepare(UPSERT_JOB_SQL)
    .bind(
      id,
      job.source,
      job.external_id,
      job.company,
      job.title,
      job.location,
      boolToInt(job.remote),
      job.employment_type,
      job.department,
      job.description_html,
      job.description_text,
      job.salary_min,
      job.salary_max,
      job.salary_currency,
      job.clearance,
      job.apply_url,
      job.posted_at,
      nowIso,
      nowIso,
    );
}

export async function upsertJob(
  db: D1Database,
  job: Job,
  nowIso: string,
): Promise<UpsertResult> {
  const stmt = await buildUpsertStatement(db, job, nowIso);
  const row = await stmt.first<{ id: string; was_inserted: number }>();
  if (!row) throw new Error(`upsertJob returned no row for ${job.source}:${job.external_id}`);
  return { id: row.id, inserted: row.was_inserted === 1 };
}

// One db.batch(...) call counts as a single subrequest regardless of how many
// prepared statements it contains — critical for staying under the
// 1,000-subrequest-per-invocation limit when an adapter yields thousands of rows.
export async function upsertJobs(
  db: D1Database,
  jobs: readonly Job[],
  nowIso: string,
  chunkSize = 50,
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < jobs.length; i += chunkSize) {
    const chunk = jobs.slice(i, i + chunkSize);
    const stmts = await Promise.all(
      chunk.map((job) => buildUpsertStatement(db, job, nowIso)),
    );
    const results = await db.batch<{ id: string; was_inserted: number }>(stmts);
    for (const r of results) {
      const row = r.results?.[0];
      if (!row) continue;
      if (row.was_inserted === 1) inserted++;
      else updated++;
    }
  }
  return { inserted, updated };
}

function boolToInt(value: boolean | null): 0 | 1 | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

export interface RunLogEntry {
  runAtIso: string;
  cron: "fast" | "slow";
  source: string;
  durationMs: number;
  jobsFetched?: number;
  jobsNew?: number;
  jobsUpdated?: number;
  error?: string;
}

export async function writeRunLog(
  db: D1Database,
  entry: RunLogEntry,
): Promise<void> {
  await buildRunLogStatement(db, entry).run();
}

export async function writeRunLogBatch(
  db: D1Database,
  entries: readonly RunLogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.batch(entries.map((e) => buildRunLogStatement(db, e)));
}

function buildRunLogStatement(db: D1Database, entry: RunLogEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO run_log (run_at, cron, source, duration_ms, jobs_fetched, jobs_new, jobs_updated, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.runAtIso,
      entry.cron,
      entry.source,
      entry.durationMs,
      entry.jobsFetched ?? null,
      entry.jobsNew ?? null,
      entry.jobsUpdated ?? null,
      entry.error ?? null,
    );
}
