# Sources & Tools

Inventory of every external API, infrastructure service, and build dependency cronfinder touches. Keep this current — see `CLAUDE.md` for when to update.

## Data sources

| Source | Endpoint | Auth | Status | Notes |
|---|---|---|---|---|
| **USAJobs** | `GET https://data.usajobs.gov/api/Search` | 3 headers: `Host: data.usajobs.gov`, `User-Agent: <registered email>`, `Authorization-Key: <OPM key>` | Working when `USAJOBS_API_KEY` + `USAJOBS_USER_AGENT` secrets are set | Federal postings. `Fields=Full`, `ResultsPerPage=500`, capped at 4 pages/run. [src/adapters/usajobs.ts](src/adapters/usajobs.ts) |
| **Greenhouse** | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | None | Working (17 targets) | Big Tech / Commercial. Some tokens stale (returns 404, adapter logs and continues). [src/adapters/greenhouse.ts](src/adapters/greenhouse.ts) · [src/config/targets-greenhouse.ts](src/config/targets-greenhouse.ts) |
| **Lever** | `GET https://api.lever.co/v0/postings/{company}?mode=json` | None | Working (4 targets) | Lever userbase has shrunk in 2026 — verified: `palantir`, `ro`, `netflix`, `attentive`. [src/adapters/lever.ts](src/adapters/lever.ts) · [src/config/targets-lever.ts](src/config/targets-lever.ts) |
| **Ashby** | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | None | Working (10 targets) | Big Tech / Commercial. `department`, `team`, `location` are strings in the response (not objects). [src/adapters/ashby.ts](src/adapters/ashby.ts) · [src/config/targets-ashby.ts](src/config/targets-ashby.ts) |
| **Workday `/wday/cxs`** | `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | None (realistic browser `User-Agent` required) | Working (8/9 tenants return data; ManTech list is empty upstream) | 9 defense primes: RTX, Leidos, Booz Allen, CACI, GDIT, ManTech, KBR, Parsons, Northrop. Two-pass: list POST + detail GET per posting. Throttled to 1 req/sec per tenant. Detects clearance (public_trust / secret / top_secret / ts_sci) from title + description. [src/adapters/workday.ts](src/adapters/workday.ts) · [src/config/targets-workday.ts](src/config/targets-workday.ts) |
| **Eightfold v2 — NGC** | `GET https://jobs.northropgrumman.com/api/apply/v2/jobs?domain=ngc.com` | None | **FAILING — HTTP 403** | Bot-blocked. Left in config so `run_log` captures it; remove or fix when alternative headers are tried. [src/adapters/eightfold.ts](src/adapters/eightfold.ts) · [src/config/targets-eightfold.ts](src/config/targets-eightfold.ts) |
| **Eightfold v2 — CACI** | `GET https://careers.caci.com/api/apply/v2/jobs?domain=caci.com` | None | **FAILING — HTTP 404** | Endpoint retired. CACI also reachable via Workday (`caci.wd1`), which is already in the Workday target list. |
| **Himalayas** | `GET https://himalayas.app/jobs/api/search?limit=100&offset=N` | None | Working | Remote-only board. 3 pages/run. Live runs return ~12 jobs per batch despite ~100k in their total count; stop early when `jobs.length < perPage`. [src/adapters/himalayas.ts](src/adapters/himalayas.ts) |
| **HN Algolia — search** | `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring` | None | Working | Finds the latest "Ask HN: Who is hiring?" thread (excluding "Who wants to be hired?"). [src/adapters/hn.ts](src/adapters/hn.ts) |
| **HN Algolia — items** | `GET https://hn.algolia.com/api/v1/items/{story_id}` | None | Working | Returns the thread as a tree. We parse top-level children only (skip nested replies). Capped at 150 comments/run. Parsing quality is best-effort — well-formatted pipe-delimited posts parse cleanly, role-first posts put the role into `company`. Full text always preserved in `description_text`. |

## Cloudflare infrastructure

| Service | Purpose | Binding / Name | Notes |
|---|---|---|---|
| **Workers** | Runtime for the two cron handlers. | — | `workers_dev: false`, `preview_urls: false`. Only the scheduled handler is exported today (no public HTTP surface). |
| **D1** | SQLite at the edge. Holds `jobs`, `dedup_keys`, `run_log`, `raw_responses`, `digests` tables. | `env.DB` → database `cronfinder` | Real id lives only in the gitignored `wrangler.jsonc`; template is in `wrangler.example.jsonc`. |
| **KV** | Cross-invocation cache (ATS tokens, last-run timestamps). | `env.CACHE` | Same gitignored-id pattern. |
| **Cron Triggers** | Scheduler. | Fast `17 */4 * * *` + Slow `23 7 * * *` (UTC) | Offsets from the top of the hour to avoid CF load spikes. |
| **Workers Logs** | Per-request + `console.log` retention for debugging. | Enabled via `[observability] enabled = true` | 7 days on Paid plan. Structured JSON log lines (`{t: "adapter_run", ...}`) are dashboard-searchable. |

## Secrets (`wrangler secret put <NAME>`)

| Name | Purpose | Required? |
|---|---|---|
| `USAJOBS_API_KEY` | OPM key from developer.usajobs.gov | Required for the USAJobs adapter; if unset, the adapter is skipped |
| `USAJOBS_USER_AGENT` | Exact email registered with OPM; must be sent as the `User-Agent` header | Same as above |
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
