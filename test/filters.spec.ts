import { describe, expect, it } from "vitest";
import { shouldAccept } from "../src/config/filters";
import type { Job } from "../src/normalize";

function job(overrides: Partial<Job> = {}): Job {
  return {
    source: "greenhouse:test",
    external_id: "1",
    company: "TestCo",
    title: "Software Engineer",
    location: "Austin, TX",
    remote: false,
    employment_type: "full_time",
    department: null,
    description_html: null,
    description_text: "3+ years experience preferred.",
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    clearance: null,
    apply_url: "https://example.com",
    posted_at: null,
    ...overrides,
  };
}

describe("filters.shouldAccept", () => {
  it("accepts a plain Software Engineer in Austin with no clearance", () => {
    expect(shouldAccept(job()).accept).toBe(true);
  });

  it("rejects leadership titles (Director, VP, Head of)", () => {
    expect(shouldAccept(job({ title: "Director of Engineering" })).accept).toBe(false);
    expect(shouldAccept(job({ title: "VP, Platform" })).accept).toBe(false);
    expect(shouldAccept(job({ title: "Head of Infrastructure" })).accept).toBe(false);
  });

  it("rejects Staff/Principal unless the user opts back in", () => {
    expect(shouldAccept(job({ title: "Staff Software Engineer" })).accept).toBe(false);
    expect(shouldAccept(job({ title: "Principal Engineer" })).accept).toBe(false);
  });

  it("rejects titles without an include keyword", () => {
    const r = shouldAccept(job({ title: "Marketing Manager" }));
    expect(r.accept).toBe(false);
  });

  it.each([
    "Python Developer",
    "Junior Application Developer",
    "AI Automation Engineer",
    "Prompt Engineer",
    "Artificial Intelligence Engineer",
    "Agentic AI Developer",
    "GenAi Application Developer",
    "MLOps Engineer",
    "Quality Engineer",
    "Forward Deployed Engineer",
  ])("accepts %s", (title) => {
    expect(shouldAccept(job({ title })).accept).toBe(true);
  });

  it("rejects consultancy churn companies", () => {
    expect(shouldAccept(job({ company: "Revature" })).accept).toBe(false);
    expect(shouldAccept(job({ company: "Smoothstack" })).accept).toBe(false);
  });

  it("accepts remote postings regardless of location", () => {
    const r = shouldAccept(job({ location: "New York, NY", remote: true }));
    expect(r.accept).toBe(true);
  });

  it("rejects locations that are neither remote nor in the include list", () => {
    const r = shouldAccept(job({ location: "Paris, France", remote: false }));
    expect(r.accept).toBe(false);
    expect(r.reason).toContain("location");
  });

  it("accepts DC metro locations (Arlington, McLean)", () => {
    expect(shouldAccept(job({ location: "Arlington, VA" })).accept).toBe(true);
    expect(shouldAccept(job({ location: "McLean, VA" })).accept).toBe(true);
  });

  it("rejects TS/SCI clearance by default", () => {
    const r = shouldAccept(job({ clearance: "ts_sci" }));
    expect(r.accept).toBe(false);
    expect(r.reason).toContain("clearance");
  });

  it("accepts Secret clearance", () => {
    expect(shouldAccept(job({ clearance: "secret" })).accept).toBe(true);
  });

  it("rejects postings that require more years than threshold", () => {
    const r = shouldAccept(job({ description_text: "10+ years of backend experience required." }));
    expect(r.accept).toBe(false);
    expect(r.reason).toMatch(/years:/);
  });

  it("accepts postings with no years-of-experience mentioned", () => {
    expect(shouldAccept(job({ description_text: null })).accept).toBe(true);
  });
});
