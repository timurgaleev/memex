/**
 * cycle-freshness doctor probe — classifies maintenance-cycle liveness from the
 * newest cycle_snapshots.captured_at. Zero snapshots = informational; an
 * established stream gone stale past the fail threshold = ok:false.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { checkCycleFreshness } from "../src/core/cycle-freshness.ts";
import { categorize } from "../src/core/doctor-categories.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-cyclefresh-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function snapshotAt(iso: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO cycle_snapshots (captured_at, documents, chunks, embeddings, entities, entity_mentions)
     VALUES ($1::timestamptz, 0, 0, 0, 0, 0)`,
    [iso],
  );
}

const NOW = Date.parse("2026-06-28T12:00:00Z");

describe("checkCycleFreshness", () => {
  it("is informational (ok) when no snapshots exist", async () => {
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no cycle snapshots");
  });

  it("is ok for a recent snapshot", async () => {
    await snapshotAt("2026-06-28T11:30:00Z"); // 30 min ago
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("last cycle 0h ago");
  });

  it("warns (still ok) past the warn threshold (default 6h)", async () => {
    await snapshotAt("2026-06-28T04:00:00Z"); // 8h ago
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("WARN");
    expect(r.detail).toContain("8h");
  });

  it("warns (still ok) past the fail threshold by DEFAULT — no false exit 1", async () => {
    await snapshotAt("2026-06-26T12:00:00Z"); // 48h ago
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true); // warn-only default: a cycle-off deploy doesn't fail
    expect(r.detail).toContain("WARN");
    expect(r.detail).toContain("wedged");
  });

  it("hard-fails (ok:false) past the fail threshold only when ENFORCE=1", async () => {
    await snapshotAt("2026-06-26T12:00:00Z"); // 48h ago
    process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE = "1";
    try {
      const r = await checkCycleFreshness(storage.engine(), NOW);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("wedged");
    } finally {
      delete process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE;
    }
  });

  it("uses the newest snapshot when several exist", async () => {
    await snapshotAt("2026-06-25T12:00:00Z"); // old
    await snapshotAt("2026-06-28T11:00:00Z"); // 1h ago — newest wins
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("last cycle 1h ago");
  });

  it("is categorized as a brain check (drift guard)", () => {
    expect(categorize("cycle-freshness")).toBe("brain");
  });
});
