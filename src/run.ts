import "./env";

import type { Job } from "./normalize";
import type { Deps, Logger } from "./util/deps";
import { consoleLogger } from "./util/deps";
import { PerKeyThrottle } from "./util/rate-limit";
import type { RunLogEntry } from "./db";
import { upsertJobs, writeRunLogBatch } from "./db";

import { GREENHOUSE_TOKENS } from "./config/targets-greenhouse";
import { LEVER_COMPANIES } from "./config/targets-lever";
import { ASHBY_ORGS } from "./config/targets-ashby";
import { WORKDAY_TARGETS } from "./config/targets-workday";
import { fetchGreenhouse } from "./adapters/greenhouse";
import { fetchLever } from "./adapters/lever";
import { fetchAshby } from "./adapters/ashby";
import { fetchUsaJobs } from "./adapters/usajobs";
import { fetchWorkday } from "./adapters/workday";
import { fetchHimalayas } from "./adapters/himalayas";
import { fetchHn } from "./adapters/hn";
import { fetchAdzuna } from "./adapters/adzuna";
import { buildDigest, storeDigest } from "./digest";

// Flush upserts this often so the peak in-memory Job buffer stays bounded
// regardless of how many postings an adapter yields. 50 matches upsertJobs
// chunk size so a full buffer is exactly one db.batch subrequest.
const FLUSH_EVERY = 50;

interface TaskSpec {
  source: string;
  factory: (deps: Deps) => AsyncIterable<Job>;
}

interface TaskOutcome {
  source: string;
  durationMs: number;
  jobsFetched: number;
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
      buffer.push(job);
      if (buffer.length >= FLUSH_EVERY) await flush();
    }
    await flush();
  } catch (err) {
    // Drop the partial buffer on purpose — the next cron will re-fetch.
    error = err instanceof Error ? err.message : String(err);
  }

  const outcome: TaskOutcome = {
    source: spec.source,
    durationMs: Date.now() - start,
    jobsFetched: fetched,
    jobsNew: inserted,
    jobsUpdated: updated,
    ...(error !== undefined ? { error } : {}),
  };
  logger.log({ t: "adapter_run", ...outcome });
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

function buildFastTasks(env: Env): TaskSpec[] {
  const tasks: TaskSpec[] = [];

  for (const token of GREENHOUSE_TOKENS) {
    tasks.push({ source: `greenhouse:${token}`, factory: (d) => fetchGreenhouse(token, d) });
  }
  for (const company of LEVER_COMPANIES) {
    tasks.push({ source: `lever:${company}`, factory: (d) => fetchLever(company, d) });
  }
  for (const org of ASHBY_ORGS) {
    tasks.push({ source: `ashby:${org}`, factory: (d) => fetchAshby(org, d) });
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

  return tasks;
}

function buildSlowTasks(): TaskSpec[] {
  const tasks: TaskSpec[] = [];

  // 1 req/sec per Workday tenant (keyed by tenant), unthrottled across tenants.
  const workdayThrottle = new PerKeyThrottle(1000);
  for (const target of WORKDAY_TARGETS) {
    tasks.push({
      source: `workday:${target.slug}`,
      factory: (d) => fetchWorkday({ target, throttle: workdayThrottle }, d),
    });
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
  const tasks = buildFastTasks(env);

  logger.log({ t: "cron_start", cron: "fast", scheduledAt, task_count: tasks.length });

  const results = await Promise.allSettled(
    tasks.map((spec) => runAdapterTask(spec, env, logger, scheduledAt)),
  );

  try {
    await writeRunLogBatch(env.DB, toRunLogEntries(fulfilledOutcomes(results), "fast", scheduledAt));
  } catch (err) {
    logger.log({ t: "run_log_error", error: err instanceof Error ? err.message : String(err) });
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
  const tasks = buildSlowTasks();

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
