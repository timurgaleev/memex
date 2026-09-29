/**
 * cycle-freshness doctor probe — classifies maintenance-cycle liveness from the
 * newest cycle_snapshots.captured_at into the three-state verdict. Zero
 * snapshots and clock skew are WARNs (named suspicious states, not health); an
 * established stream gone stale past the fail threshold = ok:false, but only
 * under ENFORCE.
 *
 * The assertions below pin `status`, not the old `WARN:` string prefix: the
 * prefix was the verdict for exactly one string-matching consumer, and the two
 * states that never carried it (never-cycled, clock skew) read as healthy to
 * every machine reader.
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
  // The old assertion here was `ok:true` and nothing else, which is exactly how
  // a brain whose maintenance cycle has NEVER run passed for healthy. It is
  // still not a failure (a fresh install is legitimate) — it is a warn.
  it("warns (still ok) when no snapshots exist", async () => {
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("no cycle snapshots");
  });

  it("is ok for a recent snapshot", async () => {
    await snapshotAt("2026-06-28T11:30:00Z"); // 30 min ago
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("last cycle 0h ago");
  });

  // The same silent green on the other named suspicious state: a snapshot
  // stamped in the future makes every age computed off this stream a lie, so
  // the probe cannot vouch for liveness.
  it("warns (still ok) on a future snapshot — clock skew", async () => {
    await snapshotAt("2026-06-28T18:00:00Z"); // 6h into the future
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("clock skew");
  });

  it("warns (still ok) past the warn threshold (default 6h)", async () => {
    await snapshotAt("2026-06-28T04:00:00Z"); // 8h ago
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("8h");
  });

  it("warns (still ok) past the fail threshold by DEFAULT — no false exit 1", async () => {
    await snapshotAt("2026-06-26T12:00:00Z"); // 48h ago
    const r = await checkCycleFreshness(storage.engine(), NOW);
    expect(r.ok).toBe(true); // warn-only default: a cycle-off deploy doesn't fail
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("wedged");
  });

  it("hard-fails (ok:false) past the fail threshold only when ENFORCE=1", async () => {
    await snapshotAt("2026-06-26T12:00:00Z"); // 48h ago
    process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE = "1";
    try {
      const r = await checkCycleFreshness(storage.engine(), NOW);
      expect(r.ok).toBe(false);
      expect(r.status).toBe("fail");
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
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("last cycle 1h ago");
  });

  it("keeps ok as the exit-code view of status in every branch", async () => {
    // ok === (status !== "fail") is what lets a warn stay off the exit code.
    const branches: (() => Promise<void>)[] = [
      async () => {},
      async () => void (await snapshotAt("2026-06-28T11:30:00Z")),
      async () => void (await snapshotAt("2026-06-28T18:00:00Z")),
      async () => void (await snapshotAt("2026-06-28T04:00:00Z")),
      async () => void (await snapshotAt("2026-06-26T12:00:00Z")),
    ];
    for (const seed of branches) {
      await storage.engine().exec("DELETE FROM cycle_snapshots");
      await seed();
      for (const enforce of [false, true]) {
        if (enforce) process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE = "1";
        else delete process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE;
        const r = await checkCycleFreshness(storage.engine(), NOW);
        expect(r.ok).toBe(r.status !== "fail");
      }
    }
    delete process.env.MEMEX_CYCLE_FRESHNESS_ENFORCE;
  });

  it("is categorized as a brain check (drift guard)", () => {
    expect(categorize("cycle-freshness")).toBe("brain");
  });
});
