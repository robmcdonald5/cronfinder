-- ATS tenant registry. Replaces the in-code target lists in
-- src/config/targets-*.ts. Each row is one company slug on one ATS.
-- Seeds live in src/seeds/*.json and are upserted (INSERT OR IGNORE)
-- at the top of every cron so that health columns survive across deploys.
--
-- Workday and Eightfold need extra tenant-shape info (wdN, site, host,
-- domain) — that lives in `meta` as JSON. Simple-slug ATSes leave meta NULL.
CREATE TABLE ats_tenants (
  ats                   TEXT NOT NULL,            -- 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'eightfold'
  slug                  TEXT NOT NULL,            -- source tag after the ':'
  meta                  TEXT,                     -- JSON or NULL
  added_at              TEXT NOT NULL,            -- ISO-8601
  discovered_via        TEXT NOT NULL DEFAULT 'seed',   -- 'seed' | 'auto'
  last_fetched_at       TEXT,                     -- ISO-8601; NULL = never
  last_ok_at            TEXT,                     -- ISO-8601; last 2xx
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  jobs_last_seen        INTEGER,                  -- from most recent run
  status                TEXT NOT NULL DEFAULT 'active', -- 'active' | 'dead'
  PRIMARY KEY (ats, slug)
);

-- Sharded fetch order — ORDER BY status, last_fetched_at NULLS FIRST picks
-- freshly-seeded and stalest-polled tenants first.
CREATE INDEX idx_ats_tenants_fetch_order
  ON ats_tenants(ats, status, last_fetched_at);

-- Negative cache for auto-discovery probes. When a (guessed) slug returns 404
-- on a Greenhouse/Lever/Ashby endpoint, we record it here and skip re-probing
-- for 30 days.
CREATE TABLE ats_probe_failures (
  ats             TEXT NOT NULL,
  slug            TEXT NOT NULL,
  last_probed_at  TEXT NOT NULL,
  status_code     INTEGER,
  PRIMARY KEY (ats, slug)
);
