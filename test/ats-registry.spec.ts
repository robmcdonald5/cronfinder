import { describe, expect, it } from "vitest";
import { computeHealthUpdate } from "../src/ats-registry";

describe("computeHealthUpdate", () => {
  it("resets consecutive_failures on a successful run", () => {
    const next = computeHealthUpdate(
      { consecutive_failures: 3 },
      { jobsFetched: 12, errored: false },
    );
    expect(next.consecutive_failures).toBe(0);
    expect(next.status).toBe("active");
  });

  it("increments consecutive_failures on an errored run", () => {
    const next = computeHealthUpdate(
      { consecutive_failures: 2 },
      { jobsFetched: 0, errored: true },
    );
    expect(next.consecutive_failures).toBe(3);
    expect(next.status).toBe("active");
  });

  it("transitions to dead after 5 consecutive failures", () => {
    const next = computeHealthUpdate(
      { consecutive_failures: 4 },
      { jobsFetched: 0, errored: true },
    );
    expect(next.consecutive_failures).toBe(5);
    expect(next.status).toBe("dead");
  });

  it("keeps a tenant active when it returns 0 jobs but didn't error", () => {
    // A company with an empty board (like ManTech today) should not be
    // retired just because the upstream is quiet.
    const next = computeHealthUpdate(
      { consecutive_failures: 0 },
      { jobsFetched: 0, errored: false },
    );
    expect(next.status).toBe("active");
    expect(next.consecutive_failures).toBe(0);
  });

  it("any successful run before the threshold resets the failure count", () => {
    const next = computeHealthUpdate(
      { consecutive_failures: 4 },
      { jobsFetched: 15, errored: false },
    );
    expect(next.consecutive_failures).toBe(0);
    expect(next.status).toBe("active");
  });
});
