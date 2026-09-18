/**
 * Sweep tests — exercise just the directory walk + change-detection logic.
 * The indexFile call inside the sweep makes a real Bedrock call, so we
 * avoid invoking it: instead we test the walker indirectly by seeding a
 * fresh dir tree and checking what sweepVault enumerates via its result
 * counts. Files with mtime <= last_indexed_mtime are "skipped".
 *
 * We don't run sweep with embeddings here. PGLite + entity insertion is
 * covered by the existing storage/health tests.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import { sweepVault } from "../src/core/sweep.ts";
import { normalizeSourcePath } from "../src/core/indexer.ts";
import { registerSource } from "../src/core/sources.ts";

// Pull the internal walkMarkdown by re-implementing the same readdirSync
// + suffix filter logic. We can't import a non-exported helper, but the
// behaviour is small and the cost of duplicating it for the test is low.
import { readdirSync, statSync } from "node:fs";

function* walk(root: string, ignore: ReadonlySet<string>): Generator<string> {
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (ignore.has(ent.name)) continue;
    const full = join(root, ent.name);
    if (ent.isDirectory()) yield* walk(full, ignore);
    else if (ent.isFile() && ent.name.endsWith(".md")) yield full;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "memex-sweep-test-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("vault walk (mirror of sweep's walker)", () => {
  it("finds .md files recursively", () => {
    mkdirSync(join(tmp, "a/b"), { recursive: true });
    writeFileSync(join(tmp, "a/one.md"), "# one");
    writeFileSync(join(tmp, "a/b/two.md"), "# two");
    writeFileSync(join(tmp, "a/b/three.txt"), "skip");

    const files = [...walk(tmp, new Set())];
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith("/one.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("/two.md"))).toBe(true);
  });

  it("skips ignored directory names", () => {
    mkdirSync(join(tmp, ".obsidian"), { recursive: true });
    writeFileSync(join(tmp, ".obsidian/cfg.md"), "# nope");
    const files = [...walk(tmp, new Set([".obsidian"]))];
    expect(files.some((f) => f.includes(".obsidian"))).toBe(false);
  });

  it("statSync.mtime is well-defined for fresh files", () => {
    const f = join(tmp, "fresh.md");
    writeFileSync(f, "# fresh");
    expect(statSync(f).mtimeMs).toBeGreaterThan(0);
  });
});

// The vault sweep classifies the documents it indexed under the source whose
// path_prefix owns their path. Neither branch this test exercises calls the
// indexer, so it needs no embedder: the skipped file proves a confirmed path is
// classified, and the file the budget break never reaches proves a row planted
// at a path the walk merely SAW is not.
describe("vault sweep source classification", () => {
  it("classifies the file it confirmed, not the one it never indexed", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "memex-sweep-src-db-"));
    const vault = mkdtempSync(join(tmpdir(), "memex-sweep-src-vault-"));
    const storage = new Storage({ dbPath: dbDir });
    await storage.init();
    try {
      await registerSource(storage.raw(), {
        id: "vault",
        kind: "vault",
        pathPrefix: `${vault}/`,
      });

      const confirmed = join(vault, "a-confirmed.md");
      const planted = join(vault, "zz-planted.md");
      writeFileSync(confirmed, "# confirmed\n\nbody\n");
      writeFileSync(planted, "# planted\n\nbody\n");
      // The sweep finds a row by the id it derives from the canonical path, so
      // the fixtures have to carry that same id.
      const idFor = (p: string) =>
        `doc_${createHash("sha256").update(normalizeSourcePath(p)).digest("hex").slice(0, 16)}`;
      const rows: [string, string, string, number | null][] = [
        // Already indexed by an earlier local sweep, newer than the file → skipped.
        [idFor(confirmed), "confirmed", normalizeSourcePath(confirmed), Math.floor(statSync(confirmed).mtimeMs) + 10_000],
        // The shape a remote inline `index` leaves: the caller's label, no mtime.
        [idFor(planted), "planted", normalizeSourcePath(planted), null],
      ];
      for (const [id, title, sourcePath, mtime] of rows) {
        await storage.raw().query(
          `INSERT INTO documents (id, source_path, title, last_indexed_mtime)
           VALUES ($1, $2, $3, $4)`,
          [id, sourcePath, title, mtime],
        );
      }

      // maxFiles 0: the walk skips the first file, then breaks on the second
      // before indexing it. No indexFile call, so no embedder is needed.
      const r = await sweepVault(storage, { vault, maxFiles: 0 });
      expect(r.skipped).toBe(1);
      expect(r.reindexed).toBe(0);

      const out = await storage.raw().query<{ title: string; source_id: string | null }>(
        `SELECT title, source_id FROM documents ORDER BY title`,
      );
      expect(out.rows).toEqual([
        { title: "confirmed", source_id: "vault" },
        { title: "planted", source_id: null },
      ]);
    } finally {
      await storage.close();
      rmSync(dbDir, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
