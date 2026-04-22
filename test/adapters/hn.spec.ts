import { describe, expect, it } from "vitest";
import { fetchHn } from "../../src/adapters/hn";
import type { Deps } from "../../src/util/deps";
import search from "../fixtures/hn/search.json" with { type: "json" };
import items from "../fixtures/hn/items.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://hn.algolia.com/api/v1/search_by_date": () => jsonResponse(search),
      "https://hn.algolia.com/api/v1/items/47601859": () => jsonResponse(items),
    }),
    logger: silentLogger(),
  };
}

describe("hn adapter", () => {
  it("picks the latest 'Who is hiring?' thread (not 'Who wants to be hired')", async () => {
    const out = [];
    for await (const j of fetchHn({}, deps())) out.push(j);
    // All emitted jobs should be sourced from the April 2026 hiring thread.
    expect(out.every((j) => j.source === "hn:47601859")).toBe(true);
  });

  it("extracts company from pipe-separated first line", async () => {
    const out = [];
    for await (const j of fetchHn({}, deps())) out.push(j);
    const acme = out.find((j) => j.external_id === "47601901");
    expect(acme?.company).toBe("Acme Corp");
    const beta = out.find((j) => j.external_id === "47601903");
    expect(beta?.company).toBe("Beta Labs");
  });

  it("pulls apply URL from the first href in the comment text", async () => {
    const out = [];
    for await (const j of fetchHn({}, deps())) out.push(j);
    const acme = out.find((j) => j.external_id === "47601901");
    expect(acme?.apply_url).toBe("https://acme.example.com/jobs/swe");
  });

  it("flags remote=true when REMOTE appears in the post", async () => {
    const out = [];
    for await (const j of fetchHn({}, deps())) out.push(j);
    const acme = out.find((j) => j.external_id === "47601901");
    expect(acme?.remote).toBe(true);
    const beta = out.find((j) => j.external_id === "47601903");
    expect(beta?.remote).toBe(false);
  });

  it("skips comments that don't look like job posts", async () => {
    const out = [];
    for await (const j of fetchHn({}, deps())) out.push(j);
    // The reply-only comment (id 47601902) should be skipped.
    expect(out.find((j) => j.external_id === "47601902")).toBeUndefined();
  });
});
