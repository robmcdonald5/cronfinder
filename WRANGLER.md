# Wrangler command reference

Commands scoped to this project. `package.json` already wraps the common ones as `npm run …` — prefer those where they exist.

`--local` hits the local SQLite file in `.wrangler/state/` (dev-only).
`--remote` hits the deployed Cloudflare resources (production).

---

## Auth

```powershell
npx wrangler login              # browser OAuth; one-time per machine
npx wrangler whoami             # confirm the authed account
npx wrangler logout
```

## Dev server

```powershell
npm run dev                     # wrangler dev --test-scheduled (local D1/KV)
npm run dev:remote              # same, but bound to remote D1/KV
```

Trigger a cron while either is running:

```powershell
# Fast cron (every 4h at :17)
curl.exe "http://127.0.0.1:8787/__scheduled?cron=17+*/4+*+*+*"

# Slow cron (daily at 07:23 UTC) — builds + stores the digest
curl.exe "http://127.0.0.1:8787/__scheduled?cron=23+7+*+*+*"
```

## Deploy

```powershell
npm run deploy                  # one-off manual deploy
git push                        # CF Workers Builds auto-deploys on push to main
```

See all deployed versions or roll back to a previous one:

```powershell
npx wrangler versions list
npx wrangler rollback [version-id]
```

## Logs

```powershell
npm run tail                    # stream live structured logs from production
npx wrangler tail --format json # same, machine-readable
npx wrangler tail --search "cron_done"
npx wrangler tail --search "adapter_run error"
```

## Types

```powershell
npm run types                   # regenerate worker-configuration.d.ts from wrangler.jsonc
```

## Secrets (production-only; never in git)

```powershell
npx wrangler secret put USAJOBS_API_KEY       # interactive paste
npx wrangler secret put USAJOBS_USER_AGENT
npx wrangler secret list
npx wrangler secret delete <NAME>
```

## D1

### Admin

```powershell
npx wrangler d1 list
npx wrangler d1 info cronfinder
```

### Migrations

```powershell
npx wrangler d1 migrations create cronfinder <short-description>   # scaffolds next numbered .sql
npm run db:migrate:local                                            # apply locally first
npm run db:migrate:remote                                           # then remote after local passes
```

### Ad-hoc queries

```powershell
# One-off query (add --remote for production)
npx wrangler d1 execute cronfinder --remote --command "SELECT count(*) FROM jobs"

# Run a SQL file
npx wrangler d1 execute cronfinder --remote --file path/to/query.sql

# Machine-readable output
npx wrangler d1 execute cronfinder --remote --json --command "..."
```

### Backup / time travel

```powershell
# Export full SQL dump
npx wrangler d1 export cronfinder --remote --output ./backup.sql

# Inspect the 30-day restore window
npx wrangler d1 time-travel info cronfinder

# Restore to a prior state (gives back a bookmark to roll forward if needed)
npx wrangler d1 time-travel restore cronfinder --timestamp <unix>
```

## KV

```powershell
npx wrangler kv namespace list
npx wrangler kv key list --binding CACHE --remote
npx wrangler kv key get "<key>" --binding CACHE --remote
npx wrangler kv key put "<key>" "<value>" --binding CACHE --remote
npx wrangler kv key delete "<key>" --binding CACHE --remote
```

---

## Cronfinder diagnostic queries

Run each with:

```powershell
npx wrangler d1 execute cronfinder --remote --command "<SQL>"
```

### Source health — errors in the last 48h, grouped

```sql
SELECT source, count(*) AS n, max(run_at) AS last_seen, max(error) AS example
FROM run_log
WHERE error IS NOT NULL AND run_at > datetime('now', '-48 hours')
GROUP BY source ORDER BY last_seen DESC
```

### Sources currently returning HTTP 404 (stale tokens)

```sql
SELECT source, count(*) AS n, max(run_at) AS last_seen
FROM run_log
WHERE error LIKE '%HTTP 404%'
GROUP BY source ORDER BY last_seen DESC
```

### Sources with 0 jobs for 48h (silent breakage)

```sql
SELECT source
FROM run_log
WHERE run_at > datetime('now', '-48 hours')
GROUP BY source
HAVING max(coalesce(jobs_fetched, 0)) = 0
```

### Total job count by source

```sql
SELECT source, count(*) AS n
FROM jobs
GROUP BY source ORDER BY n DESC
```

### Jobs added in the last 24h

```sql
SELECT source, count(*) AS n
FROM jobs
WHERE first_seen_at > datetime('now', '-24 hours')
GROUP BY source ORDER BY n DESC
```

### Most recent cron summary (per cadence)

```sql
SELECT cron, count(*) AS tasks, sum(coalesce(jobs_fetched,0)) AS fetched,
       sum(coalesce(jobs_new,0)) AS new_rows,
       count(CASE WHEN error IS NOT NULL THEN 1 END) AS failed,
       max(run_at) AS last_at
FROM run_log
WHERE run_at = (SELECT max(run_at) FROM run_log rl WHERE rl.cron = run_log.cron)
GROUP BY cron
```

### Available digest dates

```sql
SELECT id, jobs_count, generated_at FROM digests ORDER BY id DESC LIMIT 30
```

### Preview a specific day's digest Markdown directly

```sql
SELECT body FROM digests WHERE id = '2026-04-22'
```

### Clean up old run_log rows (only if rows-read cost starts to matter)

```sql
DELETE FROM run_log WHERE run_at < datetime('now', '-30 days')
```

---

## Tips

- **Drop the outer `npx` if wrangler is on your PATH.** Using `npx` ensures the repo's pinned version.
- **PowerShell curl is `Invoke-WebRequest`** — use `curl.exe` explicitly for the simple form shown above.
- **`--local` vs `--remote` applies to `d1 execute`, `d1 migrations apply`, `kv key *`, and `dev`.** Default is local for `execute`, remote for `migrations apply` depending on flag.
- **Production writes should be reversible.** `d1 time-travel` covers D1. KV has no rollback — be deliberate with `kv key put`/`delete` on `--remote`.
