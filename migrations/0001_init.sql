-- cronfinder initial schema
-- One row per unique posting (source, external_id).
-- `id` is sha256(source + ':' + external_id).

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  company           TEXT NOT NULL,
  title             TEXT NOT NULL,
  location          TEXT,
  remote            INTEGER,
  employment_type   TEXT,
  department        TEXT,
  description_html  TEXT,
  description_text  TEXT,
  salary_min        INTEGER,
  salary_max        INTEGER,
  salary_currency   TEXT,
  clearance         TEXT,
  apply_url         TEXT NOT NULL,
  posted_at         TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  raw_hash          TEXT,
  UNIQUE(source, external_id)
);

CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX idx_jobs_last_seen  ON jobs(last_seen_at);
CREATE INDEX idx_jobs_company    ON jobs(company);
CREATE INDEX idx_jobs_source     ON jobs(source);

-- Cross-source dedup (populated in Phase 3, schema provisioned now).
CREATE TABLE dedup_keys (
  dedup_hash        TEXT PRIMARY KEY,
  canonical_job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  first_seen_at     TEXT NOT NULL
);

-- Per-adapter-per-run observability.
CREATE TABLE run_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at         TEXT NOT NULL,
  cron           TEXT NOT NULL,     -- 'fast' | 'slow'
  source         TEXT NOT NULL,     -- 'greenhouse:stripe' | 'workday:rtx' | ...
  duration_ms    INTEGER,
  jobs_fetched   INTEGER,
  jobs_new       INTEGER,
  jobs_updated   INTEGER,
  error          TEXT
);

CREATE INDEX idx_run_log_run_at ON run_log(run_at);
CREATE INDEX idx_run_log_source ON run_log(source);

-- Raw response archive for replay when parsers break.
-- body is gzipped bytes (see src/util/gzip.ts) to stay well under the 2 MB D1 row limit.
CREATE TABLE raw_responses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  url         TEXT,
  body        BLOB
);

CREATE INDEX idx_raw_responses_fetched_at ON raw_responses(fetched_at);
CREATE INDEX idx_raw_responses_source ON raw_responses(source);
