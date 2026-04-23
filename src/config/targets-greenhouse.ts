// Greenhouse board tokens. The slug is the `{token}` in
// https://job-boards.greenhouse.io/{token}.
//
// Companies migrate ATSes frequently; when an adapter returns HTTP 404, the
// run_log row will have an error and this list should be pruned or corrected.
// Query for stale entries: SELECT source FROM run_log WHERE error LIKE 'greenhouse % HTTP 404' ORDER BY run_at DESC LIMIT 20;

export const GREENHOUSE_TOKENS: readonly string[] = [
  "airbnb",
  "anthropic",
  "attentive",
  "brex",
  "cloudflare",
  "coinbase",
  "databricks",
  "duolingo",
  "figma",
  "gusto",
  "instacart",
  "mercury",
  "pinterest",
  "reddit",
  "robinhood",
  "stripe",
  "toast",
  "vercel",
  "warp",
] as const;
