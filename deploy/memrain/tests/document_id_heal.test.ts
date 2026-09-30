/**
 * A document stored under an id its source_path does not hash to (migration
 * 099 rewrote `/vault/…` to `/memory/…` in place) must fold into the path's own
 * id on the next local re-read, keeping its owner, instead of growing a twin
 * the owner fence then refuses every tick.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexDocument, indexFile } from "../src/core/indexer.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { embedStalePhase } from "../src/core/cycle/embed-stale.ts";
import { checkDocumentIdDrift } from "../src/core/doctor-tenancy.ts";
import { deterministicEmbed } from "./det-embed.ts";

const ZERO_VEC = `[${Array(1024).fill(0).join(",")}]`;
const offline = (body: string) => `---\nembed_skip: true\n---\n\n${body}\n`;
const embedFn = async (t: string) => deterministicEmbed(t);

let tmp: string;
let vault: string;
let storage: Storage;
let savedVault: string | undefined;

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "memrain-id-heal-")));
  vault = join(tmp, "memory");
  mkdirSync(vault, { recursive: true });
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  savedVault = process.env.MEMRAIN_VAULT_PATHS;
  process.env.MEMRAIN_VAULT_PATHS = vault;
  const e = storage.engine();
  await registerSource(e, { id: "timur", kind: "other", pathPrefix: "tenant:timur" });
  await registerSource(e, { id: "tenant-a", kind: "other", pathPrefix: "/tenants/a" });
});

afterEach(async () => {
  if (savedVault === undefined) delete process.env.MEMRAIN_VAULT_PATHS;
  else process.env.MEMRAIN_VAULT_PATHS = savedVault;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const idFor = (p: string) => `doc_${createHash("sha256").update(p).digest("hex").slice(0, 16)}`;

/** A row as migration 099 left it: path rewritten, id still hashing the old one. */
async function storedDoc(
  id: string,
  sourcePath: string,
  owner: string | null,
  opts: { mtime?: number | null; embeddedDaysAgo?: number } = {},
): Promise<void> {
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter, last_indexed_mtime)
     VALUES ($1, $2, $3, NULL, '{}'::jsonb, $4)`,
    [id, owner, sourcePath, opts.mtime === undefined ? 1 : opts.mtime],
  );
  await e.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content, source_id) VALUES ($1, $2, 0, 'old text', $3)`,
    [`${id}_c0`, id, owner],
  );
  await e.query(
    `INSERT INTO embeddings (chunk_id, vector, model, created_at)
     VALUES ($1, $2::vector, 'test', NOW() - ($3 || ' days')::interval)`,
    [`${id}_c0`, ZERO_VEC, String(opts.embeddedDaysAgo ?? 90)],
  );
}

async function docsAt(sourcePath: string) {
  const r = await storage.engine().query<{ id: string; source_id: string | null }>(
    "SELECT id, source_id FROM documents WHERE source_path = $1 ORDER BY id",
    [sourcePath],
  );
  return r.rows;
}

describe("local re-read of a drifted document id", () => {
  it("folds the legacy row into the path's id, keeping owner, vectors and references", async () => {
    const path = join(vault, "note.md");
    writeFileSync(path, "# note\n\nfresh body about retrieval\n");
    const legacy = idFor(join(tmp, "vault", "note.md"));
    await storedDoc(legacy, path, "timur");
    const e = storage.engine();
    await e.query(
      `INSERT INTO entity_facts (entity_slug, fact, source_chunk_id, source_id)
       VALUES ('people/alice', 'likes tea', $1, 'timur')`,
      [`${legacy}_c0`],
    );
    await e.query(
      `INSERT INTO eval_queries (id, query, tag, expected_doc_id) VALUES ('q1', 'tea', 'good', $1)`,
      [legacy],
    );
    await e.query(`UPDATE documents SET ingested_at = '2026-06-25T00:00:00Z' WHERE id = $1`, [legacy]);

    await indexFile(storage, path, { embedFn, embeddingModel: "det" });

    const canonical = idFor(path);
    expect(await docsAt(path)).toEqual([{ id: canonical, source_id: "timur" }]);
    const ing = await e.query<{ d: string }>(`SELECT ingested_at::date::text AS d FROM documents WHERE id = $1`, [canonical]);
    expect(ing.rows[0]!.d).toBe("2026-06-25");
    const chunks = await e.query<{ id: string; source_id: string | null; embedded: boolean }>(
      `SELECT c.id, c.source_id, (em.chunk_id IS NOT NULL) AS embedded
         FROM chunks c LEFT JOIN embeddings em ON em.chunk_id = c.id
        WHERE c.document_id = $1`,
      [canonical],
    );
    expect(chunks.rows.length).toBeGreaterThan(0);
    for (const c of chunks.rows) {
      expect(c.source_id).toBe("timur");
      expect(c.embedded).toBe(true);
    }
    const orphans = await e.query(`SELECT 1 FROM chunks WHERE document_id = $1`, [legacy]);
    expect(orphans.rows).toEqual([]);
    const fact = await e.query<{ source_chunk_id: string }>(
      `SELECT source_chunk_id FROM entity_facts WHERE entity_slug = 'people/alice'`,
    );
    expect(fact.rows[0]!.source_chunk_id).toBe(`${canonical}_c0`);
    const q = await e.query<{ expected_doc_id: string }>(`SELECT expected_doc_id FROM eval_queries WHERE id = 'q1'`);
    expect(q.rows[0]!.expected_doc_id).toBe(canonical);
  });

  it("embed-stale adopts a NULL-owned twin under the legacy owner and drops the legacy row", async () => {
    const path = join(vault, "twin.md");
    writeFileSync(path, offline("# twin refreshed"));
    const legacy = idFor(join(tmp, "vault", "twin.md"));
    await storedDoc(legacy, path, "timur");
    await storedDoc(idFor(path), path, null, { embeddedDaysAgo: 0 });

    const r = await embedStalePhase(storage.engine(), { staleDays: 30 });
    expect(r.errors).toEqual([]);
    expect(r.reembedded).toBe(1);
    expect(await docsAt(path)).toEqual([{ id: idFor(path), source_id: "timur" }]);
  });

  it("refuses to merge rows two different sources own", async () => {
    const path = join(vault, "split.md");
    writeFileSync(path, offline("# split"));
    const legacy = idFor(join(tmp, "vault", "split.md"));
    await storedDoc(legacy, path, "timur");
    await storedDoc(idFor(path), path, "tenant-a", { mtime: null, embeddedDaysAgo: 0 });

    await expect(indexFile(storage, path)).rejects.toThrow(/owned by another source|belongs to source tenant-a/);
    expect((await docsAt(path)).map((d) => d.source_id).sort()).toEqual(["tenant-a", "timur"]);
  });

  it("keeps a folded row's soft-delete and archive state", async () => {
    const path = join(vault, "retired.md");
    writeFileSync(path, offline("# retired"));
    const legacy = idFor(join(tmp, "vault", "retired.md"));
    await storedDoc(legacy, path, "timur");
    const e = storage.engine();
    await e.query(
      `UPDATE documents
          SET deleted_at = '2026-09-01T00:00:00Z', archived = true,
              archived_at = '2026-09-02T00:00:00Z', archive_expires_at = '2026-10-02T00:00:00Z'
        WHERE id = $1`,
      [legacy],
    );

    const r = await embedStalePhase(e, { staleDays: 30 });
    expect(r.errors).toEqual([]);
    const row = await e.query<{ id: string; deleted: boolean; archived: boolean; at: boolean; expires: boolean }>(
      `SELECT id, deleted_at = '2026-09-01T00:00:00Z' AS deleted, archived,
              archived_at = '2026-09-02T00:00:00Z' AS at, archive_expires_at = '2026-10-02T00:00:00Z' AS expires
         FROM documents WHERE source_path = $1`,
      [path],
    );
    expect(row.rows).toEqual([{ id: idFor(path), deleted: true, archived: true, at: true, expires: true }]);
  });

  it("moves synthesis atoms and takes to the new id", async () => {
    const path = join(vault, "synth.md");
    writeFileSync(path, offline("# synth"));
    const legacy = idFor(join(tmp, "vault", "synth.md"));
    await storedDoc(legacy, path, "timur");
    const e = storage.engine();
    await e.query(
      `INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id)
       VALUES ('ak1', $1, 'document', 'h', 't', 'b', 'm')`,
      [legacy],
    );
    await e.query(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ('tk1', $1, 'h', 'v1', 'c', 'm')`,
      [legacy],
    );

    await indexFile(storage, path);

    const a = await e.query<{ source_ref: string }>(`SELECT source_ref FROM synth_atoms WHERE atom_key = 'ak1'`);
    const t = await e.query<{ source_ref: string }>(`SELECT source_ref FROM synth_takes WHERE take_key = 'tk1'`);
    expect(a.rows[0]!.source_ref).toBe(idFor(path));
    expect(t.rows[0]!.source_ref).toBe(idFor(path));
  });

  it("never folds an unowned legacy row into a row another source owns", async () => {
    const path = join(vault, "labelled.md");
    writeFileSync(path, offline("# local file"));
    await storedDoc(idFor(join(tmp, "vault", "labelled.md")), path, null);
    await storedDoc(idFor(path), path, "tenant-a", { mtime: null, embeddedDaysAgo: 0 });

    const r = await embedStalePhase(storage.engine(), { staleDays: 30 });
    expect(r.reembedded).toBe(0);
    const chunks = await storage.engine().query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1",
      [idFor(path)],
    );
    expect(chunks.rows).toEqual([{ content: "old text" }]);
    expect((await docsAt(path)).length).toBe(2);
  });

  it("refuses a re-read the owner fence would reject before it embeds", async () => {
    const path = join(vault, "owned.md");
    await storedDoc(idFor(path), path, "tenant-a", { mtime: null, embeddedDaysAgo: 0 });
    let calls = 0;
    const counting = async (t: string) => {
      calls++;
      return deterministicEmbed(t);
    };
    await expect(
      indexDocument(storage, { sourcePath: path, text: "# owned\n\nbody\n", expectOwner: null }, { embedFn: counting }),
    ).rejects.toThrow(/owned by another source/);
    expect(calls).toBe(0);
  });

  it("a write that is not a local re-read leaves the legacy row alone", async () => {
    const path = join(vault, "remote.md");
    const legacy = idFor(join(tmp, "vault", "remote.md"));
    await storedDoc(legacy, path, "timur");
    await writeDocumentTransaction(
      storage,
      { documentId: idFor(path), sourcePath: path, title: null, frontmatter: {} },
      [{ text: "inline", entities: [] }],
    );
    expect((await docsAt(path)).map((d) => d.id).sort()).toEqual([idFor(path), legacy].sort());
  });
});

describe("embed-stale owner conflicts", () => {
  it("do not spend the per-tick cap: 60 refused rows still let the valid one through", async () => {
    for (let i = 0; i < 60; i++) {
      const path = join(vault, `a${String(i).padStart(2, "0")}.md`);
      writeFileSync(path, offline(`# conflict ${i}`));
      await storedDoc(idFor(`${path}.legacy`), path, "timur");
      await storedDoc(idFor(path), path, "tenant-a", { mtime: null, embeddedDaysAgo: 0 });
    }
    const valid = join(vault, "z.md");
    writeFileSync(valid, offline("# the valid one"));
    await storedDoc(idFor(valid), valid, "timur");

    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    let r;
    try {
      r = await embedStalePhase(storage.engine(), { staleDays: 30 });
    } finally {
      console.error = orig;
    }
    expect(r.errors).toEqual([]);
    expect(r.rejected).toBe(60);
    expect(r.reembedded).toBe(1);
    const conflictLines = errs.filter((l) => l.includes("owned by another source"));
    expect(conflictLines.length).toBe(1);
    expect(conflictLines[0]).toContain("60 row(s)");
    expect(conflictLines[0]).toContain(join(vault, "a00.md"));
  });
});

describe("document-id-drift doctor check", () => {
  it("counts drifted ids and duplicated paths, then reads ok once healed", async () => {
    const clean = await checkDocumentIdDrift(storage.engine());
    expect(clean.status).toBe("ok");

    const path = join(vault, "drift.md");
    writeFileSync(path, offline("# drift"));
    await storedDoc(idFor(join(tmp, "vault", "drift.md")), path, "timur");
    await storedDoc(idFor(path), path, null, { embeddedDaysAgo: 0 });
    // A page mirror names a row, not a file: never counted.
    await storage.engine().query(
      `INSERT INTO documents (id, source_path, frontmatter) VALUES ('doc_mirror', 'page://timur/x', '{}'::jsonb)`,
    );

    const c = await checkDocumentIdDrift(storage.engine());
    expect(c.status).toBe("warn");
    expect(c.ok).toBe(true);
    expect(c.detail).toStartWith("1 document(s) carry an id");
    expect(c.detail).toContain("1 source_path(s) are stored under more than one id");

    await indexFile(storage, path);
    expect((await checkDocumentIdDrift(storage.engine())).status).toBe("ok");
  });
});
