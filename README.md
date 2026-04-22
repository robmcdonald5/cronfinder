# cronfinder

Scheduled Cloudflare Worker that pulls job postings from curated public APIs every few hours, normalizes and deduplicates them into a D1 (SQLite) database, and emits a daily Markdown digest for Claude Code to consume.

- **Product spec:** [`PROJECT.md`](./PROJECT.md)
- **Engineering conventions:** [`CLAUDE.md`](./CLAUDE.md)
- **Sources, infra, secrets, deps:** [`SOURCES.md`](./SOURCES.md)

## Quick start

```bash
npm install
npx wrangler login

# Set secrets (interactive prompt for each).
npx wrangler secret put USAJOBS_API_KEY          # from https://developer.usajobs.gov/
npx wrangler secret put USAJOBS_USER_AGENT       # your registered email

# Apply schema locally then remotely.
npm run db:migrate:local
npm run db:migrate:remote

# Generate binding types and boot the dev server.
npm run types
npm run dev
```

Trigger a scheduled run against the local dev server:

```bash
curl "http://localhost:8787/__scheduled?cron=17+*/4+*+*+*"   # fast cron
curl "http://localhost:8787/__scheduled?cron=23+7+*+*+*"     # slow cron
```

Deploy:

```bash
npm run deploy
```

## `wrangler.jsonc`

The D1 `database_id` and KV `id` in `wrangler.jsonc` are resource identifiers, not credentials — they bind the Worker to specific Cloudflare resources but can't be used without the account's API token. They live directly in the tracked config; if you fork this repo you'll want to replace them with your own `wrangler d1 create` / `wrangler kv namespace create` output.

## Secrets

- Production secrets (USAJobs key, etc.) live on Cloudflare's infrastructure — set once via `wrangler secret put`, never in git, never in any local file.
- For `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in.

## Commands

See `CLAUDE.md` for the full command list and engineering conventions.
