/**
 * Friction core tests — log + analyse against a seeded engine.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { analyzeFriction, logFriction } from "../src/core/friction.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-friction-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("friction", () => {
  it("logs and reads back rows by analyzeFriction", async () => {
    const e = storage.engine();
    await logFriction(e, {
      kind: "search-miss",
      query: "find x",
      reason: "no hits",
    });
    await logFriction(e, {
      kind: "search-miss",
      query: "find x", // duplicate to test topRepeats
    });
    await logFriction(e, {
      kind: "tool-error",
      reason: "5xx from bedrock",
      extra: { code: 500 },
    });

    const r = await analyzeFriction(e);
    expect(r.byKind["search-miss"]).toBe(2);
    expect(r.byKind["tool-error"]).toBe(1);
    expect(r.topRepeats[0]?.query).toBe("find x");
    expect(r.topRepeats[0]?.count).toBe(2);
    expect(r.recent.length).toBe(3);
    expect(r.recent[0]!.kind).toBe("tool-error");
    expect(r.recent[0]!.extra).toEqual({ code: 500 });
  });

  it("rejects unknown kind via CHECK constraint", async () => {
    const e = storage.engine();
    await expect(
      e.query(`INSERT INTO friction_events (kind) VALUES ('bogus')`),
    ).rejects.toThrow(/check/i);
  });
});
