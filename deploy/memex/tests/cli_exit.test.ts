/**
 * CLI exit-code resolution — an explicit non-zero return wins; otherwise the
 * out-of-band `process.exitCode` is honoured (so doctor/lint/integrity, which
 * set it while returning 0 from their case, actually exit non-zero).
 */
import { describe, expect, it } from "bun:test";
import { resolveExitCode } from "../src/cli-exit.ts";

describe("resolveExitCode", () => {
  it("returns the explicit code when the command returned non-zero", () => {
    expect(resolveExitCode(1, undefined)).toBe(1);
    expect(resolveExitCode(2, undefined)).toBe(2);
    // An explicit non-zero return wins even over a set process.exitCode.
    expect(resolveExitCode(2, 1)).toBe(2);
  });

  it("honours process.exitCode when the command returned 0", () => {
    // THE bug: doctor returns 0 from its case but sets process.exitCode=1.
    expect(resolveExitCode(0, 1)).toBe(1);
  });

  it("is 0 when neither signals failure", () => {
    expect(resolveExitCode(0, undefined)).toBe(0);
    expect(resolveExitCode(0, 0)).toBe(0);
  });

  it("coerces a string process.exitCode and ignores junk", () => {
    expect(resolveExitCode(0, "1")).toBe(1);
    expect(resolveExitCode(0, "")).toBe(0);
    expect(resolveExitCode(0, "nope")).toBe(0);
  });
});
