import { describe, expect, it } from "vitest";
import { fetchWorkday } from "../../src/adapters/workday";
import type { Deps } from "../../src/util/deps";
import { defaultClock } from "../../src/util/now";
import { PerKeyThrottle } from "../../src/util/rate-limit";
import list from "../fixtures/workday/leidos-list.json" with { type: "json" };
import detail from "../fixtures/workday/leidos-detail.json" with { type: "json" };
import { jsonResponse, makeFetchStub, silentLogger } from "../helpers/fetch-stub";

const TARGET = {
  company: "Leidos",
  slug: "leidos",
  tenant: "leidos",
  wdN: 5,
  site: "External",
};

function deps(): Deps {
  return {
    fetch: makeFetchStub({
      "https://leidos.wd5.myworkdayjobs.com/wday/cxs/leidos/External/jobs": () =>
        jsonResponse(list),
      "https://leidos.wd5.myworkdayjobs.com/wday/cxs/leidos/External/job/": () =>
        jsonResponse(detail),
    }),
    clock: defaultClock,
    logger: silentLogger(),
  };
}

// Zero-interval throttle so tests don't actually sleep 1s per request.
const fastThrottle = new PerKeyThrottle(0);

describe("workday adapter", () => {
  it("yields one Job per posting with description from the detail fetch", async () => {
    const out = [];
    for await (const j of fetchWorkday(
      { target: TARGET, throttle: fastThrottle },
      deps(),
    )) out.push(j);
    expect(out).toHaveLength(2);
    expect(out[0]?.description_html).toContain("Build systems");
  });

  it("tags source as workday:<slug>", async () => {
    const out = [];
    for await (const j of fetchWorkday(
      { target: TARGET, throttle: fastThrottle },
      deps(),
    )) out.push(j);
    expect(out[0]?.source).toBe("workday:leidos");
  });

  it("detects 'Secret' clearance in description", async () => {
    const out = [];
    for await (const j of fetchWorkday(
      { target: TARGET, throttle: fastThrottle },
      deps(),
    )) out.push(j);
    expect(out[0]?.clearance).toBe("secret");
  });

  it("detects TS/SCI from title when present", async () => {
    const out = [];
    for await (const j of fetchWorkday(
      { target: TARGET, throttle: fastThrottle },
      deps(),
    )) out.push(j);
    expect(out[1]?.clearance).toBe("ts_sci");
  });

  it("derives remote=true from 'Remote - US' location", async () => {
    const out = [];
    for await (const j of fetchWorkday(
      { target: TARGET, throttle: fastThrottle },
      deps(),
    )) out.push(j);
    expect(out[1]?.remote).toBe(true);
    expect(out[0]?.remote).toBeNull();
  });

  it("POSTs the list with the expected JSON body", async () => {
    let listBody: unknown = null;
    const customDeps: Deps = {
      fetch: makeFetchStub({
        "https://leidos.wd5.myworkdayjobs.com/wday/cxs/leidos/External/jobs": async (req) => {
          listBody = await req.json();
          return jsonResponse(list);
        },
        "https://leidos.wd5.myworkdayjobs.com/wday/cxs/leidos/External/job/": () =>
          jsonResponse(detail),
      }),
      clock: defaultClock,
      logger: silentLogger(),
    };
    for await (const _ of fetchWorkday(
      { target: TARGET, throttle: fastThrottle },
      customDeps,
    )) void _;
    expect(listBody).toMatchObject({ appliedFacets: {}, offset: 0 });
  });
});
