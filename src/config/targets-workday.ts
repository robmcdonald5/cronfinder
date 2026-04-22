// Workday /wday/cxs tuples for defense-prime careers sites.
// URL pattern: https://{tenant}.wd{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs

export interface WorkdayTarget {
  company: string;   // display name ("RTX", "Leidos")
  slug: string;      // lower-case id used in run_log source tag
  tenant: string;    // URL subdomain
  wdN: number;       // shard number in wdN
  site: string;      // site path segment
}

export const WORKDAY_TARGETS: readonly WorkdayTarget[] = [
  { company: "RTX", slug: "rtx", tenant: "globalhr", wdN: 5, site: "REC_RTX_Ext_Gateway" },
  { company: "Leidos", slug: "leidos", tenant: "leidos", wdN: 5, site: "External" },
  { company: "Booz Allen Hamilton", slug: "booz-allen", tenant: "bah", wdN: 1, site: "BAH_Jobs" },
  { company: "CACI", slug: "caci", tenant: "caci", wdN: 1, site: "External" },
  { company: "GDIT", slug: "gdit", tenant: "gdit", wdN: 5, site: "External_Career_Site" },
  { company: "ManTech", slug: "mantech", tenant: "mantech", wdN: 1, site: "External" },
  { company: "KBR", slug: "kbr", tenant: "kbr", wdN: 5, site: "KBR_Careers" },
  { company: "Parsons", slug: "parsons", tenant: "parsons", wdN: 5, site: "Search" },
  { company: "Northrop Grumman", slug: "northrop", tenant: "ngc", wdN: 1, site: "Northrop_Grumman_External_Site" },
] as const;
