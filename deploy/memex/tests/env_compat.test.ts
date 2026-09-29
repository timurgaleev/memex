/**
 * Startup env shim: legacy MEMEX_* names are made available as MEMRAIN_*.
 * Pins the copy rules, the presence semantics of empty values, conflict
 * reporting, and that no value ever reaches the report or the boot line.
 */
import { describe, expect, it } from "bun:test";
import { legacyEnvBootLine, mapLegacyEnv } from "../src/core/env-compat.ts";

describe("mapLegacyEnv", () => {
  it("copies a legacy value to the new name", () => {
    const env: Record<string, string | undefined> = { MEMEX_X: "a" };
    const r = mapLegacyEnv(env);
    expect(env["MEMRAIN_X"]).toBe("a");
    expect(env["MEMEX_X"]).toBe("a");
    expect(r.mapped).toEqual(["MEMRAIN_X"]);
    expect(r.conflicts).toEqual([]);
  });

  it("keeps an empty legacy value present when the new name is absent", () => {
    const env: Record<string, string | undefined> = { MEMEX_X: "" };
    mapLegacyEnv(env);
    expect(env["MEMRAIN_X"]).toBe("");
  });

  it("fills an empty new name from a non-empty legacy value", () => {
    const env: Record<string, string | undefined> = { MEMRAIN_X: "", MEMEX_X: "a" };
    const r = mapLegacyEnv(env);
    expect(env["MEMRAIN_X"]).toBe("a");
    expect(r.mapped).toEqual(["MEMRAIN_X"]);
  });

  it("leaves an empty new name alone when the legacy value is empty too", () => {
    const env: Record<string, string | undefined> = { MEMRAIN_X: "", MEMEX_X: "" };
    const r = mapLegacyEnv(env);
    expect(env["MEMRAIN_X"]).toBe("");
    expect(r.mapped).toEqual([]);
  });

  it("lets the new name win and records a conflict when both differ", () => {
    const env: Record<string, string | undefined> = { MEMRAIN_X: "new", MEMEX_X: "old" };
    const r = mapLegacyEnv(env);
    expect(env["MEMRAIN_X"]).toBe("new");
    expect(r.conflicts).toEqual(["MEMRAIN_X"]);
    expect(r.mapped).toEqual([]);
  });

  it("counts identical values under both names as neither mapped nor conflict", () => {
    const env: Record<string, string | undefined> = { MEMRAIN_X: "same", MEMEX_X: "same" };
    const r = mapLegacyEnv(env);
    expect(r.mapped).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("ignores names outside the legacy key shape", () => {
    const env: Record<string, string | undefined> = {
      memex_x: "a",
      MEMEX_: "b",
      "MEMEX_lower": "c",
      XMEMEX_Y: "d",
      PATH: "/bin",
    };
    const r = mapLegacyEnv(env);
    expect(r.mapped).toEqual([]);
    expect(Object.keys(env).filter((k) => k.startsWith("MEMRAIN_"))).toEqual([]);
  });

  it("never puts a value into the report or the boot line", () => {
    const env: Record<string, string | undefined> = {
      MEMEX_SECRET_A: "s3cr3t-value-a",
      MEMRAIN_SECRET_B: "s3cr3t-value-b",
      MEMEX_SECRET_B: "s3cr3t-value-c",
    };
    const r = mapLegacyEnv(env);
    const line = legacyEnvBootLine(r) ?? "";
    const text = JSON.stringify(r) + line;
    expect(text).not.toContain("s3cr3t");
    expect(line).toBe(
      "[memrain] 1 legacy MEMEX_* env vars mapped; 1 conflicts (MEMRAIN_ wins): MEMRAIN_SECRET_B",
    );
  });

  it("has no boot line when no legacy name is in use", () => {
    expect(legacyEnvBootLine(mapLegacyEnv({ MEMRAIN_X: "a" }))).toBeNull();
  });
});
