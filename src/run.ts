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
import { fetchWorkday, WorkdayTargetSchema, type WorkdayTarget } from "./adapters/workday";
import { fetchEightfold, EightfoldTargetSchema, type EightfoldTarget } from "./adapters/eightfold";
import { fetchHimalayas } from "./adapters/himalayas";
import { fetchHn } from "./adapters/hn";
import { fetchAdzuna } from "./adapters/adzuna";
import { fetchRemoteOk } from "./adapters/remoteok";
import { fetchMuse } from "./adapters/themuse";
import { fetchJobicy } from "./adapters/jobicy";
import { buildDigest, storeDigest } from "./digest";
import { passesTitlePrefilter } from "./config/filters";
import { runDiscovery } from "./discovery";
import { sha256Hex } from "./util/hash";

import {
  ensureSeeds,
  selectTenantsToFetch,
  updateTenantHealthBatch,
  type AtsKind,
  type HealthUpdate,
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

// Stable fingerprint of a seed list — order-independent, includes meta. We
// gate the expensive ensureSeeds D1 writes behind a KV-cached hash so we
// only re-insert when the bundled seed actually changed.
async function seedFingerprint(entries: readonly SeedEntry[]): Promise<string> {
  const lines = entries
    .map((e) => (e.meta ? `${e.slug}|${JSON.stringify(e.meta)}` : e.slug))
    .sort();
  return sha256Hex(lines.join("\n"));
}

// Seed ats_tenants only when the bundled seed list has actually changed
// since the last cron. Hash lives in KV at `ats_seed_hash:<ats>`. The
// previous implementation hit D1 with ~34 batches every cron regardless —
// under the new bulk-seeded scale (~15k slugs) that was the single biggest
// line item in the fast-cron subrequest budget.
async function seedAll(env: Env, nowIso: string): Promise<void> {
  const seeds: Array<{ ats: AtsKind; entries: SeedEntry[] }> = [
    { ats: "greenhouse", entries: (greenhouseSeed as readonly string[]).map((s) => ({ slug: s })) },
    { ats: "lever",      entries: (leverSeed as readonly string[]).map((s) => ({ slug: s })) },
    { ats: "ashby",      entries: (ashbySeed as readonly string[]).map((s) => ({ slug: s })) },
    { ats: "workday",    entries: (workdaySeed as readonly WorkdayTarget[]).map((t) => ({ slug: t.slug, meta: { ...t } })) },
    { ats: "eightfold",  entries: (eightfoldSeed as readonly EightfoldTarget[]).map((t) => ({ slug: t.slug, meta: { ...t } })) },
  ];

  await Promise.all(
    seeds.map(async ({ ats, entries }) => {
      const fp = await seedFingerprint(entries);
      const key = `ats_seed_hash:${ats}`;
      const stored = await env.CACHE.get(key);
      if (stored === fp) return;
      await ensureSeeds(env.DB, ats, entries, nowIso);
      await env.CACHE.put(key, fp);
    }),
  );
}

function atsTaskSpec(
  ats: AtsKind,
  slug: string,
  factory: (deps: Deps) => AsyncIterable<Job>,
): TaskSpec {
  return { source: `${ats}:${slug}`, factory };
}

const ATS_PREFIXES: ReadonlyArray<readonly [string, AtsKind]> = [
  ["greenhouse:", "greenhouse"],
  ["lever:", "lever"],
  ["ashby:", "ashby"],
  ["workday:", "workday"],
  ["eightfold:", "eightfold"],
];

function parseAtsSource(source: string): { ats: AtsKind; slug: string } | null {
  for (const [prefix, ats] of ATS_PREFIXES) {
    if (source.startsWith(prefix)) return { ats, slug: source.slice(prefix.length) };
  }
  return null;
}

function toHealthUpdates(outcomes: readonly TaskOutcome[]): HealthUpdate[] {
  const out: HealthUpdate[] = [];
  for (const o of outcomes) {
    const parsed = parseAtsSource(o.source);
    if (!parsed) continue;
    out.push({
      ats: parsed.ats,
      slug: parsed.slug,
      outcome: { jobsFetched: o.jobsFetched, errored: o.error !== undefined },
    });
  }
  return out;
}

async function buildFastTasks(env: Env, nowIso: string): Promise<TaskSpec[]> {
  const tasks: TaskSpec[] = [];

  const [ghShard, leverShard, ashbyShard] = await Promise.all([
    selectTenantsToFetch(env.DB, "greenhouse", SHARD_LIMITS.fast.greenhouse),
    selectTenantsToFetch(env.DB, "lever", SHARD_LIMITS.fast.lever),
    selectTenantsToFetch(env.DB, "ashby", SHARD_LIMITS.fast.ashby),
  ]);

  for (const t of ghShard) {
    tasks.push(atsTaskSpec("greenhouse", t.slug, (d) => fetchGreenhouse(t.slug, d)));
  }
  for (const t of leverShard) {
    tasks.push(atsTaskSpec("lever", t.slug, (d) => fetchLever(t.slug, d)));
  }
  for (const t of ashbyShard) {
    tasks.push(atsTaskSpec("ashby", t.slug, (d) => fetchAshby(t.slug, d)));
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
    const parsed = WorkdayTargetSchema.safeParse(t.meta);
    if (!parsed.success) {
      consoleLogger.log({ t: "bad_meta", ats: "workday", slug: t.slug, error: parsed.error.message });
      continue;
    }
    const target = parsed.data;
    tasks.push(
      atsTaskSpec(
        "workday",
        t.slug,
        (d) => fetchWorkday({ target, throttle: workdayThrottle }, d),
      ),
    );
  }

  for (const t of eightfoldShard) {
    const parsed = EightfoldTargetSchema.safeParse(t.meta);
    if (!parsed.success) {
      consoleLogger.log({ t: "bad_meta", ats: "eightfold", slug: t.slug, error: parsed.error.message });
      continue;
    }
    const target = parsed.data;
    tasks.push(
      atsTaskSpec(
        "eightfold",
        t.slug,
        (d) => fetchEightfold({ target }, d),
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

  await seedAll(env, scheduledAt);
  const tasks = await buildFastTasks(env, scheduledAt);

  logger.log({ t: "cron_start", cron: "fast", scheduledAt, task_count: tasks.length });

  const results = await Promise.allSettled(
    tasks.map((spec) => runAdapterTask(spec, env, logger, scheduledAt)),
  );

  const fastOutcomes = fulfilledOutcomes(results);

  try {
    await writeRunLogBatch(env.DB, toRunLogEntries(fastOutcomes, "fast", scheduledAt));
  } catch (err) {
    logger.log({ t: "run_log_error", error: err instanceof Error ? err.message : String(err) });
  }

  try {
    await updateTenantHealthBatch(env.DB, toHealthUpdates(fastOutcomes), scheduledAt);
  } catch (err) {
    logger.log({ t: "health_batch_error", error: err instanceof Error ? err.message : String(err) });
  }

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

  await seedAll(env, scheduledAt);
  const tasks = await buildSlowTasks(env, scheduledAt);

  logger.log({ t: "cron_start", cron: "slow", scheduledAt, task_count: tasks.length });

  const results = await Promise.allSettled(
    tasks.map((spec) => runAdapterTask(spec, env, logger, scheduledAt)),
  );

  const slowOutcomes = fulfilledOutcomes(results);

  try {
    await writeRunLogBatch(env.DB, toRunLogEntries(slowOutcomes, "slow", scheduledAt));
  } catch (err) {
    logger.log({ t: "run_log_error", error: err instanceof Error ? err.message : String(err) });
  }

  try {
    await updateTenantHealthBatch(env.DB, toHealthUpdates(slowOutcomes), scheduledAt);
  } catch (err) {
    logger.log({ t: "health_batch_error", error: err instanceof Error ? err.message : String(err) });
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
