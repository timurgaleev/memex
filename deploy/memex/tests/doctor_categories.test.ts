/**
 * Doctor categorization — unit tests for the category sets + categorize().
 * The end-to-end drift guard (every check the doctor actually emits is
 * categorized) lives in doctor.test.ts, which runs the real runDoctor.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BRAIN_CHECK_NAMES,
  OPS_CHECK_NAMES,
  KNOWN_CHECK_NAMES,
  categorize,
  _resetCategoryWarnings,
} from "../src/core/doctor-categories.ts";

// The `warned` Set is process-global; an earlier test file may have populated
// it before this file runs (bun test shares one process). Reset on BOTH sides
// so the warn-once assertion is robust to file ordering.
beforeEach(() => _resetCategoryWarnings());
afterEach(() => _resetCategoryWarnings());

describe("doctor categorize", () => {
  it("maps brain checks to 'brain'", () => {
    for (const n of BRAIN_CHECK_NAMES) expect(categorize(n)).toBe("brain");
  });

  it("maps ops checks to 'ops'", () => {
    for (const n of OPS_CHECK_NAMES) expect(categorize(n)).toBe("ops");
  });

  it("KNOWN_CHECK_NAMES is the union of every category set", () => {
    expect([...KNOWN_CHECK_NAMES].sort()).toEqual([
      "chunker-version-lag",
      "config",
      "contradiction-trend",
      "cycle-freshness",
      "embedding-width",
      "eval-trend",
      "federation-health",
      "index-spread",
      "links-extraction-lag",
      "oauth-client-health",
      "per-source-embed-coverage",
      "pglite",
      "queue-health",
      "schema-version",
      "source-health",
      "source-routing-health",
      "stale-locks",
      "stats",
      "vault",
    ]);
  });

  it("falls through to 'meta' for an unknown name and warns once", () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    try {
      expect(categorize("totally-new-check")).toBe("meta");
      expect(categorize("totally-new-check")).toBe("meta"); // second call: no new warn
    } finally {
      console.error = orig;
    }
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("uncategorized");
  });
});
