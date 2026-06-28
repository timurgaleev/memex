/**
 * MEMEX_CYCLE_SKIP_PHASES parsing — the operator escape hatch to drop a
 * defective phase from every tick without losing the rest of the cycle.
 */
import { describe, expect, it } from "bun:test";
import { parseSkipPhases } from "../src/recipes/cycle.ts";

describe("parseSkipPhases", () => {
  it("parses a CSV into a trimmed set", () => {
    const s = parseSkipPhases("frontmatter-inference, extract ,lint");
    expect(s.has("frontmatter-inference")).toBe(true);
    expect(s.has("extract")).toBe(true);
    expect(s.has("lint")).toBe(true);
    expect(s.size).toBe(3);
  });

  it("is empty for undefined / empty / whitespace", () => {
    expect(parseSkipPhases(undefined).size).toBe(0);
    expect(parseSkipPhases("").size).toBe(0);
    expect(parseSkipPhases("  , ,").size).toBe(0);
  });
});
