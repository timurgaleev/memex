/**
 * Directory names the sweeps skip, under the current and the pre-rename
 * project name. The markdown walks (vault sweep, integrity) skip a brain
 * folder and the local data dir under both names; the code sweep skips only
 * the dotted data dirs, because a package directory named after the project
 * (`deploy/memrain/`, and `deploy/memex/` before the rename) is source.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import { sweepVault } from "../src/core/sweep.ts";
import { sweepCodeRoots } from "../src/core/sweep-code.ts";
import { runIntegrity } from "../src/commands/integrity.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { normalizeSourcePath } from "../src/core/indexer.ts";

const BRAIN_DIRS = ["memex", ".memex", "memrain", ".memrain"];

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-sweep-ignores-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  _resetParsersForTests();
});

function tree(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

describe("markdown walks", () => {
  const vault = () =>
    tree(join(tmp, "vault"), {
      "keep.md": "# keep\n",
      ...Object.fromEntries(BRAIN_DIRS.map((d) => [`${d}/skipped.md`, "# skipped\n"])),
    });

  it("the vault sweep skips a brain folder and data dir under both names", async () => {
    const root = vault();
    // Every candidate already carries a newer index, so each file the walk
    // reaches is counted and skipped without an embedder.
    for (const rel of ["keep.md", ...BRAIN_DIRS.map((d) => `${d}/skipped.md`)]) {
      const sourcePath = normalizeSourcePath(join(root, rel));
      await storage.raw().query(
        "INSERT INTO documents (id, source_path, title, last_indexed_mtime) VALUES ($1, $2, $3, $4)",
        [`doc_${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`, sourcePath, rel, Date.now() + 60_000],
      );
    }
    const r = await sweepVault(storage, { vault: root });
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("integrity skips the same directories", async () => {
    const root = vault();
    const cfgPath = join(tmp, "cfg", "config.json");
    tree(join(tmp, "cfg"), {
      "config.json": JSON.stringify({
        database: { type: "pglite", path: join(tmp, "integrity-db") },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    });
    const saved = process.env.MEMRAIN_CONFIG_PATH;
    const origLog = console.log;
    const out: string[] = [];
    process.env.MEMRAIN_CONFIG_PATH = cfgPath;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      await runIntegrity({ vault: root });
    } finally {
      console.log = origLog;
      if (saved === undefined) delete process.env.MEMRAIN_CONFIG_PATH;
      else process.env.MEMRAIN_CONFIG_PATH = saved;
    }
    const summary = JSON.parse(out.join("\n")) as { files_on_disk: number; details: { on_disk_only: string[] } };
    expect(summary.files_on_disk).toBe(1);
    expect(summary.details.on_disk_only).toEqual([join(root, "keep.md")]);
  });
});

describe("code sweep", () => {
  it("indexes a package directory under either name and skips the dotted data dirs", async () => {
    const repo = tree(join(tmp, "repo"), {
      "deploy/memrain/src/x.ts": "export const x = 1;\n",
      "deploy/memex/src/y.ts": "export const y = 1;\n",
      ".memrain/z.ts": "export const z = 1;\n",
      ".memex/w.ts": "export const w = 1;\n",
    });
    const r = await sweepCodeRoots(storage, { paths: [repo] });
    expect(r.errors).toEqual([]);
    expect(r.scanned).toBe(2);
    const rows = await storage.raw().query<{ source_path: string }>(
      "SELECT source_path FROM documents WHERE source_path LIKE $1 ORDER BY source_path",
      [`%${"repo"}%`],
    );
    const paths = rows.rows.map((row) => row.source_path);
    expect(paths.some((p) => p.endsWith("deploy/memrain/src/x.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("deploy/memex/src/y.ts"))).toBe(true);
    expect(paths.some((p) => p.includes("/.memrain/") || p.includes("/.memex/"))).toBe(false);
  });
});
