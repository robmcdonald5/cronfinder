# Job Pipeline — Project Overview

## What I'm building

An automated personal job-search pipeline that pulls job postings from a curated set of public APIs every few hours, normalizes and deduplicates them into a SQLite database, and exposes the result to Claude Code for downstream ranking and analysis.

The pipeline runs on **Cloudflare Workers + Cron Triggers** (not my PC). I want this to be a set-it-and-forget-it service that I can point Claude Code at to get a daily shortlist of relevant roles.

## Goals

1. Cover all five job categories I care about (below) using free or near-free public endpoints.
2. Run entirely on Cloudflare's free/paid tier — total infrastructure cost ≤ $5/month.
3. Produce a deduplicated, timestamped, queryable database of fresh job postings.
4. Emit a daily "new since last run" artifact (Markdown or JSON) for Claude Code to consume.
5. Be resilient to individual source failures — one broken scraper should not break the pipeline.

## Non-goals

- No LinkedIn or Indeed direct scraping (ToS + legal risk + Cloudflare bot detection).
- No headless browser scraping (Workers CPU limits make this impractical; also a maintenance trap).
- No paid aggregator APIs at this stage — they've mostly collapsed in 2024–2025 and the cheap ones don't fit the budget.
- No user-facing web UI for now. Consumption is via Claude Code reading the DB directly or reading generated Markdown.
- No recruiter-style outreach automation, no application auto-submission.

## Job categories to cover

1. **Defense / government contractor** — Lockheed Martin, RTX, Northrop Grumman, Boeing Defense, General Dynamics, L3Harris, BAE, SAIC, Leidos, Booz Allen, CACI, ManTech, Peraton, KBR, Parsons.
2. **Federal civilian** — USAJobs, Pathways, Recent Graduates, Schedule A, Veterans.
3. **Big Tech + mid-market commercial SWE** — FAANG-tier and mid-size software companies.
4. **Tech-adjacent** — support engineering, DevOps, SRE, solutions engineering, platform engineering.
5. **Startup / YC / early-stage** — YC portfolio companies, seed–Series C.

## Tech stack (already decided — do not re-litigate)

- **Runtime:** Cloudflare Workers (TypeScript preferred).
- **Scheduler:** Cloudflare Cron Triggers — two crons, different cadences.
- **Database:** Cloudflare D1 (SQLite at the edge). Simpler and cheaper than bolting on Supabase given the scale.
- **Cache / state:** Cloudflare KV for ATS-discovery metadata and last-seen timestamps.
- **Queue (optional, later):** Cloudflare Queues if Workday fan-out exceeds subrequest limits within a single invocation.
- **Paid tier:** Workers Paid plan ($5/month) is budgeted — needed for the 1,000-subrequest-per-invocation limit. Workday N+1 fetches will blow the 50-subrequest free cap.
- **Downstream analysis:** Claude Code, reading D1 directly (via `wrangler d1 execute` or a small read-only HTTP endpoint) and/or reading generated Markdown artifacts committed to a private GitHub repo.

## Data sources — the authoritative list

Implementation priority is indicated. Build P0 first, P1 once P0 is stable, P2 only if there's a coverage gap.

### P0 — Build first

| Source | Endpoint pattern | Auth | Covers categories |
|---|---|---|---|
| **USAJobs** | `GET https://data.usajobs.gov/api/Search` | Headers: `Host`, `User-Agent: <email>`, `Authorization-Key: <OPM key>` | 2 |
| **Greenhouse** | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | None | 3, 5 |
| **Lever** | `GET https://api.lever.co/v0/postings/{company}?mode=json` | None | 3, 5 |
| **Ashby** | `GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true` | None | 3, 5 |
| **Workday `/wday/cxs`** | `POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` | None, but realistic `User-Agent` required | 1, 3 |

### P1 — Build second

| Source | Endpoint | Covers |
|---|---|---|
| **HN "Who is Hiring" via Algolia** | `GET https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring` then `GET https://hn.algolia.com/api/v1/items/{story_id}` | 5, 4 |
| **GitHub curated repos** | `https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md`, `/SimplifyJobs/New-Grad-Positions/dev/README.md`, `/vanshb03/Summer2026-Internships/dev/README.md`, `/speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD_USA.md` | 3, 5 |
| **Himalayas** | `GET https://himalayas.app/jobs/api/search` | 4 |
| **Eightfold (defense fallback)** | `GET https://jobs.northropgrumman.com/api/apply/v2/jobs?domain=ngc.com&start=0&num=50`, `GET https://careers.caci.com/api/apply/v2/jobs?domain=caci.com&start=0&num=50` | 1 |

### P2 — Only if coverage gaps remain

- **RemoteOK** `GET https://remoteok.com/api` (must set custom User-Agent, attribution required).
- **Remotive** `GET https://remotive.com/api/remote-jobs` (max 2 req/min, 24h post-delay, strict ToS).
- **WeWorkRemotely** RSS feeds (category-specific).
- **iCIMS sitemap parsing** for Peraton (`https://careers-peraton.icims.com/jobs/sitemap.xml`) and GD Electric Boat.
- **Phenom/BrassRing sitemap parsing** for Lockheed (`https://www.lockheedmartinjobs.com/sitemap.xml`), Boeing, BAE, SAIC, L3Harris — parse JSON-LD `JobPosting` schema from detail pages.

### Verified Workday defense prime endpoints

These are the highest-leverage entries. One fan-out Worker unlocks all nine.

```
RTX          https://globalhr.wd5.myworkdayjobs.com/wday/cxs/globalhr/REC_RTX_Ext_Gateway/jobs
Leidos       https://leidos.wd5.myworkdayjobs.com/wday/cxs/leidos/External/jobs
Booz Allen   https://bah.wd1.myworkdayjobs.com/wday/cxs/bah/BAH_Jobs/jobs
CACI         https://caci.wd1.myworkdayjobs.com/wday/cxs/caci/External/jobs
GDIT         https://gdit.wd5.myworkdayjobs.com/wday/cxs/gdit/External_Career_Site/jobs
ManTech      https://mantech.wd1.myworkdayjobs.com/wday/cxs/mantech/External/jobs
KBR          https://kbr.wd5.myworkdayjobs.com/wday/cxs/kbr/KBR_Careers/jobs
Parsons      https://parsons.wd5.myworkdayjobs.com/wday/cxs/parsons/Search/jobs
Northrop     https://ngc.wd1.myworkdayjobs.com/wday/cxs/ngc/Northrop_Grumman_External_Site/jobs
```

## Architecture

### Two-cron pattern

- **Fast cron — every 4 hours:** hits lightweight high-freshness endpoints (Greenhouse, Lever, Ashby, Himalayas, USAJobs, HN Algolia). These are cheap, fast, and most need no N+1.
- **Slow cron — every 24 hours:** handles Workday fan-out (with N+1 description fetches), Eightfold, GitHub repo parsing, sitemap parsers. These are expensive, so batching them daily is fine.

Cron expressions should be offset from the top of the hour to avoid Cloudflare load spikes. Use `17 */4 * * *` and `23 7 * * *` rather than `0 */4 * * *` and `0 7 * * *`.

### Data flow

```
[Cron Trigger]
    -> [Source adapter Worker] (one adapter per source type: greenhouse, lever, ashby, workday, usajobs, hn, github, eightfold, ...)
    -> [Normalizer] (maps each source's schema to the canonical Job shape)
    -> [Deduplicator] (hashes, checks seen_jobs table)
    -> [D1 write] (jobs table + raw_responses table)
    -> [Daily digest generator] (writes new_jobs_YYYY-MM-DD.md and optionally commits to GitHub or pushes webhook)
```

### Suggested repository layout

```
/
├── wrangler.toml
├── PROJECT.md                    (this file)
├── README.md
├── src/
│   ├── index.ts                  (scheduled() handlers for both crons)
│   ├── adapters/
│   │   ├── greenhouse.ts
│   │   ├── lever.ts
│   │   ├── ashby.ts
│   │   ├── workday.ts
│   │   ├── usajobs.ts
│   │   ├── eightfold.ts
│   │   ├── hn.ts
│   │   ├── github-repos.ts
│   │   ├── himalayas.ts
│   │   └── sitemap/
│   │       ├── phenom.ts
│   │       └── icims.ts
│   ├── normalize.ts              (canonical Job type + per-source mappers)
│   ├── dedup.ts
│   ├── db.ts                     (D1 queries)
│   ├── digest.ts                 (daily Markdown output)
│   └── config/
│       ├── targets-workday.ts    (tenant/site/wdN tuples)
│       ├── targets-greenhouse.ts (board tokens)
│       ├── targets-lever.ts
│       ├── targets-ashby.ts
│       └── filters.ts            (my criteria)
├── migrations/
│   └── 0001_init.sql
└── .github/
    └── workflows/
        └── deploy.yml            (optional: auto-deploy on push)
```

## Database schema (starting point)

```sql
-- jobs: one row per unique posting
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,          -- hash(source + external_id)
  source          TEXT NOT NULL,             -- 'greenhouse' | 'lever' | 'workday:rtx' | ...
  external_id     TEXT NOT NULL,
  company         TEXT NOT NULL,
  title           TEXT NOT NULL,
  location        TEXT,
  remote          INTEGER,                   -- 0/1/null
  employment_type TEXT,                      -- full_time | intern | contract | null
  department      TEXT,
  description_html TEXT,
  description_text TEXT,
  salary_min      INTEGER,
  salary_max      INTEGER,
  salary_currency TEXT,
  clearance       TEXT,                      -- null | secret | top_secret | ts_sci
  apply_url       TEXT NOT NULL,
  posted_at       TEXT,                      -- ISO8601 from source if available
  first_seen_at   TEXT NOT NULL,             -- when we first ingested
  last_seen_at    TEXT NOT NULL,
  raw_hash        TEXT,                      -- hash of canonical fields, for change detection
  UNIQUE(source, external_id)
);

CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX idx_jobs_company ON jobs(company);
CREATE INDEX idx_jobs_source ON jobs(source);

-- dedup_keys: secondary hash to catch cross-posted jobs (same role on multiple sources)
CREATE TABLE dedup_keys (
  dedup_hash      TEXT PRIMARY KEY,          -- hash(normalize(company)|normalize(title)|normalize(location))
  canonical_job_id TEXT NOT NULL REFERENCES jobs(id),
  first_seen_at   TEXT NOT NULL
);

-- run_log: observability
CREATE TABLE run_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at          TEXT NOT NULL,
  cron            TEXT NOT NULL,             -- 'fast' | 'slow'
  source          TEXT NOT NULL,
  jobs_fetched    INTEGER,
  jobs_new        INTEGER,
  jobs_updated    INTEGER,
  error           TEXT
);

-- raw_responses: keep raw JSON for N days so we can replay when parsers break
CREATE TABLE raw_responses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  url             TEXT,
  body            TEXT                       -- consider gzipping; D1 row limit is 1MB
);
```

## Deduplication strategy

Two layers, applied in order:

1. **Primary key dedup** on `(source, external_id)` — catches the same job re-appearing in the next run from the same source. Upsert; update `last_seen_at` and any changed fields.
2. **Cross-source dedup** on `dedup_hash = sha256(normalize(company) || normalize(title) || normalize(location))`. Normalize: lowercase, strip punctuation, collapse whitespace, strip common suffixes ("Inc", "LLC", "Corp"), canonicalize locations ("NYC" → "new york, ny"). When a new job's dedup hash matches an existing canonical row, attach the new source to a `job_sources` join table rather than creating a second row. (Add this table if/when cross-posting becomes a real problem — probably P1.)

Keep a `first_seen_at` that never updates. The daily digest filters on `first_seen_at >= now() - 24h`.

## Filter criteria

Put my personal criteria in `src/config/filters.ts` — not hardcoded into adapters. This lets me tweak without redeploying adapters and lets Claude Code see what I care about.

Filters should include at minimum:
- Title keyword include list (e.g. "software engineer", "sre", "devops", "platform", "solutions engineer", "support engineer").
- Title keyword exclude list (e.g. "senior staff", "principal", "director", "manager" if I'm filtering out leadership).
- Company exclude list (Revature, Smoothstack, and other known consultancy churn mills).
- Location include list (Texas + remote-US + DC metro for govcon).
- Clearance tolerance (accept null + public-trust + secret; exclude TS/SCI unless I flag otherwise).
- Experience-level inference (parse description for "X+ years" — flag if >5).

## Workers-specific gotchas to design around

- **Subrequest limits:** Free = 50 per invocation. Paid = 1,000. The Workday slow cron WILL exceed 50 when fanning out descriptions — must be on Paid tier.
- **CPU time:** 10ms free / 30s paid. Keep per-adapter work short; batch heavy parsing across multiple invocations if needed.
- **`User-Agent`:** Default `cf-worker` gets 403s from Workday, Phenom, and iCIMS tenants. Set a realistic UA like `Mozilla/5.0 (compatible; <yourname>-jobs-pipeline/1.0; +<contact>)`.
- **USAJobs specifically** requires three exact headers: `Host: data.usajobs.gov`, `User-Agent: <your-registered-email>`, `Authorization-Key: <key>`. Don't let the Workers fetch default User-Agent override this.
- **Response size:** Greenhouse `?content=true` for big boards (Stripe, etc.) can hit 5MB. Stream-parse or paginate.
- **D1 row size:** 1MB per row. Gzip `raw_responses.body` or truncate.
- **Timezones:** All crons run in UTC. Store timestamps as ISO8601 UTC in D1.

## Secrets

Use `wrangler secret put`:
- `USAJOBS_API_KEY`
- `USAJOBS_USER_AGENT` (my registered email)
- `GITHUB_TOKEN` (optional — only if I hit the REST API instead of raw.githubusercontent.com)

No secrets should appear in `wrangler.toml` or source.

## Legal posture

- **USAJobs:** Fine for personal use. ToS forbids derivative works / resale — stay personal.
- **Workday `/wday/cxs` endpoints:** Gray zone but defensible. Public-data scraping is protected per hiQ v. LinkedIn (9th Cir. 2022); these endpoints power the public careers UI with no auth. Set an honest UA. Don't hammer — ~1 req/sec per tenant.
- **RemoteOK / Remotive:** Both require attribution and have rate caps. Honor them. Remotive: max 2 req/min, 24h intentional delay, link-back required.
- **Greenhouse / Lever / Ashby / SmartRecruiters:** Explicitly designed for public syndication.
- **GitHub raw URLs:** Fine.
- **Sitemap parsing for Phenom/iCIMS:** Gray zone; same defense as Workday. Respect `robots.txt`.

## Phased delivery plan

### Phase 1 — MVP (weekend-scale)
- Scaffold repo + `wrangler.toml` + D1 database + migrations.
- Fast cron only.
- Adapters: Greenhouse (~30 target companies), Lever (~20), Ashby (~15), USAJobs.
- Canonical `Job` type + normalizer.
- Primary-key dedup only.
- Write results to D1. Print summary in cron logs.

### Phase 2 — Defense coverage
- Slow cron.
- Workday adapter with the 9 verified defense prime endpoints.
- Eightfold adapter for Northrop + CACI front-ends.
- Description fan-out with rate limiting (1 req/sec per tenant).

### Phase 3 — Breadth + quality
- HN Algolia adapter (monthly thread parsing).
- GitHub curated repos adapter (Markdown table parsing).
- Himalayas adapter.
- Cross-source dedup (layer 2).
- Daily digest generator → commit `new_jobs_YYYY-MM-DD.md` to a private GitHub repo or push to Discord webhook.

### Phase 4 — Long tail + polish
- Phenom/iCIMS sitemap adapters for Lockheed, Boeing, BAE, SAIC, L3Harris, Peraton.
- RemoteOK / Remotive / WWR as category-4 supplementary.
- Run log + alerting when a source returns 0 jobs (almost certainly a broken adapter).
- Read-only HTTP endpoint for Claude Code: `GET /api/jobs?since=...&category=...`.

## Open questions for implementation

- **Where does the daily digest go?** Options: (a) commit Markdown to a private GitHub repo that Claude Code has cloned locally, (b) Discord webhook, (c) email via Resend/MailChannels, (d) all of the above. Default to (a) for P3 since Claude Code can diff against its local clone.
- **How does Claude Code query D1?** Either `wrangler d1 execute <db> --command "..."` locally if auth allows, or a read-only Worker endpoint with a bearer token. Default to the Worker endpoint — more portable.
- **Target company lists — where do they live?** Start as hardcoded arrays in `src/config/targets-*.ts`. Upgrade to D1 tables if they grow past a few hundred.

## Success criteria

- Pipeline runs unattended for 7 consecutive days with zero manual intervention.
- Daily digest surfaces ≥ 10 genuinely new relevant jobs per day across categories.
- No source has been silently broken for > 48 hours (run_log alerting catches this).
- Total monthly Cloudflare bill ≤ $5.
- Claude Code can query the DB and produce a ranked shortlist in a single command.
