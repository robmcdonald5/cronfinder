// Canonical Job shape emitted by every adapter. db.upsertJob derives id,
// timestamps, and raw_hash from this shape.

export type Clearance = "public_trust" | "secret" | "top_secret" | "ts_sci" | null;
export type EmploymentType =
  | "full_time"
  | "part_time"
  | "intern"
  | "contract"
  | "temp"
  | null;

export interface Job {
  source: string;                     // 'greenhouse:stripe' | 'lever:anthropic' | 'workday:rtx' | ...
  external_id: string;                // stable per-source id
  company: string;
  title: string;
  location: string | null;
  remote: boolean | null;
  employment_type: EmploymentType;
  department: string | null;
  description_html: string | null;
  description_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;     // ISO 4217 where known
  clearance: Clearance;
  apply_url: string;
  posted_at: string | null;           // ISO-8601 UTC
}

// String normalizers for cross-source dedup. Kept here so adapters and dedup
// share one canonical form.

const COMPANY_SUFFIX_RE =
  /\b(inc\.?|incorporated|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|co\.?|plc|gmbh|ag|s\.?a\.?|pty\.?|ltda\.?)\b\.?/gi;

export function normalizeCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(COMPANY_SUFFIX_RE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")        // drop parentheticals like "(Remote)"
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const US_STATE_ABBREV: Record<string, string> = {
  nyc: "new york, ny",
  "new york city": "new york, ny",
  "san francisco": "san francisco, ca",
  sfo: "san francisco, ca",
  sf: "san francisco, ca",
  dc: "washington, dc",
  "washington d.c.": "washington, dc",
  "washington, d.c.": "washington, dc",
  "dmv": "washington, dc",
};

export function normalizeLocation(value: string | null): string {
  if (!value) return "";
  const lowered = value
    .toLowerCase()
    .replace(/\s*[-—|/]\s*/g, " ")
    .replace(/[^\p{L}\p{N},\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return US_STATE_ABBREV[lowered] ?? lowered;
}
