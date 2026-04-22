-- Daily digest storage.
-- The slow cron builds Markdown for the last 24h of new jobs and writes one
-- row here, keyed by YYYY-MM-DD. The local `npm run pull-digests` script
-- syncs missing dates from remote D1 into ./digests/ (gitignored).
CREATE TABLE digests (
  id                TEXT PRIMARY KEY,     -- 'YYYY-MM-DD'
  generated_at      TEXT NOT NULL,        -- ISO-8601 UTC
  window_start_iso  TEXT NOT NULL,
  window_end_iso    TEXT NOT NULL,
  jobs_count        INTEGER NOT NULL,
  body              TEXT NOT NULL
);
