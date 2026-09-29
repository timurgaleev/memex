/**
 * The reserved "no source" id has two spellings: `__memex_no_source__` from
 * before the rename and `__memrain_no_source__`. Every reader treats both as
 * the fail-closed floor, neither can be registered as a real source, and only
 * the current spelling is emitted.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { effectiveWriteSourceIdForIngress, isNoSourceSentinel, NO_SOURCE_SENTINEL } from "../src/core/auth-info.ts";
import { andSourceScope, isNoGrant } from "../src/core/source-scope.ts";
import { registerSource } from "../src/core/sources.ts";
import { evaluateOperatorScope, type DoctorWhoami } from "../src/commands/remote-doctor.ts";

const SPELLINGS = ["__memex_no_source__", "__memrain_no_source__"];

describe("the emitted sentinel", () => {
  it("is the current spelling", () => {
    expect(NO_SOURCE_SENTINEL).toBe("__memrain_no_source__");
    const noGrant = { token: "t", clientId: "c", scopes: ["write"], isPublic: false };
    expect(effectiveWriteSourceIdForIngress(noGrant, { failClosed: true })).toBe("__memrain_no_source__");
  });
});

describe("isNoSourceSentinel", () => {
  it("accepts both spellings and nothing else", () => {
    for (const s of SPELLINGS) expect(isNoSourceSentinel(s)).toBe(true);
    expect(isNoSourceSentinel(NO_SOURCE_SENTINEL)).toBe(true);
    for (const s of ["default", "", "__memex_no_source", "__MEMRAIN_NO_SOURCE__", undefined, null]) {
      expect(isNoSourceSentinel(s)).toBe(false);
    }
  });

  it("a scope of either spelling reads nothing", () => {
    for (const s of SPELLINGS) {
      expect(isNoGrant([s])).toBe(true);
      expect(andSourceScope("source_id", [s], [])).toBe(" AND FALSE");
    }
    expect(isNoGrant(SPELLINGS)).toBe(true);
    expect(isNoGrant([SPELLINGS[1]!, "a"])).toBe(false);
  });
});

describe("remote-doctor", () => {
  const who = (read: string[]): DoctorWhoami => ({
    client_id: "c",
    scopes: ["read"],
    write_source: null,
    read_sources: read,
    is_public: false,
  });

  it("treats either spelling from the server as no read grant", () => {
    for (const s of SPELLINGS) expect(evaluateOperatorScope(who([s]))).toBe("no read grant (fail-closed)");
    expect(evaluateOperatorScope(who(SPELLINGS))).toBe("no read grant (fail-closed)");
    expect(evaluateOperatorScope(who(["default"]))).toBeNull();
  });
});

describe("registerSource", () => {
  let tmp: string;
  let storage: Storage;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-sentinel-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reserves both spellings", async () => {
    for (const s of SPELLINGS) {
      await expect(registerSource(storage.raw(), { id: s, kind: "other", pathPrefix: "/x" })).rejects.toThrow("is reserved");
    }
    const r = await storage.raw().query<{ id: string }>("SELECT id FROM sources WHERE id LIKE '\\_\\_%'");
    expect(r.rows).toEqual([]);
  });
});
