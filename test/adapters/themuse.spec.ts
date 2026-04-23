import { describe, expect, it } from "vitest";
import { fetchMuse } from "../../src/adapters/themuse";
import type { Deps } from "../../src/util/deps";
import swePage from "../fixtures/themuse/software-engineering-page0.json" with { type: "json" };
import dataPage from "../fixtures/themuse/data-analytics-page0.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://www.themuse.com/api/public/jobs": (req) => {
        const u = new URL(req.url);
        const category = u.searchParams.get("category");
        const page = u.searchParams.get("page");
        if (category === "Software Engineering" && page === "0") return jsonResponse(swePage);
        if (category === "Data and Analytics" && page === "0") return jsonResponse(dataPage);
        return jsonResponse({ page: 0, page_count: 0, items_per_page: 20, total: 0, results: [] });
      },
    }),
    logger: silentLogger(),
  };
}

describe("themuse adapter", () => {
  it("fetches each category and stops early when < 20 results", async () => {
    const out = [];
    for await (const j of fetchMuse(
      { categories: ["Software Engineering", "Data and Analytics"], maxPages: 3 },
      deps(),
    )) out.push(j);
    // SWE page0: 3 rows (1 skipped for missing apply), Data page0: 2 rows (1 duplicate id)
    // → 2 unique SWE + 1 new Data = 3 total
    expect(out).toHaveLength(3);
  });

  it("dedupes jobs that appear under multiple categories", async () => {
    const out = [];
    for await (const j of fetchMuse(
      { categories: ["Software Engineering", "Data and Analytics"], maxPages: 3 },
      deps(),
    )) out.push(j);
    const ids = out.map((j) => j.external_id);
    expect(new Set(ids).size).toBe(ids.length);
    // Beta Labs appears in both categories; should only yield once.
    const beta = out.filter((j) => j.company === "Beta Labs");
    expect(beta).toHaveLength(1);
  });

  it("maps company.name, name→title, landing_page→apply_url", async () => {
    const out = [];
    for await (const j of fetchMuse({ categories: ["Software Engineering"], maxPages: 1 }, deps()))
      out.push(j);
    expect(out[0]?.company).toBe("Acme Corp");
    expect(out[0]?.title).toBe("Senior Software Engineer");
    expect(out[0]?.apply_url).toContain("themuse.com/jobs/acme");
  });

  it("flags remote=true for 'Flexible / Remote' locations", async () => {
    const out = [];
    for await (const j of fetchMuse({ categories: ["Software Engineering"], maxPages: 1 }, deps()))
      out.push(j);
    const remote = out.find((j) => j.title === "Backend Engineer");
    expect(remote?.remote).toBe(true);
  });

  it("strips HTML for description_text, preserves raw in description_html", async () => {
    const out = [];
    for await (const j of fetchMuse({ categories: ["Software Engineering"], maxPages: 1 }, deps()))
      out.push(j);
    expect(out[0]?.description_html).toContain("<p>");
    expect(out[0]?.description_text).toBe("Build distributed systems on Python and Go.");
  });

  it("skips rows without apply_url or company", async () => {
    const out = [];
    for await (const j of fetchMuse({ categories: ["Software Engineering"], maxPages: 1 }, deps()))
      out.push(j);
    expect(out.find((j) => j.title?.includes("no apply link"))).toBeUndefined();
  });

  it("tags source as themuse", async () => {
    const out = [];
    for await (const j of fetchMuse({ categories: ["Software Engineering"], maxPages: 1 }, deps()))
      out.push(j);
    expect(out.every((j) => j.source === "themuse")).toBe(true);
  });
});
