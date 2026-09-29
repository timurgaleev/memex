/**
 * rechunk-sweep cycle phase — the automatic, cost-gated re-chunk + re-embed
 * drain for chunker-version-stale documents.
 *
 * Covers: picking + draining a bounded batch, the count cap,
 * the char budget cap, idempotence (fresh docs untouched), resumability across
 * ticks, markdown-only scoping (code docs excluded), tenant preservation, and
 * the missing-file skip. All offline via an injected deterministic embedder.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument, type EmbedFn } from "../src/core/indexer.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { countStaleChunkerDocs } from "../src/core/chunker-version.ts";
import { rechunkSweepPhase } from "../src/core/cycle/rechunk-sweep.ts";
import { registerSource } from "../src/core/sources.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let vault: string;
let storage: Storage;
let savedRoots: { vault?: string; code?: string };

const embed: EmbedFn = async (text) => deterministicEmbed(text);

const body = (n: number) =>
  `## Note ${n}\n\nThis is the body of note ${n}. It carries enough prose to ` +
  `produce a real chunk when the recursive markdown chunker splits it, so the ` +
  `re-embed has something to embed on every tick of the drain sweep.`;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-rechunk-sweep-"));
  vault = mkdtempSync(join(tmpdir(), "memex-rechunk-vault-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // The sweep re-reads only files under the configured roots.
  savedRoots = { vault: process.env.MEMRAIN_VAULT_PATHS, code: process.env.MEMRAIN_CODE_PATHS };
  process.env.MEMRAIN_VAULT_PATHS = vault;
  delete process.env.MEMRAIN_CODE_PATHS;
});
afterEach(async () => {
  if (savedRoots.vault === undefined) delete process.env.MEMRAIN_VAULT_PATHS;
  else process.env.MEMRAIN_VAULT_PATHS = savedRoots.vault;
  if (savedRoots.code === undefined) delete process.env.MEMRAIN_CODE_PATHS;
  else process.env.MEMRAIN_CODE_PATHS = savedRoots.code;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});

/** Create a markdown doc backed by a real file, then force it chunker-stale. */
async function makeStale(
  name: string,
  text: string,
  sourceId: string | null = null,
): Promise<string> {
  const p = join(vault, name);
  writeFileSync(p, text);
  await indexDocument(
    storage,
    { sourcePath: p, text, sourceId },
    { embedFn: embed, embeddingModel: "det" },
  );
  // Simulate a chunker-version bump: drop the stamp below the current markdown
  // version (MARKDOWN_CHUNKER_VERSION = 1 → 0).
  await storage
    .engine()
    .query("UPDATE documents SET chunker_version = 0 WHERE source_path = $1", [p]);
  return p;
}

async function chunkText(sourcePath: string): Promise<string[]> {
  const r = await storage.engine().query<{ content: string }>(
    `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.source_path = $1 ORDER BY c.chunk_index`,
    [sourcePath],
  );
  return r.rows.map((x) => x.content);
}

describe("rechunk-sweep drain", () => {
  it("picks stale docs and re-chunks + re-embeds a bounded batch", async () => {
    await makeStale("a.md", body(1));
    await makeStale("b.md", body(2));
    await makeStale("c.md", body(3));
    expect(await countStaleChunkerDocs(storage.engine())).toBe(3);

    const r = await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });
    expect(r.ran).toBe(true);
    expect(r.scanned).toBe(3);
    expect(r.rechunked).toBe(3);
    expect(r.errors).toEqual([]);
    // Every doc re-stamped to the current version → nothing left stale.
    expect(await countStaleChunkerDocs(storage.engine())).toBe(0);
  });

  it("respects the count cap, leaving the rest for the next tick", async () => {
    await makeStale("a.md", body(1));
    await makeStale("b.md", body(2));
    await makeStale("c.md", body(3));
    await makeStale("d.md", body(4));

    const r = await rechunkSweepPhase(storage.engine(), {
      maxDocs: 2,
      embedFn: embed,
      embeddingModel: "det",
    });
    expect(r.scanned).toBe(2);
    expect(r.rechunked).toBe(2);
    expect(await countStaleChunkerDocs(storage.engine())).toBe(2);
  });

  it("respects the char budget, stopping after one oversized doc", async () => {
    await makeStale("a.md", body(1));
    await makeStale("b.md", body(2));

    const r = await rechunkSweepPhase(storage.engine(), {
      maxChars: 10, // any real body blows this on the first doc
      embedFn: embed,
      embeddingModel: "det",
    });
    expect(r.rechunked).toBe(1);
    expect(r.budgetExhausted).toBe(true);
    // The un-drained doc is still stale.
    expect(await countStaleChunkerDocs(storage.engine())).toBe(1);
  });

  it("is idempotent + resumable — a second tick drains the remainder, then no-ops", async () => {
    await makeStale("a.md", body(1));
    await makeStale("b.md", body(2));
    await makeStale("c.md", body(3));

    const first = await rechunkSweepPhase(storage.engine(), {
      maxDocs: 2,
      embedFn: embed,
      embeddingModel: "det",
    });
    expect(first.rechunked).toBe(2);

    const second = await rechunkSweepPhase(storage.engine(), {
      maxDocs: 2,
      embedFn: embed,
      embeddingModel: "det",
    });
    expect(second.rechunked).toBe(1); // the leftover, no re-doing of the first two
    expect(await countStaleChunkerDocs(storage.engine())).toBe(0);

    const third = await rechunkSweepPhase(storage.engine(), {
      embedFn: embed,
      embeddingModel: "det",
    });
    expect(third.scanned).toBe(0);
    expect(third.rechunked).toBe(0);
  });

  it("never touches a fresh (already-current) doc", async () => {
    // Indexed but NOT decremented → sits at the current version.
    const p = join(vault, "fresh.md");
    writeFileSync(p, body(9));
    await indexDocument(
      storage,
      { sourcePath: p, text: body(9) },
      { embedFn: embed, embeddingModel: "det" },
    );

    const r = await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });
    expect(r.scanned).toBe(0);
    expect(r.rechunked).toBe(0);
  });

  it("excludes code docs — the drain is markdown-only", async () => {
    // A stale CODE doc (kind='code', version below markdown current) must NOT be
    // swept: indexDocument is the markdown path and would mis-stamp it.
    await writeDocumentTransaction(
      storage,
      {
        documentId: "d_code",
        sourcePath: join(vault, "mod.ts"),
        title: "mod.ts",
        frontmatter: { kind: "code" },
        embeddingModel: null,
        chunkerVersion: 0,
      },
      [{ text: "export const x = 1;", entities: [], symbolName: "x" }],
    );

    const r = await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });
    expect(r.scanned).toBe(0);
    expect(r.rechunked).toBe(0);
  });

  it("preserves the owning tenant on re-index", async () => {
    await storage
      .engine()
      .query(
        "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
        ["tenant-x", vault],
      );
    await makeStale("tenant.md", body(5), "tenant-x");

    await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });

    const { rows } = await storage
      .engine()
      .query<{ source_id: string | null }>(
        "SELECT source_id FROM documents WHERE source_path = $1",
        [join(vault, "tenant.md")],
      );
    expect(rows[0]?.source_id).toBe("tenant-x");
  });

  it("skips a stale doc whose source file is gone (orphans-purge collects it)", async () => {
    await writeDocumentTransaction(
      storage,
      {
        documentId: "d_gone",
        sourcePath: join(vault, "gone.md"),
        title: "gone",
        frontmatter: {},
        embeddingModel: "det",
        chunkerVersion: 0,
      },
      [{ text: "body", entities: [] }],
    );

    const r = await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });
    expect(r.scanned).toBe(1);
    expect(r.rechunked).toBe(0);
    expect(r.skippedMissing).toBe(1);
    // Still stale — nothing re-stamped it.
    expect(await countStaleChunkerDocs(storage.engine())).toBe(1);
  });
});

describe("rechunk-sweep: which documents it may re-read from disk", () => {
  it("leaves a tenant's placeholder under an operator path unread and still drains operator docs", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
    const secret = join(vault, "secret.md");
    writeFileSync(secret, "# operator secret");
    // A tenant inline-indexed placeholder text under the operator's path.
    await indexDocument(
      storage,
      { sourcePath: secret, text: "placeholder", sourceId: "tenant-a" },
      { embedFn: embed, embeddingModel: "det" },
    );
    await e.query("UPDATE documents SET chunker_version = 0 WHERE source_path = $1", [secret]);
    const own = await makeStale("own.md", body(1), "vault-src");

    const r = await rechunkSweepPhase(e, { embedFn: embed, embeddingModel: "det" });
    expect(r.errors).toEqual([]);
    expect(r.rechunked).toBe(1);
    expect((await chunkText(secret)).join("\n")).not.toContain("operator secret");
    expect((await chunkText(own)).join("\n")).toContain("body of note 1");
  });

  it("pages past a candidate the guard refuses every tick instead of stalling on it", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault-src", kind: "vault", pathPrefix: vault });
    // Sorts ahead of every note and passes the SQL prefilter, but is a denied name.
    const envFile = await makeStale(".env.example", "SECRET=1", "vault-src");
    const own = await makeStale("own.md", body(1), "vault-src");

    const r = await rechunkSweepPhase(e, { maxDocs: 1, embedFn: embed, embeddingModel: "det" });
    expect(r.errors).toEqual([]);
    expect(r.rejected).toBe(1);
    expect(r.rechunked).toBe(1);
    expect((await chunkText(own)).join("\n")).toContain("body of note 1");
    const { rows } = await e.query<{ v: number }>(
      "SELECT chunker_version AS v FROM documents WHERE source_path = $1",
      [envFile],
    );
    expect(rows[0]?.v).toBe(0);
  });

  it("does not read a daemon file outside the roots into a public label", async () => {
    const outside = join(tmp, "daemon.env.md");
    writeFileSync(outside, "SECRET=1");
    await indexDocument(
      storage,
      { sourcePath: outside, text: "placeholder" },
      { embedFn: embed, embeddingModel: "det" },
    );
    await storage.engine().query("UPDATE documents SET chunker_version = 0 WHERE source_path = $1", [outside]);

    const r = await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });
    expect(r.scanned).toBe(0);
    expect((await chunkText(outside)).join("\n")).not.toContain("SECRET");
  });

  it("keeps a local read's mtime mark on the rows it refreshes", async () => {
    const p = await makeStale("marked.md", body(2));
    await rechunkSweepPhase(storage.engine(), { embedFn: embed, embeddingModel: "det" });
    const { rows } = await storage
      .engine()
      .query<{ m: number | null }>(
        "SELECT last_indexed_mtime AS m FROM documents WHERE source_path = $1",
        [p],
      );
    expect(rows[0]?.m).not.toBeNull();
  });
});
