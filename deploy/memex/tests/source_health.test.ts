/**
 * Brain-level health metrics — embed coverage (excluding graph-only code
 * chunks), staleness lag, queue depth, failed-jobs-24h. Seeds a PGLite brain
 * with a known mix and asserts the aggregates.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { brainHealthMetrics } from "../src/core/source-health.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-srchealth-"));
let storage: Storage;

// A valid 1024-dim zero vector literal for the embeddings table.
const ZERO_VEC = `[${Array(1024).fill(0).join(",")}]`;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
  const e = storage.raw();

  // doc1: markdown (embeddable), 2 chunks — embed only chunk 0.
  await e.query(
    `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
     VALUES ('d1', 'notes/a.md', 'A', '{}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('d1c0','d1',0,'alpha')`);
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('d1c1','d1',1,'beta')`);
  await e.query(`INSERT INTO embeddings (chunk_id, vector, model) VALUES ('d1c0', $1::vector, 'test')`, [ZERO_VEC]);

  // doc2: code (graph-only, excluded from coverage), 1 chunk, no embedding.
  await e.query(
    `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
     VALUES ('d2', 'src/x.ts', 'x.ts', '{"kind":"code"}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('d2c0','d2',0,'function f(){}')`);

  // jobs: 1 pending, 1 failed in-window, 1 failed out-of-window, 1 succeeded.
  await e.query(`INSERT INTO jobs (id, kind, status) VALUES ('j1','sweep','pending')`);
  await e.query(
    `INSERT INTO jobs (id, kind, status, finished_at) VALUES ('j2','sweep','failed', NOW() - INTERVAL '1 hour')`,
  );
  await e.query(
    `INSERT INTO jobs (id, kind, status, finished_at) VALUES ('j3','sweep','failed', NOW() - INTERVAL '2 days')`,
  );
  await e.query(
    `INSERT INTO jobs (id, kind, status, finished_at) VALUES ('j4','sweep','succeeded', NOW())`,
  );
  // j5: failed but finished_at never stamped — must still count (can't prove old).
  await e.query(`INSERT INTO jobs (id, kind, status) VALUES ('j5','sweep','failed')`);
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("brainHealthMetrics", () => {
  it("computes coverage over embeddable (non-code) chunks", async () => {
    const h = await brainHealthMetrics(storage.raw());
    expect(h.embeddable_chunks).toBe(2);
    expect(h.embedded_chunks).toBe(1);
    expect(h.embed_coverage_pct).toBeCloseTo(0.5, 5);
    expect(h.code_chunks).toBe(1);
  });

  it("counts pending queue depth and only failures inside the 24h window", async () => {
    const h = await brainHealthMetrics(storage.raw());
    expect(h.queue_depth).toBe(1); // j1
    // j2 (1h ago) + j5 (failed, NULL finished_at). j3 (2 days old) excluded.
    expect(h.failed_jobs_24h).toBe(2);
  });

  it("reports a non-negative staleness lag", async () => {
    const h = await brainHealthMetrics(storage.raw());
    expect(h.lag_seconds).not.toBeNull();
    expect(h.lag_seconds!).toBeGreaterThanOrEqual(0);
  });
});

describe("brainHealthMetrics — empty brain", () => {
  it("coverage is 1.0 when there is nothing to embed", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "memex-srchealth-empty-"));
    const s2 = new Storage({ dbPath: join(d2, "db") });
    await s2.init();
    try {
      const h = await brainHealthMetrics(s2.raw());
      expect(h.embeddable_chunks).toBe(0);
      expect(h.embed_coverage_pct).toBe(1);
      expect(h.lag_seconds).toBeNull();
      expect(h.queue_depth).toBe(0);
      expect(h.failed_jobs_24h).toBe(0);
    } finally {
      await s2.close();
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
