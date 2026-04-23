// Query/update helpers for the ats_tenants table. Owns the small amount of
// SQL + status-transition logic the cron handlers need; nothing else should
// issue raw queries against ats_tenants.

export type AtsKind = "greenhouse" | "lever" | "ashby" | "workday" | "eightfold";
export type AtsStatus = "active" | "dead";

export interface AtsTenant {
  ats: AtsKind;
  slug: string;
  meta: Record<string, unknown> | null;
  status: AtsStatus;
  last_fetched_at: string | null;
  consecutive_failures: number;
  jobs_last_seen: number | null;
}

export interface SeedEntry {
  slug: string;
  meta?: Record<string, unknown> | null;
}

export interface RunOutcome {
  jobsFetched: number;
  errored: boolean;
}

// Consecutive failures that mark a tenant as dead (stops polling). One-off
// 5xx blips shouldn't retire a tenant, but repeated 404s should.
const DEAD_THRESHOLD = 5;

// D1 caps a single batch at 1,000 prepared statements. Chunk well below that.
const SEED_CHUNK = 500;

// Insert seed rows that don't yet exist. INSERT OR IGNORE keeps health data
// untouched for rows already in the table, so running this on every cron is
// safe and idempotent. Chunked to respect D1's per-batch statement limit.
export async function ensureSeeds(
  db: D1Database,
  ats: AtsKind,
  entries: readonly SeedEntry[],
  nowIso: string,
): Promise<void> {
  if (entries.length === 0) return;
  for (let i = 0; i < entries.length; i += SEED_CHUNK) {
    const chunk = entries.slice(i, i + SEED_CHUNK);
    const stmts = chunk.map((e) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO ats_tenants
             (ats, slug, meta, added_at, discovered_via, status)
           VALUES (?, ?, ?, ?, 'seed', 'active')`,
        )
        .bind(ats, e.slug, e.meta ? JSON.stringify(e.meta) : null, nowIso),
    );
    await db.batch(stmts);
  }
}

// Pick the N oldest-fetched active tenants for `ats`. Never-fetched rows
// (NULL last_fetched_at) sort first so fresh seeds are prioritized.
export async function selectTenantsToFetch(
  db: D1Database,
  ats: AtsKind,
  limit: number,
): Promise<AtsTenant[]> {
  const res = await db
    .prepare(
      `SELECT ats, slug, meta, status, last_fetched_at,
              consecutive_failures, jobs_last_seen
       FROM ats_tenants
       WHERE ats = ? AND status = 'active'
       ORDER BY last_fetched_at ASC NULLS FIRST
       LIMIT ?`,
    )
    .bind(ats, limit)
    .all<{
      ats: string;
      slug: string;
      meta: string | null;
      status: string;
      last_fetched_at: string | null;
      consecutive_failures: number;
      jobs_last_seen: number | null;
    }>();
  return (res.results ?? []).map((r) => ({
    ats: r.ats as AtsKind,
    slug: r.slug,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
    status: r.status as AtsStatus,
    last_fetched_at: r.last_fetched_at,
    consecutive_failures: r.consecutive_failures,
    jobs_last_seen: r.jobs_last_seen,
  }));
}

export interface HealthUpdate {
  ats: AtsKind;
  slug: string;
  outcome: RunOutcome;
}

// Batched UPDATEs — the whole array counts as ONE D1 subrequest regardless
// of statement count. At ~375 ATS tenants per fast cron, this replaces
// 375 individual subrequests with one. Each statement computes next
// consecutive_failures and status inline via SQLite CASE so we never pay
// a SELECT subrequest first. The CASE arms mirror computeHealthUpdate
// below, which is the canonical spec and what tests exercise.
export async function updateTenantHealthBatch(
  db: D1Database,
  updates: readonly HealthUpdate[],
  nowIso: string,
): Promise<void> {
  if (updates.length === 0) return;
  const stmts = updates.map((u) => {
    const erroredFlag = u.outcome.errored ? 1 : 0;
    return db
      .prepare(
        `UPDATE ats_tenants
         SET last_fetched_at = ?,
             last_ok_at = CASE WHEN ? = 0 THEN ? ELSE last_ok_at END,
             consecutive_failures = CASE WHEN ? = 0 THEN 0
                                         ELSE consecutive_failures + 1 END,
             jobs_last_seen = ?,
             status = CASE
               WHEN ? = 0 THEN 'active'
               WHEN consecutive_failures + 1 >= ? THEN 'dead'
               ELSE 'active'
             END
         WHERE ats = ? AND slug = ?`,
      )
      .bind(
        nowIso,
        erroredFlag, nowIso,
        erroredFlag,
        u.outcome.jobsFetched,
        erroredFlag, DEAD_THRESHOLD,
        u.ats, u.slug,
      );
  });
  await db.batch(stmts);
}

// Pure function — canonical spec of the transition rules, mirrored by the
// CASE expressions in updateTenantHealth's SQL above. Kept as the test
// target so we don't need a real D1 to verify the transitions.
export function computeHealthUpdate(
  prev: { consecutive_failures: number },
  outcome: RunOutcome,
): { consecutive_failures: number; status: AtsStatus } {
  const failures = outcome.errored ? prev.consecutive_failures + 1 : 0;
  const status: AtsStatus = failures >= DEAD_THRESHOLD ? "dead" : "active";
  return { consecutive_failures: failures, status };
}
