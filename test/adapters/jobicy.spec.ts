import { describe, expect, it } from "vitest";
import { fetchJobicy } from "../../src/adapters/jobicy";
import type { Deps } from "../../src/util/deps";
import fixture from "../fixtures/jobicy/usa.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://jobicy.com/api/v2/remote-jobs": () => jsonResponse(fixture),
    }),
    logger: silentLogger(),
  };
}

describe("jobicy adapter", () => {
  it("yields a Job for every posting in the response", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out).toHaveLength(3);
  });

  it("maps jobTitle → title, companyName → company, url → apply_url", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out[0]?.title).toBe("Senior Software Engineer");
    expect(out[0]?.company).toBe("Acme");
    expect(out[0]?.apply_url).toContain("jobicy.com");
  });

  it("always flags remote=true", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out.every((j) => j.remote === true)).toBe(true);
  });

  it("parses employment_type from jobType", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out[0]?.employment_type).toBe("full_time");
    expect(out[1]?.employment_type).toBe("contract");
    expect(out[2]?.employment_type).toBe("part_time");
  });

  it("strips HTML for description_text", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out[0]?.description_text).toBe("We need a strong Python dev.");
    expect(out[0]?.description_html).toContain("<p>");
  });

  it("passes salary + currency through when present", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out[0]?.salary_min).toBe(140000);
    expect(out[0]?.salary_max).toBe(200000);
    expect(out[0]?.salary_currency).toBe("USD");
    expect(out[1]?.salary_min).toBeNull();
  });

  it("tags source as jobicy", async () => {
    const out = [];
    for await (const j of fetchJobicy({}, deps())) out.push(j);
    expect(out.every((j) => j.source === "jobicy")).toBe(true);
  });
});
