import { describe, expect, it } from "vitest";
import { fetchHimalayas } from "../../src/adapters/himalayas";
import type { Deps } from "../../src/util/deps";
import { defaultClock } from "../../src/util/now";
import fixture from "../fixtures/himalayas/page0.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://himalayas.app/jobs/api/search": (req) => {
        const offset = new URL(req.url).searchParams.get("offset");
        if (offset === "0") return jsonResponse(fixture);
        return jsonResponse({ totalCount: 2, offset: 100, limit: 100, jobs: [] });
      },
    }),
    clock: defaultClock,
    logger: silentLogger(),
  };
}

describe("himalayas adapter", () => {
  it("maps companyName + title + employmentType", async () => {
    const out = [];
    for await (const j of fetchHimalayas({}, deps())) out.push(j);
    expect(out).toHaveLength(2);
    expect(out[0]?.company).toBe("Acme Remote");
    expect(out[0]?.employment_type).toBe("full_time");
    expect(out[1]?.employment_type).toBe("intern");
  });

  it("always flags remote=true", async () => {
    const out = [];
    for await (const j of fetchHimalayas({}, deps())) out.push(j);
    expect(out.every((j) => j.remote === true)).toBe(true);
  });

  it("joins locationRestrictions with commas", async () => {
    const out = [];
    for await (const j of fetchHimalayas({}, deps())) out.push(j);
    expect(out[0]?.location).toBe("Worldwide");
    expect(out[1]?.location).toBe("US, Canada");
  });

  it("converts pubDate seconds to ISO posted_at", async () => {
    const out = [];
    for await (const j of fetchHimalayas({}, deps())) out.push(j);
    expect(out[0]?.posted_at).toBe(new Date(1776700000 * 1000).toISOString());
  });

  it("strips HTML from description_text", async () => {
    const out = [];
    for await (const j of fetchHimalayas({}, deps())) out.push(j);
    expect(out[0]?.description_text).toContain("Build platform infra");
    expect(out[0]?.description_text).not.toContain("<p>");
  });

  it("tags source as himalayas", async () => {
    const out = [];
    for await (const j of fetchHimalayas({}, deps())) out.push(j);
    expect(out[0]?.source).toBe("himalayas");
  });
});
