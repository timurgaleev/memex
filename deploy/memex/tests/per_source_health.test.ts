/**
 * Per-source (per-tenant) health breakdown — collectPerSourceHealth. Seeds a
 * PGLite brain with docs across multiple source_ids (one fully embedded, one
 * with NO embeddings, one code-only, plus NULL-source docs) and asserts the
 * per-source rows, the '(unclassified)' NULL bucket, grant scoping, and that
 * the whole-brain metric is unaffected. No Bedrock.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  brainHealthMetrics,
  collectPerSourceHealth,
  type PerSourceHealth,
} from "../src/core/source-health.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-persrc-"));
let storage: Storage;

const ZERO_VEC = `[${Array(1024).fill(0).join(",")}]`;

function byId(rows: PerSourceHealth[]): Record<string, PerSourceHealth> {
  return Object.fromEntries(rows.map((r) => [r.source_id, r]));
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
  const e = storage.raw();

  // The sources registry has a FK from documents.source_id → sources.id.
  await e.query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES
       ('vault', 'vault', 'notes/'),
       ('mail', 'mailbox', 'mail/')`,
  );

  // vault: 2 markdown chunks, BOTH embedded → 100% coverage.
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter, updated_at)
     VALUES ('v1', 'vault', 'notes/a.md', 'A', '{}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('v1c0','v1',0,'alpha')`);
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('v1c1','v1',1,'beta')`);
  await e.query(`INSERT INTO embeddings (chunk_id, vector, model) VALUES ('v1c0', $1::vector, 'test')`, [ZERO_VEC]);
  await e.query(`INSERT INTO embeddings (chunk_id, vector, model) VALUES ('v1c1', $1::vector, 'test')`, [ZERO_VEC]);

  // mail: 2 markdown chunks, NONE embedded → 0% coverage (the broken tenant).
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter, updated_at)
     VALUES ('m1', 'mail', 'mail/x.md', 'X', '{}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('m1c0','m1',0,'gamma')`);
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('m1c1','m1',1,'delta')`);

  // mail: a code-only doc → its chunk is graph-only, excluded from coverage.
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter, updated_at)
     VALUES ('m2', 'mail', 'mail/y.ts', 'y.ts', '{"kind":"code"}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('m2c0','m2',0,'function g(){}')`);

  // NULL-source doc (no source_id) → the '(unclassified)' bucket.
  await e.query(
    `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
     VALUES ('u1', 'loose/z.md', 'Z', '{}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('u1c0','u1',0,'epsilon')`);
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("collectPerSourceHealth — unscoped (local)", () => {
  it("reports each source's counts + coverage and surfaces the NULL bucket", async () => {
    const rows = await collectPerSourceHealth(storage.raw());
    const m = byId(rows);

    // Three buckets: vault, mail, '(unclassified)'.
    expect(rows.map((r) => r.source_id).sort()).toEqual([
      "(unclassified)",
      "mail",
      "vault",
    ]);

    // vault: 1 doc, 2 embeddable chunks, both embedded → 100%.
    expect(m["vault"]!.document_count).toBe(1);
    expect(m["vault"]!.chunk_count).toBe(2);
    expect(m["vault"]!.embeddable_chunks).toBe(2);
    expect(m["vault"]!.embedded_chunks).toBe(2);
    expect(m["vault"]!.embed_coverage_pct).toBeCloseTo(1, 5);
    expect(m["vault"]!.code_chunks).toBe(0);

    // mail: 2 docs (1 markdown + 1 code), 3 chunks total, 2 embeddable & 0
    // embedded → 0% (the broken tenant), 1 code chunk excluded from coverage.
    expect(m["mail"]!.document_count).toBe(2);
    expect(m["mail"]!.chunk_count).toBe(3);
    expect(m["mail"]!.embeddable_chunks).toBe(2);
    expect(m["mail"]!.embedded_chunks).toBe(0);
    expect(m["mail"]!.embed_coverage_pct).toBe(0);
    expect(m["mail"]!.code_chunks).toBe(1);

    // unclassified NULL-source bucket is visible, not hidden.
    expect(m["(unclassified)"]!.document_count).toBe(1);
    expect(m["(unclassified)"]!.chunk_count).toBe(1);
    expect(m["(unclassified)"]!.embeddable_chunks).toBe(1);
    expect(m["(unclassified)"]!.embedded_chunks).toBe(0);
  });

  it("reports a non-negative lag per source", async () => {
    const rows = await collectPerSourceHealth(storage.raw());
    for (const r of rows) {
      expect(r.lag_seconds).not.toBeNull();
      expect(r.lag_seconds!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("collectPerSourceHealth — scoped (remote grant)", () => {
  it("returns only granted sources and never the NULL bucket", async () => {
    const rows = await collectPerSourceHealth(storage.raw(), ["mail"]);
    expect(rows.map((r) => r.source_id)).toEqual(["mail"]);
    // No '(unclassified)' — a NULL source matches no grant.
    expect(rows.some((r) => r.source_id === "(unclassified)")).toBe(false);
    expect(rows[0]!.embed_coverage_pct).toBe(0);
  });

  it("an empty grant sees no rows", async () => {
    const rows = await collectPerSourceHealth(storage.raw(), []);
    expect(rows).toEqual([]);
  });
});

describe("whole-brain metric is unchanged by the per-source axis", () => {
  it("brainHealthMetrics aggregates all sources as before", async () => {
    const h = await brainHealthMetrics(storage.raw());
    // Embeddable across everything: vault 2 + mail 2 + unclassified 1 = 5.
    // Embedded: vault 2. Code: 1 (mail).
    expect(h.embeddable_chunks).toBe(5);
    expect(h.embedded_chunks).toBe(2);
    expect(h.code_chunks).toBe(1);
    expect(h.embed_coverage_pct).toBeCloseTo(2 / 5, 5);
  });
});
