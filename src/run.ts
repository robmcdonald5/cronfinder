import "./env";

import type { Job } from "./normalize";
import type { Deps, Logger } from "./util/deps";
import { consoleLogger } from "./util/deps";
import { PerKeyThrottle } from "./util/rate-limit";
import type { RunLogEntry } from "./db";
import { upsertJobs, writeRunLogBatch } from "./db";

import { fetchGreenhouse } from "./adapters/greenhouse";
import { fetchLever } from "./adapters/lever";
import { fetchAshby } from "./adapters/ashby";
import { fetchUsaJobs } from "./adapters/usajobs";
import { fetchWorkday, type WorkdayTarget } from "./adapters/workday";
import { fetchEightfold, type EightfoldTarget } from "./adapters/eightfold";
import { fetchHimalayas } from "./adapters/himalayas";
import { fetchHn } from "./adapters/hn";
import { fetchAdzuna } from "./adapters/adzuna";
import { fetchRemoteOk } from "./adapters/remoteok";
import { fetchMuse } from "./adapters/themuse";
import { fetchJobicy } from "./adapters/jobicy";
import { buildDigest, storeDigest } from "./digest";
import { passesTitlePrefilter } from "./config/filters";
import { runDiscovery } from "./discovery";

import {
  ensureSeeds,
  selectTenantsToFetch,
  updateTenantHealth,
  type AtsKind,
  type SeedEntry,
} from "./ats-registry";

import greenhouseSeed from "./seeds/greenhouse-slugs.json" with { type: "json" };
import leverSeed from "./seeds/lever-slugs.json" with { type: "json" };
import ashbySeed from "./seeds/ashby-slugs.json" with { type: "json" };
import workdaySeed from "./seeds/workday-tenants.json" with { type: "json" };
import eightfoldSeed from "./seeds/eightfold-tenants.json" with { type: "json" };

const FLUSH_EVERY = 50;

// Per-ATS shard size per cron. Sized so (shard × subrequests_per_tenant)
// stays comfortably below Workers' 1,000-subrequest-per-invocation ceiling
// after accounting for the zero-curation aggregator tasks.
const SHARD_LIMITS = {
  fast: {
    greenhouse: 200,  // ~200 list + post-prefilter upserts (≤~100 batches)
    lever: 100,
    ashby: 75,
  },
  slow: {
    workday: 15,      // ~21 subreq/tenant (1 list + ≤20 detail fan-out)
    eightfold: 20,    // ~4 subreq/tenant (≤4 pages)
  },
} as const;

interface TaskSpec {
  source: string;
  factory: (deps: Deps) => AsyncIterable<Job>;
  // Called after the task completes — used to update ats_tenants health.
  onComplete?: (outcome: TaskOutcome) => Promise<void>;
}

interface TaskOutcome {
  source: string;
  durationMs: number;
  jobsFetched: number;
  jobsFiltered: number;
  jobsNew: number;
  jobsUpdated: number;
  error?: string;
}

async function runAdapterTask(
  spec: TaskSpec,
  env: Env,
  logger: Logger,
  nowIso: string,
): Promise<TaskOutcome> {
  const start = Date.now();
  const deps: Deps = { fetch: globalThis.fetch.bind(globalThis), logger };
  let buffer: Job[] = [];
  let fetched = 0;
  let filtered = 0;
  let inserted = 0;
  let updated = 0;
  let error: string | undefined;

  const flush = async () => {
    if (buffer.length === 0) return;
    const r = await upsertJobs(env.DB, buffer, nowIso);
    inserted += r.inserted;
    updated += r.updated;
    buffer = [];
  };

  try {
    for await (const job of spec.factory(deps)) {
      fetched++;
      if (!passesTitlePrefilter(job.title)) {
        filtered++;
        continue;
      }
      buffer.push(job);
      if (buffer.length >= FLUSH_EVERY) await flush();
    }
    await flush();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const outcome: TaskOutcome = {
    source: spec.source,
    durationMs: Date.now() - start,
    jobsFetched: fetched,
    jobsFiltered: filtered,
    jobsNew: inserted,
    jobsUpdated: updated,
    ...(error !== undefined ? { error } : {}),
  };
  logger.log({ t: "adapter_run", ...outcome });

  if (spec.onComplete) {
    try {
      await spec.onComplete(outcome);
    } catch (cErr) {
      logger.log({
        t: "on_complete_error",
        source: spec.source,
        error: cErr instanceof Error ? cErr.message : String(cErr),
      });
    }
  }

  return outcome;
}

function toRunLogEntries(
  outcomes: readonly TaskOutcome[],
  cron: "fast" | "slow",
  nowIso: string,
): RunLogEntry[] {
  return outcomes.map((o) => ({
    runAtIso: nowIso,
    cron,
    source: o.source,
    durationMs: o.durationMs,
    jobsFetched: o.jobsFetched,
    jobsNew: o.jobsNew,
    jobsUpdated: o.jobsUpdated,
    ...(o.error !== undefined ? { error: o.error } : {}),
  }));
}

function summarize(
  outcomes: readonly PromiseSettledResult<TaskOutcome>[],
): { fetched: number; inserted: number; updated: number; failed: number } {
  let fetched = 0, inserted = 0, updated = 0, failed = 0;
  for (const r of outcomes) {
    if (r.status === "fulfilled") {
      fetched += r.value.jobsFetched;
      inserted += r.value.jobsNew;
      updated += r.value.jobsUpdated;
      if (r.value.error) failed++;
    } else {
      failed++;
    }
  }
  return { fetched, inserted, updated, failed };
}

function fulfilledOutcomes(
  results: readonly PromiseSettledResult<TaskOutcome>[],
): TaskOutcome[] {
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

// Seed ats_tenants once per cron so freshly-added JSON entries are picked up
// on the next run without a migration. Existing rows are untouched.
async function seedAll(db: D1Database, nowIso: string): Promise<void> {
  const workday: SeedEntry[] = (workdaySeed as readonly WorkdayTarget[]).map(
    (t) => ({ slug: t.slug, meta: { ...t } }),
  );
  const eightfold: SeedEntry[] = (eightfoldSeed as readonly EightfoldTarget[]).map(
    (t) => ({ slug: t.slug, meta: { ...t } }),
  );
  const gh: SeedEntry[] = (greenhouseSeed as readonly string[]).map((s) => ({ slug: s }));
  const lv: SeedEntry[] = (leverSeed as readonly string[]).map((s) => ({ slug: s }));
  const ab: SeedEntry[] = (ashbySeed as readonly string[]).map((s) => ({ slug: s }));

  await Promise.all([
    ensureSeeds(db, "greenhouse", gh, nowIso),
    ensureSeeds(db, "lever", lv, nowIso),
    ensureSeeds(db, "ashby", ab, nowIso),
    ensureSeeds(db, "workday", workday, nowIso),
    ensureSeeds(db, "eightfold", eightfold, nowIso),
  ]);
}

// Build a TaskSpec for a given tenant, wiring onComplete to update D1 health.
function atsTaskSpec(
  env: Env,
  ats: AtsKind,
  slug: string,
  factory: (deps: Deps) => AsyncIterable<Job>,
  nowIso: string,
): TaskSpec {
  return {
    source: `${ats}:${slug}`,
    factory,
    onComplete: (outcome) =>
      updateTenantHealth(
        env.DB,
        ats,
        slug,
        { jobsFetched: outcome.jobsFetched, errored: outcome.error !== undefined },
        nowIso,
      ),
  };
}

async function buildFastTasks(env: Env, nowIso: string): Promise<TaskSpec[]> {
  const tasks: TaskSpec[] = [];

  const [ghShard, leverShard, ashbyShard] = await Promise.all([
    selectTenantsToFetch(env.DB, "greenhouse", SHARD_LIMITS.fast.greenhouse),
    selectTenantsToFetch(env.DB, "lever", SHARD_LIMITS.fast.lever),
    selectTenantsToFetch(env.DB, "ashby", SHARD_LIMITS.fast.ashby),
  ]);

  for (const t of ghShard) {
    tasks.push(atsTaskSpec(env, "greenhouse", t.slug, (d) => fetchGreenhouse(t.slug, d), nowIso));
  }
  for (const t of leverShard) {
    tasks.push(atsTaskSpec(env, "lever", t.slug, (d) => fetchLever(t.slug, d), nowIso));
  }
  for (const t of ashbyShard) {
    tasks.push(atsTaskSpec(env, "ashby", t.slug, (d) => fetchAshby(t.slug, d), nowIso));
  }

  if (env.USAJOBS_API_KEY && env.USAJOBS_USER_AGENT) {
    const apiKey = env.USAJOBS_API_KEY;
    const userAgent = env.USAJOBS_USER_AGENT;
    tasks.push({ source: "usajobs", factory: (d) => fetchUsaJobs({ apiKey, userAgent }, d) });
  }

  if (env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) {
    const appId = env.ADZUNA_APP_ID;
    const appKey = env.ADZUNA_APP_KEY;
    tasks.push({ source: "adzuna", factory: (d) => fetchAdzuna({ appId, appKey }, d) });
  }

  tasks.push({ source: "himalayas", factory: (d) => fetchHimalayas({}, d) });
  tasks.push({ source: "hn", factory: (d) => fetchHn({}, d) });
  tasks.push({ source: "remoteok", factory: (d) => fetchRemoteOk({}, d) });
  tasks.push({ source: "themuse", factory: (d) => fetchMuse({}, d) });
  tasks.push({ source: "jobicy", factory: (d) => fetchJobicy({}, d) });

  return tasks;
}

async function buildSlowTasks(env: Env, nowIso: string): Promise<TaskSpec[]> {
  const tasks: TaskSpec[] = [];
  const workdayThrottle = new PerKeyThrottle(1000);

  const [workdayShard, eightfoldShard] = await Promise.all([
    selectTenantsToFetch(env.DB, "workday", SHARD_LIMITS.slow.workday),
    selectTenantsToFetch(env.DB, "eightfold", SHARD_LIMITS.slow.eightfold),
  ]);

  for (const t of workdayShard) {
    const target = t.meta as unknown as WorkdayTarget | null;
    if (!target) continue;
    tasks.push(
      atsTaskSpec(
        env,
        "workday",
        t.slug,
        (d) => fetchWorkday({ target, throttle: workdayThrottle }, d),
        nowIso,
      ),
    );
  }

  for (const t of eightfoldShard) {
    const target = t.meta as unknown as EightfoldTarget | null;
    if (!target) continue;
    tasks.push(
      atsTaskSpec(
        env,
        "eightfold",
        t.slug,
        (d) => fetchEightfold({ target }, d),
        nowIso,
      ),
    );
  }

  return tasks;
}

export async function runFast(
  env: Env,
  _ctx: ExecutionContext,
  scheduledAt: string,
): Promise<void> {
  const logger = consoleLogger;
  const started = Date.now();

  await seedAll(env.DB, scheduledAt);
  const tasks = await buildFastTasks(env, scheduledAt);

  logger.log({ t: "cron_start", cron: "fast", scheduledAt, task_count: tasks.length });

  const results = await Promise.allSettled(
    tasks.map((spec) => runAdapterTask(spec, env, logger, scheduledAt)),
  );

  try {
    await writeRunLogBatch(env.DB, toRunLogEntries(fulfilledOutcomes(results), "fast", scheduledAt));
  } catch (err) {
    logger.log({ t: "run_log_error", error: err instanceof Error ? err.message : String(err) });
  }

  // Auto-discovery: probe aggregator-surfaced company names against
  // Greenhouse / Lever / Ashby to grow the ats_tenants registry without
  // manual edits. Runs after ingestion so we have fresh company-name data.
  try {
    const discoveryDeps: Deps = { fetch: globalThis.fetch.bind(globalThis), logger };
    const summary = await runDiscovery(env.DB, discoveryDeps, scheduledAt);
    logger.log({ t: "auto_discovery", ...summary });
  } catch (err) {
    logger.log({
      t: "auto_discovery_error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sum = summarize(results);
  logger.log({
    t: "cron_done",
    cron: "fast",
    scheduledAt,
    duration_ms: Date.now() - started,
    task_count: tasks.length,
    failed_count: sum.failed,
    jobs_fetched: sum.fetched,
    jobs_new: sum.inserted,
    jobs_updated: sum.updated,
  });
}

export async function runSlow(
  env: Env,
  _ctx: ExecutionContext,
  scheduledAt: string,
): Promise<void> {
  const logger = consoleLogger;
  const started = Date.now();

  await seedAll(env.DB, scheduledAt);
  const tasks = await buildSlowTasks(env, scheduledAt);

  logger.log({ t: "cron_start", cron: "slow", scheduledAt, task_count: tasks.length });

  const results = await Promise.allSettled(
    tasks.map((spec) => runAdapterTask(spec, env, logger, scheduledAt)),
  );

  try {
    await writeRunLogBatch(env.DB, toRunLogEntries(fulfilledOutcomes(results), "slow", scheduledAt));
  } catch (err) {
    logger.log({ t: "run_log_error", error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const digest = await buildDigest(env.DB, scheduledAt);
    await storeDigest(env.DB, digest, scheduledAt);
    logger.log({
      t: "digest_stored",
      date: digest.date,
      jobs_count: digest.jobsCount,
      total_before_filter: digest.totalBeforeFilter,
      duplicates_collapsed: digest.duplicatesCollapsed,
      body_bytes: digest.body.length,
    });
  } catch (err) {
    logger.log({
      t: "digest_error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const sum = summarize(results);
  logger.log({
    t: "cron_done",
    cron: "slow",
    scheduledAt,
    duration_ms: Date.now() - started,
    task_count: tasks.length,
    failed_count: sum.failed,
    jobs_fetched: sum.fetched,
    jobs_new: sum.inserted,
    jobs_updated: sum.updated,
  });
}
