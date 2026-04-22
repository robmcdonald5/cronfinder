// Eightfold is a careers-site vendor used by several defense primes.
// API: GET https://{host}/api/apply/v2/jobs?domain={domain}&start={offset}&num={per-page}

export interface EightfoldTarget {
  company: string;
  slug: string;    // used in run_log source tag
  host: string;    // careers site host
  domain: string;  // eightfold "domain" query param
}

export const EIGHTFOLD_TARGETS: readonly EightfoldTarget[] = [
  { company: "Northrop Grumman", slug: "northrop", host: "jobs.northropgrumman.com", domain: "ngc.com" },
  { company: "CACI", slug: "caci", host: "careers.caci.com", domain: "caci.com" },
] as const;
