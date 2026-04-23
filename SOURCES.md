# Sources & Tools

Inventory of every external API, infrastructure service, and build dependency cronfinder touches. Keep this current — see `CLAUDE.md` for when to update.

## Data sources

| Source | Endpoint | Auth | Status | Notes |
|---|---|---|---|---|
| **USAJobs** | `GET https://data.usajobs.gov/api/Search` | 3 headers: `Host: data.usajobs.gov`, `User-Agent: <registered email>`, `Authorization-Key: <OPM key>` | Working when `USAJOBS_API_KEY` + `USAJOBS_USER_AGENT` secrets are set | Federal postings. `Fields=Full`, `ResultsPerPage=500`, capped at 4 pages/run. [src/adapters/usajobs.ts](src/adapters/usajobs.ts) |
| **Greenhouse** | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | None | Working | Big Tech / Commercial. Tenants are tracked in D1 `ats_tenants` (see Tenant registry below); seed list at [src/seeds/greenhouse-slugs.json](src/seeds/greenhouse-slugs.json). 100 tenants polled per fast cron (oldest-first). [src/adapters/greenhouse.ts](src/adapters/greenhouse.ts) |
| **Lever** | `GET https://api.lever.co/v0/postings/{company}?mode=json` | None | Working | Lever userbase has shrunk significantly in 2026. Seed list at [src/seeds/lever-slugs.json](src/seeds/lever-slugs.json). 50 tenants/fast cron. [src/adapters/lever.ts](src/adapters/lever.ts) |
| **Ashby** | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | None | Working | Big Tech / Commercial. Seed list at [src/seeds/ashby-slugs.json](src/seeds/ashby-slugs.json). 50 tenants/fast cron. `department`, `team`, `location` are strings (not objects). [src/adapters/ashby.ts](src/adapters/ashby.ts) |
| **Workday `/wday/cxs`** | `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | None (realistic browser `User-Agent` required) | Working (8/9 tenants return data; ManTech list is empty upstream) | 9 defense primes. Seed list at [src/seeds/workday-tenants.json](src/seeds/workday-tenants.json). 15 tenants/slow cron. Two-pass: list POST + detail GET per posting. Throttled to 1 req/sec per tenant. Detects clearance (public_trust / secret / top_secret / ts_sci) from title + description. [src/adapters/workday.ts](src/adapters/workday.ts) |
| **Eightfold v2** | `GET https://{host}/api/apply/v2/jobs?domain={domain}` | None (realistic browser `User-Agent` required) | Working | Currently seeded with Netflix (`explore.jobs.netflix.net`, domain=`netflix.com`, ~600 positions). Seed list at [src/seeds/eightfold-tenants.json](src/seeds/eightfold-tenants.json). 20 tenants/slow cron. [src/adapters/eightfold.ts](src/adapters/eightfold.ts) |
| **Himalayas** | `GET https://himalayas.app/jobs/api/search?limit=100&offset=N` | None | Working | Remote-only board. 3 pages/run. Live runs return ~12 jobs per batch despite ~100k in their total count; stop early when `jobs.length < perPage`. [src/adapters/himalayas.ts](src/adapters/himalayas.ts) |
| **HN Algolia — search** | `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring` | None | Working | Finds the latest "Ask HN: Who is hiring?" thread (excluding "Who wants to be hired?"). [src/adapters/hn.ts](src/adapters/hn.ts) |
| **HN Algolia — items** | `GET https://hn.algolia.com/api/v1/items/{story_id}` | None | Working | Returns the thread as a tree. We parse top-level children only (skip nested replies). Capped at 150 comments/run. Parsing quality is best-effort — well-formatted pipe-delimited posts parse cleanly, role-first posts put the role into `company`. Full text always preserved in `description_text`. |
| **Adzuna** | `GET https://api.adzuna.com/v1/api/jobs/us/search/{page}?app_id=…&app_key=…&what={keyword}&results_per_page=50` | Query-param credentials | Working when `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` secrets are set | Aggregates Indeed + other big boards under a B2B license. Multi-keyword fan-out: `software`, `developer`, `machine learning`, `devops`, `security` — dedup by external_id within a run. 3 pages/keyword × 50 per page × 5 keywords = ≤750 jobs/run, 15 subrequests/run. `salary_is_predicted` flag — predicted salaries are dropped. `redirect_url` is an Adzuna tracker link (digest dedup prefers direct-ATS rows when duplicates exist). Free tier: 1,000 calls/day (we use ~90). [src/adapters/adzuna.ts](src/adapters/adzuna.ts) |
| **RemoteOK** | `GET https://remoteok.com/api` | None (custom `User-Agent` required) | Working | Remote-only board. One call returns ~100 current postings in an array; index 0 is a ToS/legal wrapper and must be skipped. Attribution required — we carry the `remoteok` source tag through to digest rendering. No pagination, no rate limits documented; call once per fast cron (6 times/day). [src/adapters/remoteok.ts](src/adapters/remoteok.ts) |
| **TheMuse** | `GET https://www.themuse.com/api/public/jobs?category={cat}&location={loc}&page={n}` | None (optional `api_key` raises rate limit 500→3600/hr) | Working | US-heavy corporate/startup board. Category labels must match TheMuse's canonical strings exactly — `"Software Engineering"`, `"Data and Analytics"`, `"Product Management"` are the ones with real volume. Free tier: 500 req/hr. 3 categories × 5 pages × 20 jobs = ≤300 jobs/run, 15 subrequests/run. Dedupes cross-category hits by job id. [src/adapters/themuse.ts](src/adapters/themuse.ts) |
| **Jobicy** | `GET https://jobicy.com/api/v2/remote-jobs?geo=usa&count=50` | None | Working | Remote-only board, filtered server-side to US geo. Hard-capped at 50 results per call; no pagination. Rate limit: ≤1 req/hour (we call every 4 hours). `jobGeo` is the location string, always remote. [src/adapters/jobicy.ts](src/adapters/jobicy.ts) |

## Tenant registry (D1-backed)

The ATS-direct sources (Greenhouse, Lever, Ashby, Workday, Eightfold) no longer iterate over hardcoded company lists. Instead, every cron:

1. Upserts seed entries from `src/seeds/*.json` into `ats_tenants` (idempotent, preserves health data across deploys). Seeds come from the community-maintained `Feashliaa/job-board-aggregator` corpus plus any manual additions — Greenhouse ≈8k slugs, Lever ≈4.3k, Ashby ≈2.8k, Workday 9 curated defense primes, Eightfold currently just Netflix.
2. `SELECT`s the oldest-polled N tenants per ATS (`SHARD_LIMITS` in `src/run.ts`) ordered by `last_fetched_at ASC NULLS FIRST`. Fast cron shards: greenhouse 200, lever 100, ashby 75. Slow cron: workday 15, eightfold 20.
3. Runs the adapter for each; `runAdapterTask` applies `passesTitlePrefilter` before any upsert so the `jobs` table stays focused on SWE / AI-ML / security roles.
4. Writes `last_fetched_at`, `last_ok_at`, `jobs_last_seen` back, increments `consecutive_failures` on errors.
5. After 5 consecutive failures a tenant is marked `status='dead'` and stops being polled. `ats_probe_failures` acts as a 30-day negative cache for auto-discovery probes.

## Auto-discovery

After each fast cron's ingestion, `src/discovery.ts` harvests the top ~80 company names from recent aggregator output (Adzuna / RemoteOK / TheMuse / Jobicy / Himalayas / HN), derives up to 3 slug candidates per company (first-word / compact / hyphenated, with legal suffixes like `Inc`/`LLC` stripped), and probes Greenhouse → Lever → Ashby in that order. Budget: 30 probes per cron. 200 response → INSERT with `discovered_via='auto'`. 404 → 30-day negative cache entry in `ats_probe_failures`. Short-circuits once a hit is found per company so we don't waste probes on a slug that's clearly on Greenhouse against Lever/Ashby.

The helper module is `src/ats-registry.ts`; SQL lives in `migrations/0003_ats_registry.sql`. To add a company, add a slug to the appropriate seed JSON — the next cron picks it up. To remove, delete from the seed JSON AND `DELETE FROM ats_tenants WHERE ats=? AND slug=?` (seeds only INSERT, they don't prune).

## Cloudflare infrastructure

| Service | Purpose | Binding / Name | Notes |
|---|---|---|---|
| **Workers** | Runtime for the two cron handlers. | — | `workers_dev: false`, `preview_urls: false`. Only the scheduled handler is exported today (no public HTTP surface). |
| **D1** | SQLite at the edge. Holds `jobs`, `dedup_keys`, `run_log`, `raw_responses`, `digests` tables. | `env.DB` → database `cronfinder` | `database_id` is tracked in `wrangler.jsonc`; it's a resource identifier, not a credential. |
| **KV** | Cross-invocation cache (ATS tokens, last-run timestamps). | `env.CACHE` | Same as D1 — `id` tracked in `wrangler.jsonc`. |
| **Cron Triggers** | Scheduler. | Fast `17 */4 * * *` + Slow `23 7 * * *` (UTC) | Offsets from the top of the hour to avoid CF load spikes. |
| **Workers Logs** | Per-request + `console.log` retention for debugging. | Enabled via `[observability] enabled = true` | 7 days on Paid plan. Structured JSON log lines (`{t: "adapter_run", ...}`) are dashboard-searchable. |

## Secrets (`wrangler secret put <NAME>`)

| Name | Purpose | Required? |
|---|---|---|
| `USAJOBS_API_KEY` | OPM key from developer.usajobs.gov | Required for the USAJobs adapter; if unset, the adapter is skipped |
| `USAJOBS_USER_AGENT` | Exact email registered with OPM; must be sent as the `User-Agent` header | Same as above |
| `ADZUNA_APP_ID` | Application id from developer.adzuna.com | Required for the Adzuna adapter; if unset, the adapter is skipped |
| `ADZUNA_APP_KEY` | Application key from developer.adzuna.com | Same as above |
| `GITHUB_TOKEN` | Reserved for a GitHub-backed digest destination (not used in the current local-pull architecture) | Not currently required |
| `DIGEST_REPO` | Same | Not currently required |
| `DISCORD_WEBHOOK_URL` | Reserved for Phase 4b dead-source alerter | Not currently required |
| `API_TOKEN` | Reserved for a future read-only HTTP API | Not currently required |

## Build & test toolchain

| Tool | Purpose | Version (pinned via `^`) |
|---|---|---|
| [TypeScript](https://www.typescriptlang.org/) | Typecheck, `noEmit`, strict mode | `^5.7.0` |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) | Dev server, D1/KV CLI, deploy | `^4.84.1` |
| [Vitest](https://vitest.dev/) | Unit tests | `^4.1.0` |
| [@cloudflare/vitest-pool-workers](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers) | Vitest pool adapter (reserved — we currently use plain vitest for Phase 1–3 tests) | `^0.14.9` |
| [Zod](https://zod.dev/) | Runtime validation of API responses; invalid rows are logged + skipped, never thrown | `^4.3.6` |

## Runtime Web Platform APIs used

- `fetch` — every outbound HTTP call (always with an explicit `User-Agent`)
- `crypto.subtle.digest("SHA-256", ...)` — job id + raw_hash (see `src/util/hash.ts`)
- `CompressionStream("gzip")` / `DecompressionStream("gzip")` — compresses `raw_responses.body` to stay under D1's 2 MB per-row limit (see `src/util/gzip.ts`)

## Local scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local wrangler dev with local D1 + KV; test scheduled handlers at `http://localhost:8787/__scheduled?cron=...` |
| `npm run dev:remote` | Same, but against real (production) D1 + KV bindings |
| `npm run deploy` | `wrangler deploy` |
| `npm run tail` | Stream prod logs |
| `npm run types` | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run db:migrate:local` / `db:migrate:remote` | Apply D1 migrations |
| `npm run pull-digests` | Pull daily Markdown digests from remote D1 into `./digests/` (gitignored). Flags: `-- --local` to pull from local D1, `-- --overwrite` to overwrite local files. |
