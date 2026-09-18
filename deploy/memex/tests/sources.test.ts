/**
 * Sources tests — registration, list, path-prefix resolution, backfill.
 * No Bedrock; all SQL.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  backfillDocumentSources,
  listSources,
  registerSource,
  resolveSourceForPath,
} from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-sources-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("sources", () => {
  it("registerSource is idempotent", async () => {
    const e = storage.engine();
    await registerSource(e, {
      id: "vault",
      kind: "vault",
      pathPrefix: "/vault",
    });
    await registerSource(e, {
      id: "vault",
      kind: "vault",
      pathPrefix: "/vault",
      syncPolicy: "mirror", // changed
    });
    const all = await listSources(e);
    // The brain also carries the seeded system 'default' source (migration
    // 047), so assert idempotency on the 'vault' row specifically.
    const vaultRows = all.filter((s) => s.id === "vault");
    expect(vaultRows.length).toBe(1);
    expect(vaultRows[0]!.sync_policy).toBe("mirror");
  });

  it("resolveSourceForPath picks longest prefix match", async () => {
    const e = storage.engine();
    await registerSource(e, {
      id: "vault",
      kind: "vault",
      pathPrefix: "/vault",
    });
    await registerSource(e, {
      id: "vault-projects",
      kind: "vault",
      pathPrefix: "/vault/projects",
    });
    expect(
      await resolveSourceForPath(e, "/vault/projects/foo.md"),
    ).toBe("vault-projects");
    expect(await resolveSourceForPath(e, "/vault/foo.md")).toBe("vault");
    expect(await resolveSourceForPath(e, "/somewhere/else.md")).toBe(null);
  });

  it("backfillDocumentSources assigns source_id to null docs", async () => {
    const e = storage.engine();
    await registerSource(e, {
      id: "vault",
      kind: "vault",
      pathPrefix: "/vault",
    });
    await registerSource(e, {
      id: "memory",
      kind: "memory",
      pathPrefix: "/memory",
    });
    await e.exec(`
      INSERT INTO documents (id, source_path, title, last_indexed_mtime) VALUES
        ('d1', '/vault/a.md', 'A', 1),
        ('d2', '/memory/b.md', 'B', 1),
        ('d3', '/elsewhere/c.md', 'C', 1);
    `);

    const paths = ["/vault/a.md", "/memory/b.md", "/elsewhere/c.md"];
    const r = await backfillDocumentSources(e, paths);
    expect(r.updated).toBe(2);
    expect(r.unmatched).toBe(1);

    const rows = await e.query<{ id: string; source_id: string | null }>(
      `SELECT id, source_id FROM documents ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: "d1", source_id: "vault" },
      { id: "d2", source_id: "memory" },
      { id: "d3", source_id: null },
    ]);

    // Idempotent — second backfill is no-op.
    const r2 = await backfillDocumentSources(e, paths);
    expect(r2.updated).toBe(0);
  });

  it("backfill propagates to chunks and code edges, and matches a prefix literally", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "code", kind: "code", pathPrefix: "/repo-source/" });
    // A prefix carrying a LIKE wildcard, and one that ends mid-name.
    await registerSource(e, { id: "wild", kind: "other", pathPrefix: "/a_b/" });
    await registerSource(e, { id: "notes", kind: "other", pathPrefix: "/vault/team" });
    await e.exec(`
      INSERT INTO documents (id, source_path, title, last_indexed_mtime) VALUES
        ('d1', '/repo-source/a.ts', 'a.ts', 1),
        ('d2', '/axb/b.md', 'B', 1),
        ('d3', '/vault/team-archive/c.md', 'C', 1),
        ('d4', '/vault/team/d.md', 'D', 1);
      INSERT INTO chunks (id, document_id, chunk_index, content) VALUES
        ('c1', 'd1', 0, 'export function a() {}');
      INSERT INTO code_edges_symbol (from_chunk_id, to_symbol_qualified, edge_type)
        VALUES ('c1', 'b', 'calls');
    `);

    const r = await backfillDocumentSources(e, [
      "/repo-source/a.ts",
      "/axb/b.md",
      "/vault/team-archive/c.md",
      "/vault/team/d.md",
    ]);
    expect(r.updated).toBe(2);

    const chunk = await e.query<{ source_id: string | null }>(
      `SELECT source_id FROM chunks WHERE id = 'c1'`,
    );
    expect(chunk.rows[0]?.source_id).toBe("code");
    const edge = await e.query<{ source_id: string | null }>(
      `SELECT source_id FROM code_edges_symbol WHERE from_chunk_id = 'c1'`,
    );
    expect(edge.rows[0]?.source_id).toBe("code");

    const rows = await e.query<{ id: string; source_id: string | null }>(
      `SELECT id, source_id FROM documents WHERE id IN ('d2','d3','d4') ORDER BY id`,
    );
    // `_` in a prefix is a LIKE wildcard, so "/axb/" must not match "/a_b/";
    // and a prefix must end at a path boundary, so "/vault/team" does not own
    // "/vault/team-archive".
    expect(rows.rows).toEqual([
      { id: "d2", source_id: null },
      { id: "d3", source_id: null },
      { id: "d4", source_id: "notes" },
    ]);
    expect(await resolveSourceForPath(e, "/axb/b.md")).toBe(null);
    expect(await resolveSourceForPath(e, "/vault/team-archive/c.md")).toBe(null);
    expect(await resolveSourceForPath(e, "/vault/team/d.md")).toBe("notes");
  });

  it("classifies only the paths a local indexer confirmed", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "tenant", kind: "other", pathPrefix: "/vault/" });
    await e.exec(`
      INSERT INTO documents (id, source_path, title, last_indexed_mtime) VALUES
        ('walked', '/vault/real.md', 'real', 1),
        ('planted', '/vault/injected.md', 'injected', NULL);
    `);
    // The caller passes the paths it just wrote (or confirmed it had already
    // written). A remote `index` call labels its document in the caller's own
    // namespace, and no sweep ever indexed that label, so it is never in the
    // list and never inherits the prefix owner's source.
    const r = await backfillDocumentSources(e, ["/vault/real.md"]);
    expect(r.updated).toBe(1);
    const rows = await e.query<{ id: string; source_id: string | null }>(
      `SELECT id, source_id FROM documents ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: "planted", source_id: null },
      { id: "walked", source_id: "tenant" },
    ]);
  });

  it("registerSource refuses an empty path prefix", async () => {
    await expect(
      registerSource(storage.engine(), { id: "everything", kind: "other", pathPrefix: "" }),
    ).rejects.toThrow(/pathPrefix/);
  });

  it("CHECK constraints reject invalid kind / policy", async () => {
    const e = storage.engine();
    await expect(
      e.query(
        `INSERT INTO sources (id, kind, path_prefix) VALUES ('x', 'bogus', '/x')`,
      ),
    ).rejects.toThrow(/check/i);
  });
});
