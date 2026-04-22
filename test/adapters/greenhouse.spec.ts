import { describe, expect, it } from "vitest";
import { fetchGreenhouse } from "../../src/adapters/greenhouse";
import type { Deps } from "../../src/util/deps";
import fixture from "../fixtures/greenhouse/stripe.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://boards-api.greenhouse.io/v1/boards/stripe/jobs": () =>
        jsonResponse(fixture),
    }),
    logger: silentLogger(),
  };
}

describe("greenhouse adapter", () => {
  it("yields one canonical Job per posting", async () => {
    const out = [];
    for await (const j of fetchGreenhouse("stripe", deps())) out.push(j);
    expect(out).toHaveLength(2);
  });

  it("maps salary cents to dollars and currency", async () => {
    const jobs = [];
    for await (const j of fetchGreenhouse("stripe", deps())) jobs.push(j);
    expect(jobs[0]?.salary_min).toBe(180000);
    expect(jobs[0]?.salary_max).toBe(240000);
    expect(jobs[0]?.salary_currency).toBe("USD");
  });

  it("derives remote flag from location text", async () => {
    const jobs = [];
    for await (const j of fetchGreenhouse("stripe", deps())) jobs.push(j);
    expect(jobs[1]?.remote).toBe(true);
  });

  it("strips HTML from description_text but preserves HTML", async () => {
    const jobs = [];
    for await (const j of fetchGreenhouse("stripe", deps())) jobs.push(j);
    expect(jobs[0]?.description_html).toContain("<p>");
    expect(jobs[0]?.description_text).not.toContain("<p>");
    expect(jobs[0]?.description_text).toContain("Build payments");
  });

  it("propagates HTTP error as a thrown Error", async () => {
    const failing: Deps = {
      fetch: makeFetchStub({
        "https://boards-api.greenhouse.io/v1/boards/stripe": () =>
          new Response("not found", { status: 404 }),
      }),
      logger: silentLogger(),
    };
    await expect(async () => {
      for await (const _ of fetchGreenhouse("stripe", failing)) void _;
    }).rejects.toThrow(/HTTP 404/);
  });

  it("uses the source tag greenhouse:<token>", async () => {
    const jobs = [];
    for await (const j of fetchGreenhouse("stripe", deps())) jobs.push(j);
    expect(jobs[0]?.source).toBe("greenhouse:stripe");
  });
});
