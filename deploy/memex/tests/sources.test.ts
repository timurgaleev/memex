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
    expect(all.length).toBe(1);
    expect(all[0]!.sync_policy).toBe("mirror");
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
      INSERT INTO documents (id, source_path, title) VALUES
        ('d1', '/vault/a.md', 'A'),
        ('d2', '/memory/b.md', 'B'),
        ('d3', '/elsewhere/c.md', 'C');
    `);

    const r = await backfillDocumentSources(e);
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
    const r2 = await backfillDocumentSources(e);
    expect(r2.updated).toBe(0);
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
