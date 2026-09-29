/**
 * Wilson CI util (pure) + whoami MCP op (introspects the calling identity).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wilsonCI, smallSampleNote } from "../src/core/wilson.ts";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

setDefaultTimeout(25000);

describe("wilsonCI", () => {
  it("returns zeros for an empty sample", () => {
    expect(wilsonCI(0, 0)).toEqual({ point: 0, lower: 0, upper: 0 });
  });
  it("pins lower=0 at k=0 and upper=1 at k=n", () => {
    const none = wilsonCI(0, 10);
    expect(none.point).toBe(0);
    expect(none.lower).toBe(0);
    expect(none.upper).toBeGreaterThan(0);
    const all = wilsonCI(10, 10);
    expect(all.point).toBe(1);
    expect(all.upper).toBe(1);
    expect(all.lower).toBeLessThan(1);
  });
  it("brackets the point estimate within [0,1]", () => {
    const ci = wilsonCI(7, 10);
    expect(ci.point).toBeCloseTo(0.7, 10);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.lower).toBeLessThan(0.7);
    expect(ci.upper).toBeGreaterThan(0.7);
    expect(ci.upper).toBeLessThanOrEqual(1);
  });
  it("clamps an out-of-range numerator", () => {
    expect(wilsonCI(15, 10).point).toBe(1);
  });
  it("small-sample note fires below n=30 only", () => {
    expect(smallSampleNote(10)).toMatch(/below 30/);
    expect(smallSampleNote(30)).toBeUndefined();
  });
});

describe("whoami op", () => {
  const dbDir = mkdtempSync(join(tmpdir(), "tb-whoami-db-"));
  let storage: Storage;

  beforeAll(async () => {
    storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  function parse(result: { content: { text?: string }[] }): Record<string, unknown> {
    return JSON.parse(result.content[0]?.text ?? "{}");
  }

  it("returns the caller's auth context", async () => {
    const authInfo: AuthInfo = {
      token: "memex_at_x",
      clientId: "memex_cl_42",
      scopes: ["read"],
      sourceId: "vault",
      allowedSources: ["vault", "gmail"],
      isPublic: false,
    };
    const r = await dispatchTool(storage, { name: "whoami", arguments: {} }, { authInfo });
    const body = parse(r);
    expect(body["client_id"]).toBe("memex_cl_42");
    expect(body["scopes"]).toEqual(["read"]);
    expect(body["write_source"]).toBe("vault");
    expect(body["read_sources"]).toEqual(["vault", "gmail"]);
    expect(body["is_public"]).toBe(false);
  });

  it("reports null read_sources when unscoped (no authInfo)", async () => {
    const r = await dispatchTool(storage, { name: "whoami", arguments: {} }, {});
    const body = parse(r);
    expect(body["client_id"]).toBeNull();
    expect(body["read_sources"]).toBeNull();
    expect(body["scopes"]).toEqual([]);
  });
});
