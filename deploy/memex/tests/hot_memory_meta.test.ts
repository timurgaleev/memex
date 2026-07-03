/**
 * hot_memory `_meta.brain_hot_memory` injection (Item 3).
 *
 * Covers the feature gate (default OFF), decay-weighted ordering, and the
 * dispatch-level public/tenant gating. PGLite-backed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { recordHotFact } from "../src/core/hot_memory.ts";
import {
  getBrainHotMemoryMeta,
  hotMemoryMetaEnabled,
  __resetHotMemoryMetaCacheForTests,
} from "../src/core/hot-memory-meta.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;
let priorEnv: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-hotmeta-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  priorEnv = process.env["MEMEX_HOT_MEMORY_META"];
  __resetHotMemoryMetaCacheForTests();
});

afterEach(async () => {
  if (priorEnv === undefined) delete process.env["MEMEX_HOT_MEMORY_META"];
  else process.env["MEMEX_HOT_MEMORY_META"] = priorEnv;
  __resetHotMemoryMetaCacheForTests();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("getBrainHotMemoryMeta", () => {
  it("is disabled by default (returns undefined even with facts)", async () => {
    delete process.env["MEMEX_HOT_MEMORY_META"];
    expect(hotMemoryMetaEnabled()).toBe(false);
    await recordHotFact(storage, { entity_slug: "people/bob", fact: "likes tea" });
    __resetHotMemoryMetaCacheForTests();
    expect(await getBrainHotMemoryMeta(storage)).toBeUndefined();
  });

  it("returns a decay-weighted top-K payload when enabled", async () => {
    process.env["MEMEX_HOT_MEMORY_META"] = "1";
    // Recent, medium confidence.
    await recordHotFact(storage, {
      entity_slug: "people/bob",
      fact: "recent-medium",
      effective_confidence: 0.5,
    });
    // Older (48h), high confidence — decays below the recent one:
    // 1.0 * 0.5^(48/24) = 0.25 < 0.5.
    await storage.engine().query(
      `INSERT INTO hot_memory (entity_slug, fact, effective_confidence, written_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '48 hours')`,
      ["companies/acme", "old-high", 1.0],
    );
    __resetHotMemoryMetaCacheForTests();
    const meta = await getBrainHotMemoryMeta(storage);
    const facts = (meta?.brain_hot_memory as { facts: { fact: string }[] } | undefined)?.facts;
    expect(facts).toBeDefined();
    expect(facts!.length).toBe(2);
    // Decay ordering: the recent medium fact outranks the older high one.
    expect(facts![0]!.fact).toBe("recent-medium");
  });

  it("returns undefined when there are no recent facts", async () => {
    process.env["MEMEX_HOT_MEMORY_META"] = "1";
    __resetHotMemoryMetaCacheForTests();
    expect(await getBrainHotMemoryMeta(storage)).toBeUndefined();
  });
});

describe("dispatch injection gating", () => {
  beforeEach(async () => {
    process.env["MEMEX_HOT_MEMORY_META"] = "1";
    await recordHotFact(storage, { entity_slug: "people/bob", fact: "held" });
    __resetHotMemoryMetaCacheForTests();
  });

  it("attaches _meta for an internal (unscoped, non-public) call", async () => {
    const r = await dispatchTool(storage, { name: "get_brain_identity", arguments: {} }, {});
    expect(r.isError ?? false).toBe(false);
    expect(r._meta?.brain_hot_memory).toBeDefined();
  });

  it("never attaches _meta on the public ingress", async () => {
    const r = await dispatchTool(
      storage,
      { name: "get_brain_identity", arguments: {} },
      { isPublic: true },
    );
    expect(r._meta).toBeUndefined();
  });

  it("never attaches _meta for a tenant-scoped (authInfo) call", async () => {
    const authInfo = {
      clientId: "memex_at_x",
      allowedSources: ["tenant-a"],
      sourceId: "tenant-a",
    } as unknown as Parameters<typeof dispatchTool>[2]["authInfo"];
    const r = await dispatchTool(
      storage,
      { name: "get_brain_identity", arguments: {} },
      { authInfo },
    );
    expect(r._meta).toBeUndefined();
  });
});
