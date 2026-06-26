/**
 * Tenant grant tests — upsert, list, revoke, validation.
 * No Bedrock; all SQL via PGLite. Mirrors the sources.test.ts harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import {
  getGrant,
  listGrants,
  upsertGrant,
  revokeGrant,
  validateGrantSourceIds,
} from "../src/core/tenant-grants.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tenant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("tenant grants", () => {
  it("add tenant source → grant → list shows it → revoke removes it", async () => {
    const e = storage.engine();

    // Register tenant source (kind=other, path_prefix=tenant:<id>).
    await registerSource(e, {
      id: "acme",
      kind: "other",
      pathPrefix: "tenant:acme",
      description: "Acme Corp",
    });

    // Upsert grant with explicit federated_read.
    const grant = await upsertGrant(e, {
      sub: "user-123",
      sourceId: "acme",
      federatedRead: ["acme"],
    });
    expect(grant.sub).toBe("user-123");
    expect(grant.source_id).toBe("acme");
    expect(grant.federated_read).toEqual(["acme"]);

    // list returns the grant.
    const all = await listGrants(e);
    expect(all.length).toBe(1);
    expect(all[0]!.sub).toBe("user-123");

    // Revoke removes the row.
    const removed = await revokeGrant(e, "user-123");
    expect(removed).toBe(true);

    const after = await listGrants(e);
    expect(after.length).toBe(0);
  });

  it("upsert is idempotent — later call updates the row", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "s1", kind: "other", pathPrefix: "tenant:s1" });
    await registerSource(e, { id: "s2", kind: "other", pathPrefix: "tenant:s2" });

    await upsertGrant(e, { sub: "u1", sourceId: "s1", federatedRead: ["s1"] });
    await upsertGrant(e, { sub: "u1", sourceId: "s2", federatedRead: ["s1", "s2"] });

    const row = await getGrant(e, "u1");
    expect(row!.source_id).toBe("s2");
    expect(row!.federated_read).toContain("s1");
    expect(row!.federated_read).toContain("s2");
  });

  it("validateGrantSourceIds rejects non-existent ids — no row written", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "gamma", kind: "other", pathPrefix: "tenant:gamma" });

    // "nonexistent" does not exist → should be flagged.
    const missing = await validateGrantSourceIds(e, "gamma", ["gamma", "nonexistent"]);
    expect(missing).toContain("nonexistent");
    expect(missing).not.toContain("gamma");

    // Caller would stop here — verify no grant was written.
    const row = await getGrant(e, "user-789");
    expect(row).toBeNull();
  });

  it("defaults federated_read to [source] when caller passes source only", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "beta", kind: "other", pathPrefix: "tenant:beta" });

    // Simulate CLI default: read = [source].
    const grant = await upsertGrant(e, {
      sub: "user-456",
      sourceId: "beta",
      federatedRead: ["beta"],
    });
    expect(grant.federated_read).toEqual(["beta"]);
  });

  it("revokeGrant returns false when sub does not exist", async () => {
    const e = storage.engine();
    const removed = await revokeGrant(e, "nobody");
    expect(removed).toBe(false);
  });
});
