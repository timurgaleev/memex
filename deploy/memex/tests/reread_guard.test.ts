/**
 * The daemon re-reads a document's file off disk in four places: the vault
 * sweep, the code sweep and the cycle's embed-stale and rechunk-sweep phases. A remote inline
 * `index` labels its document with any path it likes, so each re-read must
 * first prove the row is one a local read would have written: the label's
 * canonical file sits under a root, and the source owning that file is the
 * source owning the row.
 *
 * Offline: the files carry `embed_skip`, so a local index never reaches Titan.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { loadRereadGuard, registerSource } from "../src/core/sources.ts";
import { findChunkerStaleDocs, rechunkSweepPhase } from "../src/core/cycle/rechunk-sweep.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { sweepVault } from "../src/core/sweep.ts";
import { sweepCodeRoots } from "../src/core/sweep-code.ts";
import { embedStalePhase } from "../src/core/cycle/embed-stale.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { runIndex } from "../src/commands/index.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const ZERO_VEC = `[${Array(1024).fill(0).join(",")}]`;
const offline = (body: string) => `---\nembed_skip: true\n---\n\n${body}\n`;

let tmp: string;
let vault: string;
let storage: Storage;
let saved: { vault?: string; code?: string };

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "memex-reread-")));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "a"), { recursive: true });
  mkdirSync(join(vault, "b"), { recursive: true });
  writeFileSync(join(vault, "b", "private.md"), offline("# b private"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  saved = { vault: process.env.MEMEX_VAULT_PATHS, code: process.env.MEMEX_CODE_PATHS };
  process.env.MEMEX_VAULT_PATHS = vault;
  delete process.env.MEMEX_CODE_PATHS;
});

afterEach(async () => {
  if (saved.vault === undefined) delete process.env.MEMEX_VAULT_PATHS;
  else process.env.MEMEX_VAULT_PATHS = saved.vault;
  if (saved.code === undefined) delete process.env.MEMEX_CODE_PATHS;
  else process.env.MEMEX_CODE_PATHS = saved.code;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function twoSources() {
  const e = storage.engine();
  await registerSource(e, { id: "src-a", kind: "vault", pathPrefix: join(vault, "a") });
  await registerSource(e, { id: "src-b", kind: "vault", pathPrefix: join(vault, "b") });
}

/** A row as a remote inline `index` leaves it: no file mtime, a stale vector. */
async function plantedDoc(sourcePath: string, sourceId: string | null) {
  // The id the indexers derive from the label, so a local read collides with it.
  const id = `doc_${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter) VALUES ($1, $2, $3, NULL, '{}'::jsonb)`,
    [id, sourceId, sourcePath],
  );
  await e.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, 'placeholder')`,
    [`${id}c0`, id],
  );
  await e.query(
    `INSERT INTO embeddings (chunk_id, vector, model, created_at)
     VALUES ($1, $2::vector, 'test', NOW() - interval '90 days')`,
    [`${id}c0`, ZERO_VEC],
  );
}

async function chunkText(sourcePath: string): Promise<string[]> {
  const r = await storage.engine().query<{ content: string }>(
    `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.source_path = $1 ORDER BY c.chunk_index`,
    [sourcePath],
  );
  return r.rows.map((x) => x.content);
}

describe("loadRereadGuard", () => {
  it("judges a label by the file a read would open, not by its spelling", async () => {
    await twoSources();
    writeFileSync(join(vault, "a", "own.md"), "# own");
    symlinkSync(join(vault, "b", "private.md"), join(vault, "a", "link.md"));
    const guard = await loadRereadGuard(storage.engine(), [vault]);
    const tenantRow = { sourceId: "src-a", lastIndexedMtime: null };

    const traversal = guard(`${vault}/a/../b/private.md`, tenantRow);
    expect(traversal.ok).toBe(false);
    expect(traversal.canonical).toBe(join(vault, "b", "private.md"));
    expect(guard(join(vault, "a", "link.md"), tenantRow).ok).toBe(false);
    expect(guard(join(vault, "a", "link.md"), null).ok).toBe(false);

    expect(guard(join(vault, "a", "own.md"), tenantRow).ok).toBe(true);
    expect(guard(join(vault, "a", "own.md"), null).ok).toBe(true);
    expect(guard(join(tmp, "elsewhere.md"), null).ok).toBe(false);
  });

  it("an unowned row under a registered prefix needs the mark of a local read", async () => {
    await twoSources();
    writeFileSync(join(vault, "a", "own.md"), "# own");
    const guard = await loadRereadGuard(storage.engine(), [vault]);
    const path = join(vault, "a", "own.md");
    expect(guard(path, { sourceId: null, lastIndexedMtime: null }).ok).toBe(false);
    expect(guard(path, { sourceId: null, lastIndexedMtime: 1 }).ok).toBe(true);
    // Nothing covers the path: an unowned row is what a local read writes.
    expect(guard(join(vault, "loose.md"), { sourceId: null, lastIndexedMtime: null }).ok).toBe(true);
  });
});

/**
 * Runs `plant` right after the sweep reads its snapshot of `documents`, so the
 * row appears while the walk is under way — the window a long sweep leaves a
 * remote `index` to label a file the snapshot has not seen.
 */
function plantAfterSnapshot(plant: () => Promise<void>): () => void {
  return plantAfter("SELECT id, source_id, last_indexed_mtime FROM documents", plant);
}

/** Runs `plant` once, right after the first query whose text is (or matches) `after` (and first param `param`, when given). */
function plantAfter(after: string | RegExp, plant: () => Promise<void>, param?: unknown): () => void {
  const engine = storage.engine();
  const original = engine.query;
  let fired = false;
  engine.query = (async (sql: string, params?: unknown[]) => {
    const r = await original.call(engine, sql, params);
    const hit = typeof after === "string" ? sql === after : after.test(sql);
    if (!fired && hit && (param === undefined || params?.[0] === param)) {
      fired = true;
      await plant();
    }
    return r;
  }) as typeof engine.query;
  return () => {
    engine.query = original;
  };
}

describe("vault sweep", () => {
  it("does not read an operator file into a row a tenant labelled first", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const secret = join(vault, "secret.md");
    writeFileSync(secret, offline("# operator secret"));
    writeFileSync(join(vault, "own.md"), offline("# operator note"));
    await plantedDoc(secret, "tenant-a");

    const r = await sweepVault(storage, { vault });
    expect(r.errors).toEqual([]);
    expect(await chunkText(secret)).toEqual(["placeholder"]);
    const rows = await e.query<{ source_path: string; source_id: string | null }>(
      `SELECT source_path, source_id FROM documents ORDER BY source_path`,
    );
    expect(rows.rows).toContainEqual({ source_path: secret, source_id: "tenant-a" });
    // The sweep still indexes and classifies the operator's own files.
    expect(rows.rows).toContainEqual({ source_path: join(vault, "own.md"), source_id: "vault-src" });
  });

  it("does not read a file into a row a tenant labels after the snapshot", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const secret = join(vault, "new.md");
    writeFileSync(secret, offline("# operator secret"));
    const restore = plantAfterSnapshot(() => plantedDoc(secret, "tenant-a"));
    try {
      const r = await sweepVault(storage, { vault });
      expect(r.errors.map((x) => x.message).join("\n")).toMatch(/belongs to source tenant-a/);
    } finally {
      restore();
    }
    expect(await chunkText(secret)).toEqual(["placeholder"]);
  });

  it("does not read a file into a row a tenant labels after indexFile's own check", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const secret = join(vault, "new.md");
    writeFileSync(secret, offline("# operator secret"));
    const restore = plantAfter(
      /^SELECT source_id, last_indexed_mtime FROM documents WHERE source_path = \$1\b/,
      () => plantedDoc(secret, "tenant-a"),
      secret,
    );
    try {
      const r = await sweepVault(storage, { vault });
      expect(r.errors.map((x) => x.message).join("\n")).toMatch(/owned by another source/);
    } finally {
      restore();
    }
    expect(await chunkText(secret)).toEqual(["placeholder"]);
  });
});

describe("code sweep", () => {
  it("does not read a file into a row a tenant labels after the snapshot", async () => {
    const e = storage.engine();
    const code = join(tmp, "code");
    mkdirSync(code);
    await registerSource(e, { id: "code-src", kind: "code", pathPrefix: code });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const secret = join(code, "secret.ts");
    writeFileSync(secret, "export const token = 'operator secret';\n");
    const restore = plantAfterSnapshot(() => plantedDoc(secret, "tenant-a"));
    try {
      const r = await sweepCodeRoots(storage, { paths: [code] });
      expect(r.reindexed).toBe(0);
      expect(r.errors.map((x) => x.message).join("\n")).toMatch(/belongs to source tenant-a/);
    } finally {
      restore();
    }
    expect(await chunkText(secret)).toEqual(["placeholder"]);
  });
});

describe("embed-stale phase", () => {
  it("re-reads neither a traversal label, a symlink label nor a tenant placeholder", async () => {
    await twoSources();
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    symlinkSync(join(vault, "b", "private.md"), join(vault, "a", "link.md"));
    writeFileSync(join(vault, "secret.md"), offline("# operator secret"));
    const traversal = `${vault}/a/../b/private.md`;
    await plantedDoc(traversal, "src-a");
    await plantedDoc(join(vault, "a", "link.md"), "src-a");
    await plantedDoc(join(vault, "secret.md"), "src-a");

    const r = await embedStalePhase(e, { staleDays: 30 });
    expect(r.reembedded).toBe(0);
    expect(r.errors).toEqual([]);
    expect(await chunkText(traversal)).toEqual(["placeholder"]);
    expect(await chunkText(join(vault, "a", "link.md"))).toEqual(["placeholder"]);
    expect(await chunkText(join(vault, "secret.md"))).toEqual(["placeholder"]);
  });

  it("refreshes an unowned row a local read wrote before its source was registered", async () => {
    const e = storage.engine();
    const path = join(vault, "a", "early.md");
    writeFileSync(path, offline("# refreshed early note"));
    await plantedDoc(path, null);
    await e.query(`UPDATE documents SET last_indexed_mtime = 1 WHERE source_path = $1`, [path]);
    await twoSources();

    const r = await embedStalePhase(e, { staleDays: 30 });
    expect(r.errors).toEqual([]);
    expect(r.reembedded).toBe(1);
    expect((await chunkText(path)).join("\n")).toContain("refreshed early note");
  });

  it("still refreshes operator documents under a symlinked root", async () => {
    const real = join(tmp, "real");
    const link = join(tmp, "link");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    process.env.MEMEX_VAULT_PATHS = link;
    const e = storage.engine();
    await registerSource(e, { id: "op", kind: "vault", pathPrefix: link });
    writeFileSync(join(real, "note.md"), offline("# refreshed note"));
    // Rows store the resolved, not realpath'd, spelling of the root.
    await plantedDoc(join(link, "note.md"), "op");

    const r = await embedStalePhase(e, { staleDays: 30 });
    expect(r.errors).toEqual([]);
    expect(r.reembedded).toBe(1);
    expect((await chunkText(join(link, "note.md"))).join("\n")).toContain("refreshed note");
  });
});

describe("operator index by path", () => {
  it("does not read an operator file into a row a tenant labelled first", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const secret = join(vault, "secret.md");
    writeFileSync(secret, offline("# operator secret"));
    await plantedDoc(secret, "tenant-a");

    const res = await dispatchTool(storage, { name: "index", arguments: { path: secret } }, {});
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/belongs to source tenant-a/);
    expect(await chunkText(secret)).toEqual(["placeholder"]);
    const row = await e.query<{ source_id: string | null }>(
      `SELECT source_id FROM documents WHERE source_path = $1`,
      [secret],
    );
    expect(row.rows).toEqual([{ source_id: "tenant-a" }]);
  });

  it("still indexes an operator file nobody labelled", async () => {
    await registerSource(storage.engine(), { id: "vault-src", kind: "vault", pathPrefix: vault });
    const own = join(vault, "own.md");
    writeFileSync(own, offline("# operator note"));
    const res = await dispatchTool(storage, { name: "index", arguments: { path: own } }, {});
    expect(res.isError).toBeFalsy();
    expect((await chunkText(own)).join("\n")).toContain("operator note");
  });
});

describe("memex index <path>", () => {
  /** Runs the CLI against this test's database; the CLI opens its own handle. */
  async function cliIndex(path: string): Promise<void> {
    const cfg = join(tmp, "config.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        database: { type: "pglite", path: join(tmp, "db") },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    );
    const savedCfg = process.env.MEMEX_CONFIG_PATH;
    process.env.MEMEX_CONFIG_PATH = cfg;
    await storage.close();
    try {
      await runIndex({ path });
    } finally {
      if (savedCfg === undefined) delete process.env.MEMEX_CONFIG_PATH;
      else process.env.MEMEX_CONFIG_PATH = savedCfg;
      storage = new Storage({ dbPath: join(tmp, "db") });
      await storage.init();
    }
  }

  async function owner(sourcePath: string): Promise<(string | null)[]> {
    const r = await storage.engine().query<{ source_id: string | null }>(
      `SELECT source_id FROM documents WHERE source_path = $1`,
      [sourcePath],
    );
    return r.rows.map((x) => x.source_id);
  }

  it("refuses to read an operator file into a row a tenant labelled first", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const note = join(vault, "secret.md");
    const code = join(vault, "secret.ts");
    writeFileSync(note, offline("# operator secret"));
    writeFileSync(code, "export const token = 'operator secret';\n");
    await plantedDoc(note, "tenant-a");
    await plantedDoc(code, "tenant-a");

    for (const path of [note, code]) {
      let err: unknown;
      await cliIndex(path).catch((x: unknown) => {
        err = x;
      });
      expect(String(err)).toMatch(/belongs to source tenant-a/);
      expect(await chunkText(path)).toEqual(["placeholder"]);
      expect(await owner(path)).toEqual(["tenant-a"]);
    }
  });

  it("still indexes and classifies an operator file nobody labelled", async () => {
    await registerSource(storage.engine(), { id: "vault-src", kind: "vault", pathPrefix: vault });
    const own = join(vault, "own.md");
    writeFileSync(own, offline("# operator note"));
    await cliIndex(own);
    expect((await chunkText(own)).join("\n")).toContain("operator note");
    expect(await owner(own)).toEqual(["vault-src"]);
  });
});

describe("inline index labels from remote callers", () => {
  const tenant: AuthInfo = {
    token: "tok-a",
    clientId: "client-a",
    scopes: ["read", "write"],
    sourceId: "tenant-a",
    allowedSources: ["tenant-a"],
    isPublic: false,
  };

  it("refuses a label that is not normalized", async () => {
    await registerSource(storage.engine(), { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    for (const sourcePath of [
      "/tenants/a/../b/private.md",
      "/tenants/a/./x.md",
      "/tenants/a//x.md",
      "../x.md",
      "page://tenant-a/../x",
    ]) {
      const res = await dispatchTool(
        storage,
        { name: "index", arguments: { sourcePath, text: "hi" } },
        { authInfo: tenant },
      );
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/normalized/);
    }
    const n = await storage.engine().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(n.rows[0]?.n).toBe(0);
  });
});

/**
 * The shape a live brain has: the vault root has no covering source, and the
 * operator reassigned its locally read rows to a tenant-style source whose
 * prefix is not a path. Those rows carry a file mtime; an inline `index` row
 * never does.
 */
describe("vault root no source covers", () => {
  const embedFn = async (text: string) => deterministicEmbed(text);
  const tenant: AuthInfo = {
    token: "tok-a",
    clientId: "client-a",
    scopes: ["read", "write"],
    sourceId: "tenant-a",
    allowedSources: ["tenant-a"],
    isPublic: false,
  };

  beforeEach(async () => {
    const e = storage.engine();
    await registerSource(e, { id: "timur", kind: "other", pathPrefix: "tenant:timur" });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
  });

  /** A row a local read wrote and the operator then reassigned to `owner`. */
  async function reassignedDoc(name: string, owner: string | null, mtime: number | null) {
    const path = join(vault, name);
    writeFileSync(path, offline(`# refreshed ${name}`));
    await plantedDoc(path, owner);
    await storage.engine().query(
      `UPDATE documents SET last_indexed_mtime = $2 WHERE source_path = $1`,
      [path, mtime],
    );
    return path;
  }

  async function owner(sourcePath: string): Promise<(string | null)[]> {
    const r = await storage.engine().query<{ source_id: string | null }>(
      `SELECT source_id FROM documents WHERE source_path = $1`,
      [sourcePath],
    );
    return r.rows.map((x) => x.source_id);
  }

  it("the guard passes an owned row with a local read's mtime and refuses one without", async () => {
    const guard = await loadRereadGuard(storage.engine(), [vault]);
    const path = join(vault, "note.md");
    writeFileSync(path, "# note");
    expect(guard(path, { sourceId: "timur", lastIndexedMtime: 1 }).ok).toBe(true);
    expect(guard(path, { sourceId: null, lastIndexedMtime: null }).ok).toBe(true);
    // Without an mtime an owned row is what an inline `index` leaves; refused
    // even for the operator's own reassigned rows until a local read marks them.
    expect(guard(path, { sourceId: "timur", lastIndexedMtime: null }).ok).toBe(false);
    expect(guard(path, { sourceId: "tenant-a", lastIndexedMtime: null }).ok).toBe(false);
    // A source covering the file still has to be the owner, mtime or not.
    await registerSource(storage.engine(), { id: "src-b", kind: "vault", pathPrefix: join(vault, "b") });
    const covered = await loadRereadGuard(storage.engine(), [vault]);
    expect(covered(join(vault, "b", "private.md"), { sourceId: "timur", lastIndexedMtime: 1 }).ok).toBe(false);
  });

  it("the vault sweep refreshes a reassigned row and keeps its owner", async () => {
    const path = await reassignedDoc("note.md", "timur", 1);
    const r = await sweepVault(storage, { vault });
    expect(r.errors).toEqual([]);
    expect((await chunkText(path)).join("\n")).toContain("refreshed note.md");
    expect(await owner(path)).toEqual(["timur"]);
  });

  it("the vault sweep re-reads an unowned row with no mtime", async () => {
    const path = await reassignedDoc("loose.md", null, null);
    const r = await sweepVault(storage, { vault });
    expect(r.errors).toEqual([]);
    expect((await chunkText(path)).join("\n")).toContain("refreshed loose.md");
  });

  it("the vault sweep leaves an owned row without an mtime alone", async () => {
    const path = await reassignedDoc("inline.md", "timur", null);
    const r = await sweepVault(storage, { vault });
    expect(r.errors).toEqual([]);
    expect(await chunkText(path)).toEqual(["placeholder"]);
  });

  it("embed-stale refreshes a reassigned row", async () => {
    const path = await reassignedDoc("note.md", "timur", 1);
    const r = await embedStalePhase(storage.engine(), { staleDays: 30 });
    expect(r.errors).toEqual([]);
    expect(r.reembedded).toBe(1);
    expect((await chunkText(path)).join("\n")).toContain("refreshed note.md");
    expect(await owner(path)).toEqual(["timur"]);
  });

  it("rechunk-sweep refreshes a reassigned row", async () => {
    const path = await reassignedDoc("note.md", "timur", 1);
    await storage.engine().query(`UPDATE documents SET chunker_version = 0 WHERE source_path = $1`, [path]);
    const r = await rechunkSweepPhase(storage.engine(), { embedFn, embeddingModel: "det" });
    expect(r.errors).toEqual([]);
    expect(r.rechunked).toBe(1);
    expect((await chunkText(path)).join("\n")).toContain("refreshed note.md");
    expect(await owner(path)).toEqual(["timur"]);
  });

  it("operator index by path re-indexes a reassigned row", async () => {
    const path = await reassignedDoc("note.md", "timur", 1);
    const res = await dispatchTool(storage, { name: "index", arguments: { path } }, {});
    expect(res.isError).toBeFalsy();
    expect((await chunkText(path)).join("\n")).toContain("refreshed note.md");
    expect(await owner(path)).toEqual(["timur"]);
  });

  it("a tenant row planted under the root with no mtime is still never re-read", async () => {
    const path = await reassignedDoc("secret.md", "tenant-a", null);
    const stale = await embedStalePhase(storage.engine(), { staleDays: 30 });
    expect(stale.reembedded).toBe(0);
    await sweepVault(storage, { vault });
    expect(await chunkText(path)).toEqual(["placeholder"]);
    expect(await owner(path)).toEqual(["tenant-a"]);
  });

  it("refuses a tenant's inline label under a vault root or another source's prefix", async () => {
    for (const sourcePath of [vault, join(vault, "secret.md"), "tenant:timur/x.md"]) {
      const res = await dispatchTool(
        storage,
        { name: "index", arguments: { sourcePath, text: "hi" } },
        { authInfo: tenant },
      );
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/vault\/code root|source timur/);
    }
    const n = await storage.engine().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(n.rows[0]?.n).toBe(0);
    const own = await dispatchTool(
      storage,
      { name: "index", arguments: { sourcePath: "/tenants/a/x.md", text: "hi" } },
      { authInfo: tenant },
    );
    // Offline the write itself fails at embedding; the label was not refused.
    expect(JSON.stringify(own.content)).not.toMatch(/vault\/code root|path prefix/);
  });
});

describe("rereadCandidateWhere roots", () => {
  it("matches a root spelled with a trailing slash, `/`, and a path equal to the root", async () => {
    const path = join(vault, "note.md");
    writeFileSync(path, "# note");
    await plantedDoc(path, null);
    await storage.engine().query(
      `UPDATE documents SET chunker_version = 0, last_indexed_mtime = 1 WHERE source_path = $1`,
      [path],
    );
    const found = async (roots: string[]) =>
      (await findChunkerStaleDocs(storage.engine(), 10, roots)).map((r) => r.source_path);
    expect(await found([`${vault}/`])).toEqual([path]);
    expect(await found(["/"])).toEqual([path]);
    expect(await found([path])).toEqual([path]);
    expect(await found([`${vault}x`])).toEqual([]);
  });
});
