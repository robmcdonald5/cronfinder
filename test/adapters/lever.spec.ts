import { describe, expect, it } from "vitest";
import { fetchLever } from "../../src/adapters/lever";
import type { Deps } from "../../src/util/deps";
import { defaultClock } from "../../src/util/now";
import fixture from "../fixtures/lever/notion.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://api.lever.co/v0/postings/notion": () => jsonResponse(fixture),
    }),
    clock: defaultClock,
    logger: silentLogger(),
  };
}

describe("lever adapter", () => {
  it("maps workplaceType to remote boolean", async () => {
    const jobs = [];
    for await (const j of fetchLever("notion", deps())) jobs.push(j);
    expect(jobs[0]?.remote).toBe(true);
    expect(jobs[1]?.remote).toBe(false);
  });

  it("maps commitment to employment_type", async () => {
    const jobs = [];
    for await (const j of fetchLever("notion", deps())) jobs.push(j);
    expect(jobs[0]?.employment_type).toBe("full_time");
    expect(jobs[1]?.employment_type).toBe("intern");
  });

  it("converts createdAt ms to ISO posted_at", async () => {
    const jobs = [];
    for await (const j of fetchLever("notion", deps())) jobs.push(j);
    expect(jobs[0]?.posted_at).toBe("2024-04-19T04:13:20.000Z");
  });

  it("falls back to hostedUrl when applyUrl is missing", async () => {
    const jobs = [];
    for await (const j of fetchLever("notion", deps())) jobs.push(j);
    expect(jobs[1]?.apply_url).toBe("https://jobs.lever.co/notion/xyz-789");
  });
});
