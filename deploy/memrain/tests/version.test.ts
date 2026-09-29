/**
 * resolveVersion — build-version stamp read from MEMEX_VERSION, 'dev' fallback.
 */
import { describe, expect, it } from "bun:test";
import { resolveVersion } from "../src/version.ts";

describe("resolveVersion", () => {
  it("returns the stamp when set", () => {
    expect(resolveVersion({ MEMEX_VERSION: "v1.86.0-3-gabc1234" })).toBe(
      "v1.86.0-3-gabc1234",
    );
  });

  it("falls back to dev when unset or blank", () => {
    expect(resolveVersion({})).toBe("dev");
    expect(resolveVersion({ MEMEX_VERSION: "" })).toBe("dev");
    expect(resolveVersion({ MEMEX_VERSION: "   " })).toBe("dev");
  });
});
