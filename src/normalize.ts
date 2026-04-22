// Canonical Job shape emitted by every adapter. db.upsertJob derives id and
// timestamps from this shape.

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

// "general-catalyst" -> "General Catalyst". Used by adapters where the
// API slug is all we have for the company name.
export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Parse an ATS "workplaceType" style field — Lever / Ashby / Eightfold all
// surface strings like "Remote", "onsite", "REMOTE", "ON_SITE", "hybrid".
// Workday instead hides this inside locations text, which parseRemoteFromLocation
// (inlined in workday.ts) handles separately.
export function parseWorkplaceType(value: string | null | undefined): boolean | null {
  if (!value) return null;
  const t = value.toLowerCase();
  if (t.includes("remote")) return true;
  if (t.includes("onsite") || t.includes("on-site") || t.includes("on_site")) return false;
  return null;
}

// Tolerant employment-type matcher for Lever ("Full-time"), Himalayas
// ("Full Time"), Ashby ("FullTime"), USAJobs ("Full-time"), etc. Returns null
// rather than throwing on unknowns.
export function parseEmploymentType(value: string | null | undefined): EmploymentType {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("intern")) return "intern";
  if (v.includes("full")) return "full_time";
  if (v.includes("part")) return "part_time";
  if (v.includes("contract")) return "contract";
  if (v.includes("temp")) return "temp";
  return null;
}

// Heuristic clearance detection from title + description text. Called by
// Workday and Eightfold adapters against defense-prime postings.
export function parseClearance(
  title: string,
  description: string | null | undefined,
): Clearance {
  const blob = `${title} ${description ?? ""}`.toLowerCase();
  if (/ts\s*\/\s*sci|top\s*secret\s*\/\s*sci/.test(blob)) return "ts_sci";
  if (/top\s*secret/.test(blob)) return "top_secret";
  if (/\bsecret\b/.test(blob)) return "secret";
  if (/public\s*trust/.test(blob)) return "public_trust";
  return null;
}
