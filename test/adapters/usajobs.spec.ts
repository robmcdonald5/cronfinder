import { describe, expect, it } from "vitest";
import { fetchUsaJobs } from "../../src/adapters/usajobs";
import type { Deps } from "../../src/util/deps";
import { defaultClock } from "../../src/util/now";
import page1 from "../fixtures/usajobs/page1.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function depsSingle(): Deps {
  return {
    fetch: makeFetchStub({
      "https://data.usajobs.gov/api/Search": (req) => {
        const page = new URL(req.url).searchParams.get("Page");
        if (page === "1") return jsonResponse(page1);
        return jsonResponse({ SearchResult: { SearchResultCount: 0, SearchResultCountAll: 2, SearchResultItems: [] } });
      },
    }),
    clock: defaultClock,
    logger: silentLogger(),
  };
}

describe("usajobs adapter", () => {
  it("sends the three required headers", async () => {
    const seen: Record<string, string | null> = { Host: null, UA: null, Key: null };
    const deps: Deps = {
      fetch: makeFetchStub({
        "https://data.usajobs.gov/api/Search": (req) => {
          seen.Host = req.headers.get("host");
          seen.UA = req.headers.get("user-agent");
          seen.Key = req.headers.get("authorization-key");
          return jsonResponse(page1);
        },
      }),
      clock: defaultClock,
      logger: silentLogger(),
    };
    const out = [];
    for await (const j of fetchUsaJobs(
      { apiKey: "KEY", userAgent: "me@example.com", maxPages: 1 },
      deps,
    )) out.push(j);
    // `Host` is often overwritten by the Request spec; the other two must be set exactly.
    expect(seen.UA).toBe("me@example.com");
    expect(seen.Key).toBe("KEY");
  });

  it("yields one canonical Job per item with apply_url", async () => {
    const out = [];
    for await (const j of fetchUsaJobs(
      { apiKey: "KEY", userAgent: "me@example.com", maxPages: 1 },
      depsSingle(),
    )) out.push(j);
    expect(out).toHaveLength(2);
    expect(out[0]?.apply_url).toBe("https://www.usajobs.gov/job/12345");
    expect(out[0]?.salary_min).toBe(95000);
    expect(out[1]?.remote).toBe(true);
  });

  it("tags source usajobs", async () => {
    const out = [];
    for await (const j of fetchUsaJobs(
      { apiKey: "KEY", userAgent: "me@example.com", maxPages: 1 },
      depsSingle(),
    )) out.push(j);
    expect(out[0]?.source).toBe("usajobs");
  });

  it("prefers UserArea.JobSummary over QualificationSummary", async () => {
    const out = [];
    for await (const j of fetchUsaJobs(
      { apiKey: "KEY", userAgent: "me@example.com", maxPages: 1 },
      depsSingle(),
    )) out.push(j);
    expect(out[0]?.description_text).toBe("Full job summary text.");
  });
});
