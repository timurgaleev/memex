/**
 * Ops-facing doctor probes (core/doctor-ops.ts): stale cycle locks, job queue
 * depth/wedge, applied-vs-available schema version, embedding-width drift.
 * PGLite in-process store; substrate tables come from the migrations run by
 * storage.init().
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  checkStaleLocks,
  checkQueueHealth,
  checkSchemaVersion,
  checkEmbeddingWidth,
  checkInvalidIndexes,
} from "../src/core/doctor-ops.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-doctor-ops-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("checkStaleLocks", () => {
  it("reports none on a clean store", async () => {
    const r = await checkStaleLocks(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no stale");
  });

  it("counts a lock past its TTL", async () => {
    await storage.engine().exec(
      `INSERT INTO cycle_locks (id, holder_pid, ttl_expires_at)
       VALUES ('cycle:test', 123, NOW() - INTERVAL '1 hour')`,
    );
    const r = await checkStaleLocks(storage.engine());
    expect(r.ok).toBe(true); // informational — reclaimed on next acquire
    expect(r.detail).toContain("1 cycle lock");
  });
});

describe("checkQueueHealth", () => {
  it("reports empty on a clean store", async () => {
    const r = await checkQueueHealth(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("pending=0");
  });

  it("counts pending and flags a wedged running job", async () => {
    await storage.engine().exec(
      `INSERT INTO jobs (id, kind, status) VALUES ('j1', 'embed', 'pending')`,
    );
    await storage.engine().exec(
      `INSERT INTO jobs (id, kind, status, started_at)
       VALUES ('j2', 'embed', 'running', NOW() - INTERVAL '2 hours')`,
    );
    const r = await checkQueueHealth(storage.engine());
    expect(r.detail).toContain("pending=1");
    expect(r.ok).toBe(false); // j2 wedged past the 1h default threshold
    expect(r.detail).toContain("wedged");
  });
});

describe("checkSchemaVersion", () => {
  it("is up to date on a freshly migrated store", async () => {
    const r = await checkSchemaVersion(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("up to date");
  });
});

describe("checkEmbeddingWidth", () => {
  it("reports no embeddings on a fresh store", async () => {
    const r = await checkEmbeddingWidth(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no embeddings");
  });
});

describe("checkInvalidIndexes", () => {
  it("reports all valid on a freshly-migrated store", async () => {
    const r = await checkInvalidIndexes(storage.engine());
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("all indexes valid");
  });

  it("flips ok:false when an index is marked indisvalid=false", async () => {
    // Simulate a failed/interrupted build: build a throwaway index, then flip
    // its pg_index.indisvalid to false (what an aborted CONCURRENTLY leaves).
    const e = storage.engine();
    await e.exec(
      "CREATE INDEX IF NOT EXISTS doctor_test_idx ON documents(source_path)",
    );
    await e.exec(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'doctor_test_idx'::regclass",
    );
    const r = await checkInvalidIndexes(e);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("doctor_test_idx");
  });
});
