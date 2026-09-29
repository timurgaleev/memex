/**
 * Opt-in auto-think: the dream loop appends the Nova SYNTHESIS_PHASES to a tick
 * ONLY when MEMEX_DREAM_SYNTHESIS is on AND the tick is in quiet hours. Pure
 * phase-array logic — no Bedrock call.
 */
import { describe, expect, it } from "bun:test";
import { selectTickPhases, capEnv } from "../src/recipes/cycle.ts";
import { SYNTHESIS_PHASES } from "../src/core/cycle/index.ts";

const NONE = new Set<string>();

describe("selectTickPhases — synthesis gating", () => {
  it("flag OFF → never appends synthesis phases (quiet or not)", () => {
    for (const inQuiet of [true, false]) {
      const phases = selectTickPhases({ inQuiet, synthEnabled: false, skipPhases: NONE });
      for (const s of SYNTHESIS_PHASES) expect(phases).not.toContain(s);
    }
  });

  it("flag ON + quiet → appends all 5 synthesis phases", () => {
    const phases = selectTickPhases({ inQuiet: true, synthEnabled: true, skipPhases: NONE });
    for (const s of SYNTHESIS_PHASES) expect(phases).toContain(s);
  });

  it("flag ON + NON-quiet → no synthesis (synthesis is quiet-hours-only)", () => {
    const phases = selectTickPhases({ inQuiet: false, synthEnabled: true, skipPhases: NONE });
    for (const s of SYNTHESIS_PHASES) expect(phases).not.toContain(s);
  });

  it("skipPhases still drops a synthesis phase when flag ON", () => {
    const phases = selectTickPhases({
      inQuiet: true,
      synthEnabled: true,
      skipPhases: new Set(["synthesize-concepts"]),
    });
    expect(phases).not.toContain("synthesize-concepts");
    expect(phases).toContain("extract-atoms"); // the others still run
  });
});

describe("capEnv", () => {
  it("parses a positive integer", () => {
    expect(capEnv("40", 25)).toBe(40);
  });
  it("falls back on blank / garbage / non-positive", () => {
    expect(capEnv(undefined, 25)).toBe(25);
    expect(capEnv("", 25)).toBe(25);
    expect(capEnv("abc", 25)).toBe(25);
    expect(capEnv("0", 25)).toBe(25);
    expect(capEnv("-3", 25)).toBe(25);
  });
});
