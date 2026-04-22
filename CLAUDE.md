# cronfinder — engineering conventions

Scheduled Cloudflare Worker that pulls job postings from public APIs into D1 (SQLite at the edge) and emits a daily Markdown digest.

## See also

- `PROJECT.md` — product spec of record (scope, goals, sources, phasing). Do not re-litigate decisions already made there.
- `SOURCES.md` — living inventory of every API, infra service, secret, and tool this project uses, with current status. **When you add a new data source, Cloudflare binding, npm dependency, or secret — or when an existing source changes status (starts working, starts failing, endpoint moves) — update `SOURCES.md` in the same commit.**
- `WRANGLER.md` — quick-reference for wrangler CLI commands (dev, deploy, D1, KV, secrets, logs) plus cronfinder-specific diagnostic SQL queries.
- `.claude/plans/review-c-users-mcdon-repos-cronfinder-pr-resilient-otter.md` (in user's `~/.claude/plans/`) — approved implementation plan.

## Public-repo posture

This repository is public. `wrangler.jsonc` is tracked directly with its real D1 `database_id` and KV `id` — those are resource identifiers, not credentials. Cloudflare's own example repos follow the same convention. Real secrets (USAJobs key, any future tokens) live on Cloudflare infra via `wrangler secret put` and never hit the tree.

Deploys run via Cloudflare's built-in GitHub integration: a push to `main` triggers `npx wrangler deploy` inside CF Workers Builds. There is no `.github/workflows/` directory.

## Commands

```bash
npm install                               # one-time
npm run types                             # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run typecheck                         # tsc --noEmit
npm test                                  # vitest run
npm run dev                               # wrangler dev --test-scheduled (local D1 + KV)
npm run dev:remote                        # wrangler dev against real CF bindings
npm run deploy                            # wrangler deploy
npm run tail                              # stream prod logs
npm run db:migrate:local                  # apply D1 migrations to local SQLite
npm run db:migrate:remote                 # apply D1 migrations to prod D1
```

Trigger a scheduled handler locally while `npm run dev` is running:

```bash
# Fast cron (every 4 hours at :17):
curl "http://localhost:8787/__scheduled?cron=17+*/4+*+*+*"

# Slow cron (daily at 07:23 UTC):
curl "http://localhost:8787/__scheduled?cron=23+7+*+*+*"
```

## Data flow

```
[cron trigger: fast 17 */4 * * *]     [cron trigger: slow 23 7 * * *]
              \                                   /
               v                                 v
                scheduled(controller, env, ctx)        -- src/index.ts
                          |
                  switch(controller.cron)
                   /                    \
              runFast(env)          runSlow(env)       -- src/run.ts
                   \________  __________/
                            \/
            Promise.allSettled(adapters.map(runAdapter))
                            |
   runAdapter: try { iterate adapter -> db.upsertJob } catch { writeRunLog(error) }
                            |
    src/adapters/* -> src/normalize.ts -> src/db.ts -> D1 (jobs, dedup_keys, run_log, raw_responses)
                                                                      |
                                    Phase 3 slow-cron tail: src/digest.ts -> GitHub commit
```

## Conventions

1. **Adapters are pure async generators.** Signature: `(config, deps) => AsyncIterable<Job>`. Deps injected: `{ fetch, logger, now }`. Never call `globalThis.fetch` directly from an adapter — always go through `deps.fetch`. This makes adapters trivially testable.
2. **No D1 mocks in tests.** Use real local SQLite via `@cloudflare/vitest-pool-workers`. HTTP is stubbed via a 10-line fetch-stub helper plus captured fixtures in `test/fixtures/{source}/`. No MSW.
3. **Every outbound fetch carries a non-default User-Agent** via `src/util/ua.ts`. Workday, Phenom, and iCIMS tenants 403 the default Workers UA.
4. **Typed bindings.** `src/env.ts` defines `Env`. Adapters and `run.ts` import from there. Run `npm run types` after editing `wrangler.jsonc` to refresh `worker-configuration.d.ts`.
5. **Adapters must never throw up to `run.ts`.** Catch internally and write a `run_log` row with the error text. `Promise.allSettled` in `run.ts` is belt-and-suspenders — one broken source must not poison the cron.
6. **Timestamps are ISO-8601 UTC strings** everywhere. Crons run in UTC. Use `new Date().toISOString()`.
7. **Validate source responses with Zod.** Invalid jobs are logged and skipped, never thrown.
8. **Schema changes go through migrations.** `wrangler d1 migrations create cronfinder <desc>` then edit the generated SQL file. Apply `--local` first; only `--remote` after tests pass.
9. **Secrets vs vars.** Secrets (API keys, tokens) via `wrangler secret put`. Non-secret config goes in the `vars` block of `wrangler.jsonc`.
10. **Observability = one structured JSON log line per adapter run.** Example: `console.log(JSON.stringify({ t: "adapter_run", cron, source, duration_ms, jobs_fetched, jobs_new, jobs_updated, error }))`. Workers Logs is then searchable by field.

## External-actions rule (IMPORTANT for Claude Code sessions)

This Worker lives on infrastructure the assistant cannot touch directly. If a change requires any of:

- a Cloudflare dashboard action,
- `wrangler secret put` (needs the user's shell to accept a prompt),
- `wrangler d1 create`, `wrangler kv namespace create`, or any resource creation that returns an ID to paste into `wrangler.jsonc`,
- `wrangler d1 migrations apply --remote`,
- a new GitHub repo, PAT, or GitHub Actions secret,
- a USAJobs / OPM API key registration,

…then STOP and surface a `[USER ACTION]` block describing the exact command(s) to run and the value(s) to paste back. Never fabricate IDs, tokens, or secrets. Never skip a USER ACTION and assume it was done.

## Deployment

- Push to `main` triggers `.github/workflows/deploy.yml` (added in Phase 1 or 2).
- Requires repo secrets `CF_API_TOKEN` and `CF_ACCOUNT_ID`. See plan for the exact token template.

## Gotchas

- **Workday `/wday/cxs` endpoints** 403 the default Workers UA. Always send a realistic browser UA.
- **USAJobs** requires three exact headers: `Host: data.usajobs.gov`, `User-Agent: <registered-email>`, `Authorization-Key: <OPM key>`.
- **Greenhouse `?content=true`** can exceed 5 MB for large boards (Stripe, Figma). Paginate or stream-parse if you hit memory/CPU.
- **D1 row limit is 2 MB** per string/BLOB (NOT 1 MB — PROJECT.md is slightly stale on this). `raw_responses.body` is gzipped bytes in a `BLOB` column via native `CompressionStream`.
- **Subrequest budget is 1,000 per invocation** on Workers Paid. Workday fan-out (~9 tenants × list + N descriptions) fits, but track subrequest count in logs and truncate per-tenant pagination if close.
- **Cron scheduling is UTC.** Offset from the top of the hour (`17 */4 * * *`, `23 7 * * *`) to avoid CF load spikes.
- **`wrangler dev` uses a local SQLite file** by default. `wrangler dev --remote` hits real D1 — be careful with destructive writes.
- **Migrations are tracked in `d1_migrations` table** automatically. Never hand-edit; always create a new numbered file.
