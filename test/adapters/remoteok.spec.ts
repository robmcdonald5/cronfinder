import { describe, expect, it } from "vitest";
import { fetchRemoteOk } from "../../src/adapters/remoteok";
import type { Deps } from "../../src/util/deps";
import fixture from "../fixtures/remoteok/page0.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://remoteok.com/api": () => jsonResponse(fixture),
    }),
    logger: silentLogger(),
  };
}

describe("remoteok adapter", () => {
  it("skips the legal/metadata wrapper at index 0", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    // fixture has 3 job rows after metadata, but the third has no apply URL
    // and should be skipped, leaving 2.
    expect(out).toHaveLength(2);
    expect(out[0]?.company).toBe("Acme Remote");
  });

  it("maps position→title, company, external_id", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out[0]?.title).toBe("Software Engineer");
    expect(out[0]?.external_id).toBe("1000001");
  });

  it("always flags remote=true", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out.every((j) => j.remote === true)).toBe(true);
  });

  it("nulls zero salaries and stamps USD when salary present", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out[0]?.salary_min).toBe(120000);
    expect(out[0]?.salary_currency).toBe("USD");
    expect(out[1]?.salary_min).toBeNull();
    expect(out[1]?.salary_max).toBeNull();
    expect(out[1]?.salary_currency).toBeNull();
  });

  it("skips postings without apply_url or url", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out.find((j) => j.company === "NoLinkCo")).toBeUndefined();
  });

  it("uses date when present, falls back to epoch", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out[0]?.posted_at).toBe("2026-04-22T16:00:00+00:00");
  });

  it("tags source as remoteok", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out.every((j) => j.source === "remoteok")).toBe(true);
  });

  it("treats empty location as null", async () => {
    const out = [];
    for await (const j of fetchRemoteOk({}, deps())) out.push(j);
    expect(out[1]?.location).toBeNull();
  });
});
