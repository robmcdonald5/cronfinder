import "./env";

import type { Job } from "./normalize";
import type { Deps, Logger } from "./util/deps";
import { consoleLogger } from "./util/deps";
import { defaultClock } from "./util/now";
import { PerKeyThrottle } from "./util/rate-limit";
import { upsertJobs, writeRunLog } from "./db";

import { GREENHOUSE_TOKENS } from "./config/targets-greenhouse";
import { LEVER_COMPANIES } from "./config/targets-lever";
import { ASHBY_ORGS } from "./config/targets-ashby";
import { WORKDAY_TARGETS } from "./config/targets-workday";
import { EIGHTFOLD_TARGETS } from "./config/targets-eightfold";
import { fetchGreenhouse } from "./adapters/greenhouse";
import { fetchLever } from "./adapters/lever";
import { fetchAshby } from "./adapters/ashby";
import { fetchUsaJobs } from "./adapters/usajobs";
import { fetchWorkday } from "./adapters/workday";
import { fetchEightfold } from "./adapters/eightfold";
import { fetchHimalayas } from "./adapters/himalayas";
import { fetchHn } from "./adapters/hn";
import { buildDigest, storeDigest } from "./digest";

interface TaskSpec {
  source: string;                         // e.g. "greenhouse:stripe"
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
  cron: "fast" | "slow",
  nowIso: string,
  logger: Logger,
): Promise<TaskOutcome> {
  const start = Date.now();
  const deps: Deps = { fetch: globalThis.fetch.bind(globalThis), clock: defaultClock, logger };
  const collected: Job[] = [];
  let error: string | undefined;
  try {
    for await (const job of spec.factory(deps)) {
      collected.push(job);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let inserted = 0;
  let updated = 0;
  if (collected.length > 0 && !error) {
    try {
      const r = await upsertJobs(env.DB, collected, nowIso);
      inserted = r.inserted;
      updated = r.updated;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const outcome: TaskOutcome = {
    source: spec.source,
    durationMs: Date.now() - start,
    jobsFetched: collected.length,
    jobsNew: inserted,
    jobsUpdated: updated,
    ...(error !== undefined ? { error } : {}),
  };

  try {
    await writeRunLog(env.DB, {
      runAtIso: nowIso,
      cron,
      source: outcome.source,
      durationMs: outcome.durationMs,
      jobsFetched: outcome.jobsFetched,
      jobsNew: outcome.jobsNew,
      jobsUpdated: outcome.jobsUpdated,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
  } catch {
    // run_log write failing shouldn't swallow the adapter outcome log.
  }

  logger.log({ t: "adapter_run", cron, ...outcome });
  return outcome;
}

function buildFastTasks(env: Env): TaskSpec[] {
  const tasks: TaskSpec[] = [];

  for (const token of GREENHOUSE_TOKENS) {
    tasks.push({
      source: `greenhouse:${token}`,
      factory: (deps) => fetchGreenhouse(token, deps),
    });
  }
  for (const company of LEVER_COMPANIES) {
    tasks.push({
      source: `lever:${company}`,
      factory: (deps) => fetchLever(company, deps),
    });
  }
  for (const org of ASHBY_ORGS) {
    tasks.push({
      source: `ashby:${org}`,
      factory: (deps) => fetchAshby(org, deps),
    });
  }

  if (env.USAJOBS_API_KEY && env.USAJOBS_USER_AGENT) {
    const apiKey = env.USAJOBS_API_KEY;
    const userAgent = env.USAJOBS_USER_AGENT;
    tasks.push({
      source: "usajobs",
      factory: (deps) => fetchUsaJobs({ apiKey, userAgent }, deps),
    });
  }

  tasks.push({
    source: "himalayas",
    factory: (deps) => fetchHimalayas({}, deps),
  });

  tasks.push({
    source: "hn",
    factory: (deps) => fetchHn({}, deps),
  });

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
    tasks.map((spec) => runAdapterTask(spec, env, "fast", scheduledAt, logger)),
  );

  let fetched = 0, inserted = 0, updated = 0, failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      fetched += r.value.jobsFetched;
      inserted += r.value.jobsNew;
      updated += r.value.jobsUpdated;
      if (r.value.error) failed++;
    } else {
      failed++;
    }
  }

  logger.log({
    t: "cron_done",
    cron: "fast",
    scheduledAt,
    duration_ms: Date.now() - started,
    task_count: tasks.length,
    failed_count: failed,
    jobs_fetched: fetched,
    jobs_new: inserted,
    jobs_updated: updated,
  });
}

function buildSlowTasks(): TaskSpec[] {
  const tasks: TaskSpec[] = [];

  // 1 req/sec per Workday tenant (keyed by tenant), unthrottled across tenants.
  const workdayThrottle = new PerKeyThrottle(1000);
  for (const target of WORKDAY_TARGETS) {
    tasks.push({
      source: `workday:${target.slug}`,
      factory: (deps) => fetchWorkday({ target, throttle: workdayThrottle }, deps),
    });
  }

  for (const target of EIGHTFOLD_TARGETS) {
    tasks.push({
      source: `eightfold:${target.slug}`,
      factory: (deps) => fetchEightfold({ target }, deps),
    });
  }

  return tasks;
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
    tasks.map((spec) => runAdapterTask(spec, env, "slow", scheduledAt, logger)),
  );

  let fetched = 0, inserted = 0, updated = 0, failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      fetched += r.value.jobsFetched;
      inserted += r.value.jobsNew;
      updated += r.value.jobsUpdated;
      if (r.value.error) failed++;
    } else {
      failed++;
    }
  }

  await env.CACHE.put("last_run:slow", scheduledAt);

  // Build + persist the daily digest. Errors here shouldn't hide the cron
  // summary, so isolate them.
  try {
    const digest = await buildDigest(env.DB, scheduledAt);
    await storeDigest(env.DB, digest, scheduledAt);
    logger.log({
      t: "digest_stored",
      date: digest.date,
      jobs_count: digest.jobsCount,
      total_before_filter: digest.totalBeforeFilter,
      body_bytes: digest.body.length,
    });
  } catch (err) {
    logger.log({
      t: "digest_error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.log({
    t: "cron_done",
    cron: "slow",
    scheduledAt,
    duration_ms: Date.now() - started,
    task_count: tasks.length,
    failed_count: failed,
    jobs_fetched: fetched,
    jobs_new: inserted,
    jobs_updated: updated,
  });
}
