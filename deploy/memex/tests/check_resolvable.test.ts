/**
 * Smoke tests for `check-resolvable` and the `wikilinkResolver` it
 * depends on. Seeds an in-memory PGLite engine with a mix of resolvable
 * and orphan wikilinks; asserts the coverage math + orphan list.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { wikilinkResolver } from "../src/core/resolvers/builtin/wikilink.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-checkres-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("wikilinkResolver", () => {
  it("resolves when document title matches (case-insensitive)", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/vault/foo.md', 'Foo Bar');
    `);
    const r = await wikilinkResolver.resolve("foo bar", { engine: e });
    expect(r.documentId).toBe("d1");
    expect((r.detail as { sourcePath: string }).sourcePath).toBe("/vault/foo.md");
  });

  it("resolves when filename matches the wikilink name", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/vault/notes/Project Plan.md', 'Different Title');
    `);
    const r = await wikilinkResolver.resolve("Project Plan", { engine: e });
    expect(r.documentId).toBe("d1");
  });

  it("returns null for unknown names", async () => {
    const e = storage.engine();
    const r = await wikilinkResolver.resolve("Nonexistent", { engine: e });
    expect(r.documentId).toBeNull();
  });

  it("returns null for empty input", async () => {
    const e = storage.engine();
    const r = await wikilinkResolver.resolve("   ", { engine: e });
    expect(r.documentId).toBeNull();
  });
});

describe("check-resolvable counts table", () => {
  // Helper to compute the report inline (mirrors runCheckResolvable
  // without needing to hijack stdout). The CLI wrapper is a thin
  // adapter and is exercised via the cli end-to-end smoke when needed.
  async function buildReport(threshold?: number) {
    const e = storage.engine();
    const rows = await e.query<{ name: string; mention_count: number }>(
      `SELECT e.name, COUNT(em.chunk_id)::int AS mention_count
         FROM entities e
         LEFT JOIN entity_mentions em ON em.entity_id = e.id
        WHERE e.type = 'wikilink'
        GROUP BY e.name
        ORDER BY mention_count DESC, e.name`,
    );
    let resolved = 0;
    const orphans: { name: string; mentionCount: number }[] = [];
    for (const row of rows.rows) {
      const res = await wikilinkResolver.resolve(row.name, { engine: e });
      if (res.documentId !== null) resolved++;
      else orphans.push({ name: row.name, mentionCount: row.mention_count });
    }
    const total = rows.rows.length;
    const unresolved = total - resolved;
    const unresolvedRate = total === 0 ? 0 : (unresolved / total) * 100;
    const ok = threshold === undefined ? true : unresolvedRate <= threshold;
    return { ok, total, resolved, unresolved, unresolvedRate, orphans };
  }

  it("counts resolved vs orphan wikilinks correctly", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/vault/foo.md', 'Foo'),
        ('d2', '/vault/bar.md', 'Bar');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('c1', 'd1', 0, 'x'),
        ('c2', 'd2', 0, 'y'),
        ('c3', 'd1', 1, 'z');
      INSERT INTO entities (id, type, name) VALUES
        ('wl:foo',     'wikilink', 'Foo'),
        ('wl:bar',     'wikilink', 'Bar'),
        ('wl:missing', 'wikilink', 'Missing');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wl:foo',     'Foo'),
        ('c2', 'wl:foo',     'Foo'),
        ('c2', 'wl:bar',     'Bar'),
        ('c1', 'wl:missing', 'Missing'),
        ('c2', 'wl:missing', 'Missing'),
        ('c3', 'wl:missing', 'Missing');
    `);
    const r = await buildReport();
    expect(r.total).toBe(3);
    expect(r.resolved).toBe(2);
    expect(r.unresolved).toBe(1);
    expect(r.orphans).toEqual([{ name: "Missing", mentionCount: 3 }]);
  });

  it("ok=true on empty corpus", async () => {
    const r = await buildReport(5);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.unresolvedRate).toBe(0);
  });

  it("threshold gate triggers when unresolved-rate exceeds bound", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES ('d1', '/a.md', 'A');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('c1', 'd1', 0, 'x');
      INSERT INTO entities (id, type, name) VALUES
        ('wl:a',  'wikilink', 'A'),
        ('wl:b',  'wikilink', 'B'),
        ('wl:c',  'wikilink', 'C');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wl:a', 'A'),
        ('c1', 'wl:b', 'B'),
        ('c1', 'wl:c', 'C');
    `);
    const r10 = await buildReport(10);
    // 2 of 3 unresolved → 66.66% > 10% → fails the gate
    expect(r10.ok).toBe(false);
    const r80 = await buildReport(80);
    // 66.66% ≤ 80% → passes
    expect(r80.ok).toBe(true);
  });
});

describe("envelope shape (errors / warnings / deferred / --strict)", () => {
  // Direct-call against the pure helper; the CLI wrapper just adds
  // Storage init + console.log around it.
  async function build(
    opts: Parameters<typeof import("../src/commands/check-resolvable.ts").buildCheckResolvableReport>[1],
  ) {
    const { buildCheckResolvableReport } = await import(
      "../src/commands/check-resolvable.ts"
    );
    return buildCheckResolvableReport(storage.engine(), opts);
  }

  it("emits a warning when orphans exist below threshold; default mode stays ok", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES ('d1', '/a.md', 'A');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('c1', 'd1', 0, 'x');
      INSERT INTO entities (id, type, name) VALUES
        ('wl:a',  'wikilink', 'A'),
        ('wl:b',  'wikilink', 'B');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wl:a', 'A'),
        ('c1', 'wl:b', 'B');
    `);
    const report = await build({});
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]?.rule).toBe("orphans-present");
    expect(report.errors.length).toBe(0);
    expect(report.deferred).toEqual([]);
  });

  it("--strict elevates warnings into exit code 1", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES ('d1', '/a.md', 'A');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('c1', 'd1', 0, 'x');
      INSERT INTO entities (id, type, name) VALUES
        ('wl:a',  'wikilink', 'A'),
        ('wl:b',  'wikilink', 'B');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wl:a', 'A'),
        ('c1', 'wl:b', 'B');
    `);
    const report = await build({ strict: true });
    expect(report.ok).toBe(false);
    expect(report.strict).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it("threshold breach lands in errors, not warnings", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES ('d1', '/a.md', 'A');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('c1', 'd1', 0, 'x');
      INSERT INTO entities (id, type, name) VALUES
        ('wl:a',  'wikilink', 'A'),
        ('wl:b',  'wikilink', 'B'),
        ('wl:c',  'wikilink', 'C');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wl:a', 'A'),
        ('c1', 'wl:b', 'B'),
        ('c1', 'wl:c', 'C');
    `);
    const report = await build({ threshold: 10 });
    // 2 of 3 unresolved → 66.66% > 10%
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.rule).toBe("orphan-rate-above-threshold");
  });

  it("clean corpus: errors and warnings both empty", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/vault/a.md', 'A'),
        ('d2', '/vault/b.md', 'B');
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('c1', 'd1', 0, 'x'),
        ('c2', 'd2', 0, 'y');
      INSERT INTO entities (id, type, name) VALUES
        ('wl:a', 'wikilink', 'A'),
        ('wl:b', 'wikilink', 'B');
      INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES
        ('c1', 'wl:a', 'A'),
        ('c2', 'wl:b', 'B');
    `);
    const report = await build({ strict: true });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.deferred).toEqual([]);
  });
});
