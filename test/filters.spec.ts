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

  it("rejects locations that are neither remote nor in the US", () => {
    expect(shouldAccept(job({ location: "Paris, France", remote: false })).accept).toBe(false);
    expect(shouldAccept(job({ location: "London, UK", remote: false })).accept).toBe(false);
    expect(shouldAccept(job({ location: "Toronto, ON", remote: false })).accept).toBe(false);
    expect(shouldAccept(job({ location: "Bangalore, India", remote: false })).accept).toBe(false);
  });

  it.each([
    "San Francisco, CA",
    "Orlando, FL",
    "Pittsburgh, PA",
    "Portland, OR",
    "Cincinnati, OH",
    "Seattle, WA",
    "Chicago, IL",
    "Arlington, VA",
    "McLean, VA",
    "US-VA-Chantilly",
    "Remote - US",
    "United States",
    "Anywhere in USA",
  ])("accepts US location %s", (location) => {
    expect(shouldAccept(job({ location, remote: false })).accept).toBe(true);
  });

  it("rejects jobs that explicitly require local candidates", () => {
    const local = shouldAccept(job({
      location: "Austin, TX",
      description_text: "Local candidates only — we do not sponsor relocation.",
    }));
    expect(local.accept).toBe(false);
    expect(local.reason).toBe("local_only");

    const noRemote = shouldAccept(job({
      location: "San Francisco, CA",
      description_text: "This role is on-site; no remote candidates will be considered.",
    }));
    expect(noRemote.accept).toBe(false);
    expect(noRemote.reason).toBe("local_only");
  });

  it("accepts jobs that merely decline relocation assistance (ambiguous)", () => {
    const r = shouldAccept(job({
      location: "Austin, TX",
      description_text: "Relocation assistance is not provided.",
    }));
    expect(r.accept).toBe(true);
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
