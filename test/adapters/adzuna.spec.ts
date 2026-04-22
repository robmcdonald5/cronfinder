import { describe, expect, it } from "vitest";
import { fetchAdzuna } from "../../src/adapters/adzuna";
import type { Deps } from "../../src/util/deps";
import fixture from "../fixtures/adzuna/page1.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

const CREDS = { appId: "APP", appKey: "KEY" };

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://api.adzuna.com/v1/api/jobs/us/search/1": () => jsonResponse(fixture),
      // Second page returns empty so the adapter stops.
      "https://api.adzuna.com/v1/api/jobs/us/search/2": () =>
        jsonResponse({ count: 0, results: [] }),
    }),
    logger: silentLogger(),
  };
}

describe("adzuna adapter", () => {
  it("yields one Job per result", async () => {
    const out = [];
    for await (const j of fetchAdzuna(CREDS, deps())) out.push(j);
    expect(out).toHaveLength(3);
  });

  it("tags source as adzuna", async () => {
    const out = [];
    for await (const j of fetchAdzuna(CREDS, deps())) out.push(j);
    expect(out.every((j) => j.source === "adzuna")).toBe(true);
  });

  it("passes through real salary ranges as USD", async () => {
    const out = [];
    for await (const j of fetchAdzuna(CREDS, deps())) out.push(j);
    const stripe = out.find((j) => j.external_id === "4895673210");
    expect(stripe?.salary_min).toBe(180000);
    expect(stripe?.salary_max).toBe(250000);
    expect(stripe?.salary_currency).toBe("USD");
  });

  it("drops salary when salary_is_predicted is truthy", async () => {
    const out = [];
    for await (const j of fetchAdzuna(CREDS, deps())) out.push(j);
    const predicted = out.find((j) => j.external_id === "4895673211");
    expect(predicted?.salary_min).toBeNull();
    expect(predicted?.salary_max).toBeNull();
    expect(predicted?.salary_currency).toBeNull();
  });

  it("maps contract_time to employment_type", async () => {
    const out = [];
    for await (const j of fetchAdzuna(CREDS, deps())) out.push(j);
    expect(out.find((j) => j.external_id === "4895673210")?.employment_type).toBe("full_time");
    expect(out.find((j) => j.external_id === "4895673212")?.employment_type).toBe("intern");
  });

  it("uses redirect_url as apply_url and sets posted_at from created", async () => {
    const out = [];
    for await (const j of fetchAdzuna(CREDS, deps())) out.push(j);
    const stripe = out.find((j) => j.external_id === "4895673210");
    expect(stripe?.apply_url).toBe("https://www.adzuna.com/land/ad/4895673210?se=abc");
    expect(stripe?.posted_at).toBe("2026-04-21T12:00:00Z");
  });

  it("sends app_id, app_key, what, and results_per_page", async () => {
    const seen: Record<string, string | null> = {};
    const capturingDeps: Deps = {
      fetch: makeFetchStub({
        "https://api.adzuna.com/v1/api/jobs/us/search/1": (req) => {
          const u = new URL(req.url);
          seen.app_id = u.searchParams.get("app_id");
          seen.app_key = u.searchParams.get("app_key");
          seen.what = u.searchParams.get("what");
          seen.per = u.searchParams.get("results_per_page");
          return jsonResponse(fixture);
        },
      }),
      logger: silentLogger(),
    };
    for await (const _ of fetchAdzuna({ ...CREDS, maxPages: 1 }, capturingDeps)) void _;
    expect(seen).toMatchObject({
      app_id: "APP",
      app_key: "KEY",
      what: "software",
      per: "50",
    });
  });

  it("stops paginating when a page returns fewer results than requested", async () => {
    let pages = 0;
    const countingDeps: Deps = {
      fetch: makeFetchStub({
        "https://api.adzuna.com/v1/api/jobs/us/search/": () => {
          pages++;
          return jsonResponse(fixture);  // 3 results, perPage defaults to 50
        },
      }),
      logger: silentLogger(),
    };
    for await (const _ of fetchAdzuna(CREDS, countingDeps)) void _;
    expect(pages).toBe(1);
  });

  it("skips rows with no company name", async () => {
    const shapeless = {
      count: 1,
      results: [
        {
          id: "no-company",
          title: "Ghost Job",
          company: {},
          location: { display_name: "Nowhere, USA" },
          redirect_url: "https://example.com",
        },
      ],
    };
    const d: Deps = {
      fetch: makeFetchStub({
        "https://api.adzuna.com/v1/api/jobs/us/search/1": () => jsonResponse(shapeless),
        "https://api.adzuna.com/v1/api/jobs/us/search/": () =>
          jsonResponse({ count: 0, results: [] }),
      }),
      logger: silentLogger(),
    };
    const out = [];
    for await (const j of fetchAdzuna({ ...CREDS, maxPages: 1 }, d)) out.push(j);
    expect(out).toHaveLength(0);
  });
});
