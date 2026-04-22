import { describe, expect, it } from "vitest";
import { fetchAshby } from "../../src/adapters/ashby";
import type { Deps } from "../../src/util/deps";
import { defaultClock } from "../../src/util/now";
import fixture from "../fixtures/ashby/openai.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://api.ashbyhq.com/posting-api/job-board/openai": () => jsonResponse(fixture),
    }),
    clock: defaultClock,
    logger: silentLogger(),
  };
}

describe("ashby adapter", () => {
  it("emits only listed jobs", async () => {
    const jobs = [];
    for await (const j of fetchAshby("openai", deps())) jobs.push(j);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.external_id).toBe("6f1e8b00-1234-5678-9abc-def012345678");
  });

  it("maps compensation tier", async () => {
    const jobs = [];
    for await (const j of fetchAshby("openai", deps())) jobs.push(j);
    expect(jobs[0]?.salary_min).toBe(300000);
    expect(jobs[0]?.salary_max).toBe(500000);
    expect(jobs[0]?.salary_currency).toBe("USD");
  });

  it("carries Ashby isRemote through", async () => {
    const jobs = [];
    for await (const j of fetchAshby("openai", deps())) jobs.push(j);
    expect(jobs[0]?.remote).toBe(false);
  });

  it("tags source ashby:<org>", async () => {
    const jobs = [];
    for await (const j of fetchAshby("openai", deps())) jobs.push(j);
    expect(jobs[0]?.source).toBe("ashby:openai");
  });
});
