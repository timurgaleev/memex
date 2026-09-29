import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { NO_SOURCE_SENTINEL } from "../src/core/auth-info.ts";
import { andSourceScope, isNoGrant, normalizeSourceFilterParam } from "../src/core/source-scope.ts";

describe("andSourceScope", () => {
  it("emits nothing and binds nothing for an unscoped caller", () => {
    const params: unknown[] = ["q"];
    expect(andSourceScope("d.source_id", undefined, params)).toBe("");
    expect(params).toEqual(["q"]);
  });

  it("matches nothing for a caller with no grant", () => {
    const params: unknown[] = [];
    expect(andSourceScope("d.source_id", [], params)).toBe(" AND FALSE");
    expect(params).toEqual([]);
  });

  it("binds the list at the next placeholder for a scoped caller", () => {
    const params: unknown[] = ["q", 5];
    expect(andSourceScope("d.source_id", ["a", "b"], params)).toBe(" AND d.source_id = ANY($3::text[])");
    expect(params[2]).toEqual(["a", "b"]);
  });

  it("denies the sentinel outright instead of looking its id up", () => {
    const params: unknown[] = [];
    expect(andSourceScope("source_id", [NO_SOURCE_SENTINEL], params)).toBe(" AND FALSE");
    expect(params).toEqual([]);
  });

  it("refuses a column expression that is not a plain identifier", () => {
    expect(() => andSourceScope("d.source_id; DROP TABLE x", ["a"], [])).toThrow("unsafe SQL alias");
  });
});

describe("isNoGrant", () => {
  it("separates no grant from unscoped and scoped", () => {
    expect(isNoGrant(undefined)).toBe(false);
    expect(isNoGrant([])).toBe(true);
    expect(isNoGrant([NO_SOURCE_SENTINEL])).toBe(true);
    expect(isNoGrant(["a"])).toBe(false);
    expect(isNoGrant([NO_SOURCE_SENTINEL, "a"])).toBe(false);
  });
});

describe("normalizeSourceFilterParam", () => {
  it("reads an empty or blank user filter as no filter", () => {
    expect(normalizeSourceFilterParam(undefined)).toBeUndefined();
    expect(normalizeSourceFilterParam([])).toBeUndefined();
    expect(normalizeSourceFilterParam(["", "  "])).toBeUndefined();
    expect(normalizeSourceFilterParam([" a ", "b"])).toEqual(["a", "b"]);
  });
});

describe("registerSource", () => {
  it("refuses the no-grant sentinel as a source id", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "memex-sentinel-source-"));
    const storage = new Storage({ dbPath: join(tmp, "db") });
    try {
      await storage.init();
      await expect(registerSource(storage.engine(), { id: NO_SOURCE_SENTINEL, kind: "vault", pathPrefix: "/x" })).rejects.toThrow("reserved");
    } finally {
      await storage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
