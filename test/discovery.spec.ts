import { describe, expect, it } from "vitest";
import { slugCandidates } from "../src/discovery";

describe("slugCandidates", () => {
  it("produces single-token slug for one-word companies", () => {
    expect(slugCandidates("Stripe")).toEqual(["stripe"]);
  });

  it("produces first-word, compact, and hyphenated forms", () => {
    const c = slugCandidates("Acme Corp");
    // "Corp" suffix is stripped, so only "acme" survives — single candidate.
    expect(c).toEqual(["acme"]);

    const multi = slugCandidates("General Catalyst Ventures");
    expect(multi).toContain("general");
    expect(multi).toContain("generalcatalystventures");
    expect(multi).toContain("general-catalyst-ventures");
  });

  it("strips legal suffixes so Acme Inc. doesn't pollute candidates", () => {
    const c = slugCandidates("Acme Inc.");
    expect(c).toEqual(["acme"]);
  });

  it("lowercases and preserves apostrophe-joined words", () => {
    // "O'Reilly" should slug as "oreilly" (apostrophe dropped, not split).
    // "Co." is a legal suffix and gets stripped, so "Media" stays joined.
    const c = slugCandidates("O'Reilly Media Co.");
    expect(c).toContain("oreilly");
    expect(c).toContain("oreillymedia");
    expect(c).toContain("oreilly-media");
  });

  it("returns [] for empty or whitespace-only names", () => {
    expect(slugCandidates("")).toEqual([]);
    expect(slugCandidates("   ")).toEqual([]);
  });

  it("skips candidates outside 2..40 character range", () => {
    // Super-long repeated pattern → compact/hyphenated exceed 40 chars and are
    // dropped; first word survives if short enough.
    const c = slugCandidates("A Very Extremely Ridiculously Long Company Name Inc");
    for (const slug of c) {
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(slug.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("dedupes candidates (single-word company has compact == hyphenated)", () => {
    const c = slugCandidates("Anthropic");
    expect(c).toEqual(["anthropic"]);
    expect(new Set(c).size).toBe(c.length);
  });
});
