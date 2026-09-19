/**
 * A call site with a model key of its own can move off its tier's model.
 * Precedence: explicit override > MEMEX_<FEATURE>_MODEL > tier env > default.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { resolveModel } from "../src/core/llm/resolve-model.ts";
import { DEFAULT_HAIKU_MODEL } from "../src/core/llm/haiku.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["MEMEX_EXPANSION_MODEL", "MEMEX_UTILITY_MODEL", "MEMEX_THINK_MODEL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveModel with a feature", () => {
  it("falls through to the tier when the feature has no key", () => {
    delete process.env.MEMEX_EXPANSION_MODEL;
    delete process.env.MEMEX_UTILITY_MODEL;
    expect(resolveModel("utility", undefined, "expansion")).toBe(DEFAULT_HAIKU_MODEL);
    process.env.MEMEX_UTILITY_MODEL = "tier-model";
    expect(resolveModel("utility", undefined, "expansion")).toBe("tier-model");
  });

  it("takes the feature key over the tier, and an override over both", () => {
    process.env.MEMEX_UTILITY_MODEL = "tier-model";
    process.env.MEMEX_EXPANSION_MODEL = "expansion-model";
    expect(resolveModel("utility", undefined, "expansion")).toBe("expansion-model");
    expect(resolveModel("utility", "explicit", "expansion")).toBe("explicit");
    // Another feature on the same tier is unaffected.
    expect(resolveModel("utility", undefined, "intent")).toBe("tier-model");
  });

  it("treats an empty key as unset", () => {
    process.env.MEMEX_THINK_MODEL = "";
    expect(resolveModel("reasoning", undefined, "think")).toBe(resolveModel("reasoning"));
  });
});
