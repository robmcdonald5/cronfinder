import { describe, expect, it } from "vitest";
import { fetchEightfold } from "../../src/adapters/eightfold";
import type { Deps } from "../../src/util/deps";
import { defaultClock } from "../../src/util/now";
import fixture from "../fixtures/eightfold/ngc.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

const TARGET = {
  company: "Northrop Grumman",
  slug: "northrop",
  host: "jobs.northropgrumman.com",
  domain: "ngc.com",
};

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://jobs.northropgrumman.com/api/apply/v2/jobs": (req) => {
        const start = new URL(req.url).searchParams.get("start");
        if (start === "0") return jsonResponse(fixture);
        return jsonResponse({ count: 2, positions: [] });
      },
    }),
    clock: defaultClock,
    logger: silentLogger(),
  };
}

describe("eightfold adapter", () => {
  it("yields a Job per position", async () => {
    const out = [];
    for await (const j of fetchEightfold({ target: TARGET }, deps())) out.push(j);
    expect(out).toHaveLength(2);
  });

  it("maps work_location_option to remote flag", async () => {
    const out = [];
    for await (const j of fetchEightfold({ target: TARGET }, deps())) out.push(j);
    expect(out[0]?.remote).toBe(false);
    expect(out[1]?.remote).toBe(true);
  });

  it("detects Top Secret clearance", async () => {
    const out = [];
    for await (const j of fetchEightfold({ target: TARGET }, deps())) out.push(j);
    expect(out[0]?.clearance).toBe("top_secret");
  });

  it("tags source eightfold:<slug>", async () => {
    const out = [];
    for await (const j of fetchEightfold({ target: TARGET }, deps())) out.push(j);
    expect(out[0]?.source).toBe("eightfold:northrop");
  });

  it("stops when a page returns fewer than perPage postings", async () => {
    // fixture has 2 postings; perPage=50 default; first page is short → stop.
    let pages = 0;
    const countingDeps: Deps = {
      fetch: makeFetchStub({
        "https://jobs.northropgrumman.com/api/apply/v2/jobs": () => {
          pages++;
          return jsonResponse(fixture);
        },
      }),
      clock: defaultClock,
      logger: silentLogger(),
    };
    for await (const _ of fetchEightfold({ target: TARGET }, countingDeps)) void _;
    expect(pages).toBe(1);
  });
});
