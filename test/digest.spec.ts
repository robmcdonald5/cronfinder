import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/digest";

type Row = Parameters<typeof renderMarkdown>[0][number];

const SAMPLE: Row[] = [
  {
    source: "greenhouse:anthropic",
    company: "Anthropic",
    title: "Research Engineer, Alignment",
    location: "San Francisco, CA",
    remote: 0,
    clearance: null,
    salary_min: 300000,
    salary_max: 500000,
    salary_currency: "USD",
    apply_url: "https://job-boards.greenhouse.io/anthropic/jobs/1",
    first_seen_at: "2026-04-21T12:00:00Z",
    description_text: "Build Claude. 3+ years experience.",
  },
  {
    source: "workday:rtx",
    company: "RTX",
    title: "Principal Embedded Software Engineer",
    location: "Columbia, MD",
    remote: null,
    clearance: "secret",
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    apply_url: "https://globalhr.wd5.myworkdayjobs.com/...",
    first_seen_at: "2026-04-21T13:00:00Z",
    description_text: null,
  },
  {
    source: "usajobs",
    company: "Department of Defense",
    title: "IT Specialist (SYSADMIN)",
    location: "Colorado Springs, CO",
    remote: 0,
    clearance: null,
    salary_min: 95000,
    salary_max: 125000,
    salary_currency: "USD",
    apply_url: "https://www.usajobs.gov/job/12345",
    first_seen_at: "2026-04-21T14:00:00Z",
    description_text: null,
  },
];

describe("digest renderMarkdown", () => {
  it("renders an empty digest when no rows", () => {
    const md = renderMarkdown([], "2026-04-20T23:07:00Z", "2026-04-21T23:07:00Z");
    expect(md).toContain("# New jobs — 2026-04-21");
    expect(md).toContain("**0 new postings**");
    expect(md).toContain("_No new postings");
  });

  it("buckets jobs into the right categories", () => {
    const md = renderMarkdown(SAMPLE, "2026-04-20T23:07:00Z", "2026-04-21T23:07:00Z");
    expect(md).toContain("## Defense / Government Contractors (1)");
    expect(md).toContain("## Federal (1)");
    expect(md).toContain("## Big Tech + Commercial (1)");
  });

  it("includes apply link, location, salary, and clearance in a job line", () => {
    const md = renderMarkdown(SAMPLE, "2026-04-20T23:07:00Z", "2026-04-21T23:07:00Z");
    expect(md).toContain("[Research Engineer, Alignment](https://job-boards.greenhouse.io/anthropic/jobs/1)");
    expect(md).toContain("San Francisco, CA");
    expect(md).toContain("300k–500k USD");
    expect(md).toContain("secret");
  });

  it("puts the date in the title from windowEndIso", () => {
    const md = renderMarkdown([], "2026-04-20T23:07:00Z", "2026-05-01T12:00:00Z");
    expect(md).toContain("# New jobs — 2026-05-01");
  });

  it("groups multiple jobs from the same company", () => {
    const two: Row[] = [SAMPLE[0]!, { ...SAMPLE[0]!, title: "Research Engineer, Scaling" }];
    const md = renderMarkdown(two, "2026-04-20T23:07:00Z", "2026-04-21T23:07:00Z");
    expect(md).toContain("### Anthropic — 2 new");
  });
});
