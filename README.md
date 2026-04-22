# cronfinder

Scheduled Cloudflare Worker that pulls job postings from curated public APIs every few hours, normalizes and deduplicates them into a D1 (SQLite) database, and emits a daily Markdown digest for Claude Code to consume.

- **Product spec:** [`PROJECT.md`](./PROJECT.md)
- **Engineering conventions:** [`CLAUDE.md`](./CLAUDE.md)

## Quick start (fresh clone)

```bash
npm install

# Copy the wrangler config template and authenticate.
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login

# Create your own D1 + KV — paste the returned IDs into wrangler.jsonc.
npx wrangler d1 create cronfinder
npx wrangler kv namespace create CACHE

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

Then trigger a scheduled run locally:

```bash
curl "http://localhost:8787/__scheduled?cron=17+*/4+*+*+*"   # fast cron
curl "http://localhost:8787/__scheduled?cron=23+7+*+*+*"     # slow cron
```

Deploy:

```bash
npm run deploy
```

## Why `wrangler.jsonc` is gitignored

The repo-tracked file is `wrangler.example.jsonc` with placeholder D1/KV IDs. The real `wrangler.jsonc` (with your actual resource IDs) is gitignored so the public tree never exposes which specific D1 database or KV namespace this project uses. See `CLAUDE.md` for the rationale and the GitHub Actions substitution pattern used when we wire up CI deploy.

## Where the secrets live

- Production secrets (USAJobs key, etc.) live on Cloudflare's infrastructure — set once via `wrangler secret put`, never in git, never in any local file.
- For `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` (gitignored) and fill in.

## Commands

See `CLAUDE.md` for the full command list and engineering conventions.
