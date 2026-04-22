// Personal filter criteria. Applied in-memory at digest time only — D1 keeps
// every job so changes here are a restart-cheap config tweak, not a data
// migration. To reset criteria, edit this file and re-run the slow cron
// (or call buildDigest again manually).

import type { Job } from "../normalize";

export interface FilterResult {
  accept: boolean;
  reason?: string;
}

// --- criteria (edit freely) -------------------------------------------------

// Title words that MUST appear (case-insensitive, word-boundaried).
// At least one must match. Leave empty to skip the include check.
const TITLE_INCLUDE: readonly string[] = [
  "software engineer",
  "software developer",
  "backend",
  "back[- ]end",
  "frontend",
  "front[- ]end",
  "fullstack",
  "full[- ]stack",
  "platform engineer",
  "site reliability",
  "\\bsre\\b",
  "devops",
  "devsecops",
  "infrastructure engineer",
  "solutions engineer",
  "support engineer",
  "systems engineer",
  "cloud engineer",
  "data engineer",
  "machine learning engineer",
  "\\bml engineer\\b",
  "applied (ai|ml)",
  "ai engineer",
  "developer advocate",
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
];

// Companies that reject regardless of role (exact normalized match).
const COMPANY_EXCLUDE: readonly string[] = [
  "revature",
  "smoothstack",
  "tek systems",
  "teksystems",
];

// If a job's location matches any of these patterns (OR if remote is true),
// it's acceptable. Empty array = accept any location.
const LOCATION_INCLUDE: readonly string[] = [
  "\\btx\\b",
  "texas",
  "austin",
  "dallas",
  "houston",
  "san antonio",
  "fort worth",
  "\\bdc\\b",
  "washington",
  "virginia",
  "\\bva\\b",
  "arlington",
  "alexandria",
  "mclean",
  "reston",
  "tysons",
  "fairfax",
  "maryland",
  "\\bmd\\b",
  "bethesda",
  "anywhere",
  "remote",
  "united states",
  "\\busa\\b",
  "us only",
];

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

export function shouldAccept(job: Job): FilterResult {
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

  // Location: accept if remote OR location matches include list OR no include list defined.
  if (LOCATION_INCLUDE_RE) {
    const locMatch = job.location ? LOCATION_INCLUDE_RE.test(job.location) : false;
    if (!job.remote && !locMatch) {
      return { accept: false, reason: "location_not_include" };
    }
  }

  // Experience check: parse max X+ years from description, reject if > threshold.
  if (Number.isFinite(MAX_REQUIRED_YEARS) && job.description_text) {
    let maxYears = 0;
    for (const m of job.description_text.matchAll(YEARS_RE)) {
      const n = parseInt(m[1]!, 10);
      if (n > maxYears && n <= 20) maxYears = n;
    }
    if (maxYears > MAX_REQUIRED_YEARS) {
      return { accept: false, reason: `years:${maxYears}` };
    }
  }

  return { accept: true };
}
