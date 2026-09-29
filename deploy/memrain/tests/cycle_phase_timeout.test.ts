/**
 * Per-phase cycle timeout — a hung phase rejects after the deadline so it can't
 * wedge the whole tick (which would strand the db-lock and stall the cycle).
 */
import { describe, expect, it } from "bun:test";
import { withPhaseTimeout } from "../src/core/cycle/index.ts";

describe("withPhaseTimeout", () => {
  it("resolves a fast phase with its value", async () => {
    const v = await withPhaseTimeout("lint", async () => 42, 1000);
    expect(v).toBe(42);
  });

  it("rejects a hung phase after the deadline", async () => {
    const hang = () => new Promise<number>(() => {}); // never resolves
    await expect(withPhaseTimeout("recompute-salience", hang, 50)).rejects.toThrow(
      /timed out after 50ms/,
    );
  });

  it("propagates a phase's own error untouched", async () => {
    const boom = async () => {
      throw new Error("phase blew up");
    };
    await expect(withPhaseTimeout("extract", boom, 1000)).rejects.toThrow("phase blew up");
  });

  it("ms<=0 disables the timeout (runs the phase unbounded)", async () => {
    const v = await withPhaseTimeout("snapshot", async () => "ok", 0);
    expect(v).toBe("ok");
  });
});
