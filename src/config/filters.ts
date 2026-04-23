// Personal filter criteria. Applied in-memory at digest time only — D1 keeps
// every job so changes here are a restart-cheap config tweak, not a data
// migration. To reset criteria, edit this file and re-run the slow cron
// (or call buildDigest again manually).
//
// Entries in TITLE_INCLUDE / TITLE_EXCLUDE / LOCATION_INCLUDE are RegExp
// fragments, not literals — word boundaries `\b...\b`, character classes
// `[- ]`, alternations `(ai|ml)` are all allowed. Take care when adding
// literal strings that may contain regex metacharacters (`.`, `+`, `*`,
// `(`, `)`, `[`, `]`, `?`).

import type { Clearance } from "../normalize";

export interface FilterResult {
  accept: boolean;
  reason?: string;
}

// Narrow subset of Job that shouldAccept actually reads. Both canonical Job
// objects (from adapters) and JobRow objects (from D1 SELECT) satisfy this.
export interface FilterInput {
  title: string;
  company: string;
  location: string | null;
  remote: boolean | 0 | 1 | null;
  clearance: Clearance;
  description_text: string | null;
}

// Title words that MUST appear (case-insensitive, word-boundaried).
// At least one must match. Leave empty to skip the include check.
const TITLE_INCLUDE: readonly string[] = [
  // classic SWE
  "software engineer",
  "software developer",
  "\\bdeveloper\\b",            // catches python/application/junior/associate/genai developer
  "backend",
  "back[- ]end",
  "frontend",
  "front[- ]end",
  "fullstack",
  "full[- ]stack",
  "application engineer",
  "product engineer",
  "growth engineer",
  "technology analyst",
  "technology associate",
  "engineering associate",
  "associate engineer",
  "software consultant",
  "technology consultant",
  "apprentice",
  "apprenticeship",

  // infra / ops
  "platform engineer",
  "site reliability",
  "\\bsre\\b",
  "devops",
  "devsecops",
  "\\bmlops\\b",
  "infrastructure engineer",
  "cloud engineer",
  "data engineer",
  "systems engineer",
  "support engineer",
  "solutions engineer",
  "forward deployed",
  "quality engineer",
  "developer advocate",
  "solutions architect",
  "implementation engineer",
  "integration engineer",
  "customer engineer",
  "partner engineer",
  "field engineer",
  "deployment engineer",
  "technical account manager",
  "technical solutions",
  "cloud support",
  "technical support",
  "support associate",
  "reliability engineer",
  "production engineer",
  "developer relations",
  "developer experience",
  "developer evangelist",
  "technical writer",

  // AI / ML
  "machine learning engineer",
  "\\bml engineer\\b",
  "applied (ai|ml)",
  "ai engineer",
  "artificial intelligence",
  "agentic ai",
  "generative ai",
  "\\bgen\\s?ai\\b",
  "prompt engineer",
  "automation engineer",
  "applied scientist",
  "machine learning scientist",
  "\\bml scientist\\b",
  "research engineer",
  "research scientist",
  "data scientist",
  "\\bai scientist\\b",
  "\\bllm engineer\\b",
  "foundation model",
  "inference engineer",

  // security
  "security engineer",
  "cybersecurity",
  "application security",
  "appsec",
];

// Title words that REJECT the job. Any match excludes the posting.
const TITLE_EXCLUDE: readonly string[] = [
  "\\bstaff\\b",
  "\\bprincipal\\b",
  "\\bdistinguished\\b",
  "director",
  "\\bvp\\b",
  "vice president",
  "head of",
  "chief",
  "\\bcto\\b",
  "\\bceo\\b",
  "senior manager",
  "engineering manager",
  "\\bintern(ship)?\\b",
  "co[- ]?op",
];

// Companies that reject regardless of role (exact normalized match).
const COMPANY_EXCLUDE: readonly string[] = [
  "revature",
  "smoothstack",
  "tek systems",
  "teksystems",
];

// Any US location is acceptable (the user is willing to relocate).
// A job passes if `remote === true` OR its location string matches one of
// these patterns OR the description doesn't explicitly say "locals only"
// (checked separately via LOCAL_ONLY_RE below).
const LOCATION_INCLUDE: readonly string[] = [
  // Remote / non-specific US indicators
  "remote",
  "anywhere",
  "united states",
  "\\busa\\b",
  "\\bus\\b",
  "\\bu\\.s\\.?",
  "us only",
  "us remote",
  "north america",

  // All 50 state names + DC + PR
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "district of columbia", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
  "new jersey", "new mexico", "new york", "north carolina", "north dakota",
  "ohio", "oklahoma", "oregon", "pennsylvania", "puerto rico", "rhode island",
  "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",

  // State codes — collision-safe as \b-bounded word (case-insensitive via the
  // "i" flag on the combined regex; matches "CA", "ca", ", CA" etc.)
  "\\b(AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|ID|IL|KS|KY|LA|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\\b",

  // State codes that collide with English words (OR/IN/ME/HI) — require a
  // comma prefix so "remote or hybrid" doesn't accidentally hit.
  ",\\s*(OR|IN|ME|HI)\\b",
];

// Explicit signals that the posting rejects remote AND relocators. Reject
// only on unambiguous phrasing — "relocation not offered" is ambiguous
// (usually means no financial assistance, not that they won't hire).
const LOCAL_ONLY_RE = new RegExp(
  "(\\blocal\\s+(candidates?|applicants?|only)\\b" +
    "|\\blocals?\\s+only\\b" +
    "|must\\s+be\\s+local\\b" +
    "|no\\s+remote\\s+(candidates?|applicants?|workers?|options?|work)" +
    "|relocation\\s+(is\\s+)?not\\s+(offered|considered|accepted|available))",
  "i",
);

// Clearance acceptance. null means "no clearance mentioned".
const ACCEPTED_CLEARANCES: readonly (string | null)[] = [
  null,
  "public_trust",
  "secret",
];

// Senior-level experience threshold in years. If the description mentions "X+ years"
// and X > this, the job is rejected as too senior. Set to Infinity to disable.
const MAX_REQUIRED_YEARS = 6;

// --- implementation --------------------------------------------------------

const TITLE_INCLUDE_RE = new RegExp(
  `(${TITLE_INCLUDE.join("|")})`,
  "i",
);
const TITLE_EXCLUDE_RE = TITLE_EXCLUDE.length
  ? new RegExp(`(${TITLE_EXCLUDE.join("|")})`, "i")
  : null;
const LOCATION_INCLUDE_RE = LOCATION_INCLUDE.length
  ? new RegExp(`(${LOCATION_INCLUDE.join("|")})`, "i")
  : null;
const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi;
const COMPANY_EXCLUDE_SET = new Set(
  COMPANY_EXCLUDE.map((c) => c.toLowerCase().trim()),
);

export function shouldAccept(job: FilterInput): FilterResult {
  const titleLower = job.title.toLowerCase();
  const companyLower = job.company.toLowerCase().trim();

  if (COMPANY_EXCLUDE_SET.has(companyLower)) {
    return { accept: false, reason: `company_excluded:${companyLower}` };
  }

  if (TITLE_INCLUDE.length > 0 && !TITLE_INCLUDE_RE.test(titleLower)) {
    return { accept: false, reason: "title_no_include_match" };
  }
  if (TITLE_EXCLUDE_RE && TITLE_EXCLUDE_RE.test(titleLower)) {
    return { accept: false, reason: "title_excluded" };
  }

  if (!ACCEPTED_CLEARANCES.includes(job.clearance)) {
    return { accept: false, reason: `clearance:${job.clearance}` };
  }

  if (LOCATION_INCLUDE_RE) {
    const isRemote = job.remote === true || job.remote === 1;
    const locMatch = job.location ? LOCATION_INCLUDE_RE.test(job.location) : false;
    if (!isRemote && !locMatch) {
      return { accept: false, reason: "location_not_us" };
    }
  }

  // Cap description-text scans — Greenhouse `?content=true` descriptions can
  // be 100 KB–1 MB each, and these regexes run once per candidate row. The
  // signals we're looking for (locals-only, X+ years) consistently appear in
  // the first few paragraphs, so scanning the whole JD is pure waste.
  const descHead = job.description_text ? job.description_text.slice(0, 8000) : null;

  if (descHead && LOCAL_ONLY_RE.test(descHead)) {
    return { accept: false, reason: "local_only" };
  }

  if (Number.isFinite(MAX_REQUIRED_YEARS) && descHead) {
    let maxYears = 0;
    for (const m of descHead.matchAll(YEARS_RE)) {
      const n = parseInt(m[1]!, 10);
      if (n > maxYears && n <= 20) maxYears = n;
    }
    if (maxYears > MAX_REQUIRED_YEARS) {
      return { accept: false, reason: `years:${maxYears}` };
    }
  }

  return { accept: true };
}
