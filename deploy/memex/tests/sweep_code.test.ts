/**
 * sweepCodeRoots tests — fixture trees, mtime-skip, --force, fail-soft
 * on parse errors, missing root reported via perRoot.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { sweepCodeRoots } from "../src/core/sweep-code.ts";
import { registerSource } from "../src/core/sources.ts";
import { normalizeSourcePath } from "../src/core/indexer.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

const dbDir = mkdtempSync(join(tmpdir(), "tb-sweep-code-db-"));
const repoDir = mkdtempSync(join(tmpdir(), "tb-sweep-code-repo-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: dbDir });
  await storage.init();

  // Seed the fake repo.
  mkdirSync(join(repoDir, "src/sub"), { recursive: true });
  mkdirSync(join(repoDir, "node_modules/foo"), { recursive: true });
  writeFileSync(join(repoDir, "src/a.ts"), "export function a() {}\n");
  writeFileSync(join(repoDir, "src/b.ts"), "export function b() {}\n");
  writeFileSync(join(repoDir, "src/sub/c.ts"), "export function c() {}\n");
  writeFileSync(join(repoDir, "src/sub/d.py"), "def d(): pass\n");
  writeFileSync(join(repoDir, "src/sub/skip.txt"), "ignored");
  writeFileSync(join(repoDir, "node_modules/foo/skip.ts"), "no()");
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("sweepCodeRoots", () => {
  it("walks .ts/.tsx/.py only, skips node_modules + .txt", async () => {
    const r = await sweepCodeRoots(storage, { paths: [repoDir] });
    expect(r.scanned).toBe(4); // a, b, c (.ts) + d (.py)
    expect(r.reindexed).toBe(4);
    expect(r.errors.length).toBe(0);
    // Exactly one perRoot entry, present, with file count.
    expect(r.perRoot.length).toBe(1);
    expect(r.perRoot[0]?.files).toBe(4);
    expect(r.perRoot[0]?.missing).toBe(false);
  });

  it("mtime-skips on second run", async () => {
    const r = await sweepCodeRoots(storage, { paths: [repoDir] });
    expect(r.scanned).toBe(4);
    expect(r.reindexed).toBe(0);
    expect(r.skipped).toBe(4);
  });

  it("--force re-indexes regardless of mtime", async () => {
    const r = await sweepCodeRoots(storage, { paths: [repoDir], force: true });
    expect(r.reindexed).toBe(4);
    expect(r.skipped).toBe(0);
  });

  it("re-indexes a file whose mtime advances", async () => {
    // Bump mtime of src/a.ts forward by 60s.
    const now = new Date();
    const future = new Date(now.getTime() + 60_000);
    utimesSync(join(repoDir, "src/a.ts"), future, future);
    const r = await sweepCodeRoots(storage, { paths: [repoDir] });
    expect(r.reindexed).toBe(1);
    expect(r.skipped).toBe(3);
  });

  it("reports a missing root via perRoot, doesn't crash", async () => {
    const ghost = join(tmpdir(), "tb-sweep-code-does-not-exist-xyz");
    const r = await sweepCodeRoots(storage, { paths: [ghost] });
    expect(r.perRoot[0]?.missing).toBe(true);
    expect(r.scanned).toBe(0);
  });

  it("logs but doesn't abort on a parse error", async () => {
    const broken = join(repoDir, "broken.ts");
    writeFileSync(broken, "function broken() { return 1\nfunction other() {}\n");
    const r = await sweepCodeRoots(storage, { paths: [repoDir], force: true });
    // 5 files now scanned (4 originals + broken.ts). All processed
    // (parse error doesn't skip the file, it just sets parseErrors).
    expect(r.scanned).toBe(5);
    expect(r.parseErrors).toBeGreaterThanOrEqual(1);
    expect(r.errors.length).toBe(0);
  });

  it("forceStaleChunker re-indexes a chunker-stale file the mtime check skips", async () => {
    // Simulate a CODE_CHUNKER_VERSION bump for one file: its chunks predate the
    // current chunker but its mtime is unchanged.
    await storage.raw().query(
      "UPDATE documents SET chunker_version = chunker_version - 1 WHERE source_path = $1",
      [join(repoDir, "src/a.ts")],
    );

    // Without the flag the bump drains nothing — the file mtime-skips.
    const plain = await sweepCodeRoots(storage, { paths: [repoDir] });
    expect(plain.reindexed).toBe(0);
    expect(plain.skipped).toBe(5);

    const forced = await sweepCodeRoots(storage, {
      paths: [repoDir],
      forceStaleChunker: true,
    });
    expect(forced.reindexed).toBe(1);
    expect(forced.skipped).toBe(4);
    expect(forced.staleChunkerUnreached).toBeUndefined();

    // Re-indexing re-stamps the version, so the drain is resumable + idempotent.
    const again = await sweepCodeRoots(storage, {
      paths: [repoDir],
      forceStaleChunker: true,
    });
    expect(again.reindexed).toBe(0);
  });

  it("reports a stale code doc the walk never reaches, ignores stale markdown", async () => {
    await storage.raw().query(
      `INSERT INTO documents (id, source_path, title, frontmatter, chunker_version)
       VALUES ('doc_gone_code', '/gone/x.ts', 'x.ts', '{"kind":"code"}'::jsonb, 0),
              ('doc_stale_md', '/gone/x.md', 'x', '{}'::jsonb, 0)`,
    );
    const r = await sweepCodeRoots(storage, {
      paths: [repoDir],
      forceStaleChunker: true,
    });
    // The code doc's file is outside every root → it stays stale, and saying so
    // beats reporting a clean drain.
    expect(r.staleChunkerUnreached).toContain("doc_gone_code");
    // The markdown doc is the VAULT sweep's corpus — a walk over .ts/.py files
    // could never reach it, so listing it here would be a phantom orphan.
    expect(r.staleChunkerUnreached).not.toContain("doc_stale_md");
  });

  it("does not classify a document at a path the walk never indexed", async () => {
    await registerSource(storage.raw(), {
      id: "repo",
      kind: "code",
      pathPrefix: `${repoDir}/`,
    });
    // Classify the existing tree first, so the next pass mtime-skips it and the
    // confirmed-path list is NOT empty — an empty list would pass this for free.
    await sweepCodeRoots(storage, { paths: [repoDir] });

    // A real file the walk reaches last, plus the row a remote inline `index`
    // call would have left at that label: no mtime stamp, so it cannot skip.
    const plantedPath = join(repoDir, "src", "zz_planted.ts");
    writeFileSync(plantedPath, "export function planted() {}\n");
    await storage.raw().query(
      `INSERT INTO documents (id, source_path, title, frontmatter, last_indexed_mtime)
       VALUES ('planted', $1, 'planted', '{"kind":"code"}'::jsonb, NULL)`,
      [normalizeSourcePath(plantedPath)],
    );

    // No `force`: the earlier files skip (and so ARE confirmed), while the file
    // budget breaks the walk at zz_planted.ts before it is ever indexed.
    const r = await sweepCodeRoots(storage, { paths: [repoDir], maxFiles: 0 });
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.reindexed).toBe(0);

    const row = await storage.raw().query<{ source_id: string | null }>(
      `SELECT source_id FROM documents WHERE id = 'planted'`,
    );
    expect(row.rows[0]?.source_id).toBe(null);
    // ...and the case cannot pass by classifying nothing at all.
    const real = await storage.raw().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents
        WHERE source_path = ANY($1::text[]) AND source_id = 'repo'`,
      [[
        normalizeSourcePath(join(repoDir, "src", "a.ts")),
        normalizeSourcePath(join(repoDir, "src", "b.ts")),
      ]],
    );
    expect(real.rows[0]?.n).toBe(2);
  });

  it("classifies the swept documents under the source that owns their path", async () => {
    await registerSource(storage.raw(), {
      id: "repo",
      kind: "code",
      pathPrefix: `${repoDir}/`,
    });
    await sweepCodeRoots(storage, { paths: [repoDir] });
    // The sweep itself indexes with no source (a trusted local caller is not
    // fenced); the path prefixes classify the rows afterwards, so a scoped
    // caller's code graph can see them at all.
    const rows = await storage.raw().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents
        WHERE source_path LIKE $1 || '%' AND source_id IS DISTINCT FROM 'repo'
          -- the row the previous case planted at a path no walk indexed
          AND id <> 'planted'`,
      [`${repoDir}/`],
    );
    expect(rows.rows[0]?.n).toBe(0);
    const chunks = await storage.raw().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = 'repo' AND c.source_id IS NULL`,
    );
    expect(chunks.rows[0]?.n).toBe(0);
  });
});
