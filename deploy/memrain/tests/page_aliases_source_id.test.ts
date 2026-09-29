/**
 * page_aliases tenant scoping (migration 084): the alias index carries its own
 * source_id, write stamping via putPage, and source-scoped resolution — a
 * scoped caller can neither resolve nor collide with a sibling tenant's
 * declared alias.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  resolveAliasCandidates,
  resolveAliasUnique,
} from "../src/core/page-aliases.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-pa-src-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage
    .engine()
    .query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-b', 'other', '__tenant_b__')
       ON CONFLICT (id) DO NOTHING`,
    );
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("page_aliases source_id (mig084)", () => {
  it("stamps the owning page's source on each alias row", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Bobby"] },
    });
    await putPage(storage, {
      slug: "people/robert",
      type: "person",
      source_id: "tenant-b",
      compiled_truth: { aliases: ["Robby"] },
    });
    const rows = await storage
      .engine()
      .query<{ alias_norm: string; source_id: string; slug: string }>(
        `SELECT alias_norm, source_id, slug FROM page_aliases ORDER BY alias_norm`,
      );
    expect(rows.rows).toEqual([
      { alias_norm: "bobby", source_id: "default", slug: "people/bob" },
      { alias_norm: "robby", source_id: "tenant-b", slug: "people/robert" },
    ]);
  });

  it("scoped resolution never sees a sibling tenant's alias", async () => {
    await putPage(storage, {
      slug: "people/bob",
      type: "person",
      compiled_truth: { aliases: ["Shadow"] },
    });
    await putPage(storage, {
      slug: "people/ghost",
      type: "person",
      source_id: "tenant-b",
      compiled_truth: { aliases: ["Shadow"] },
    });
    // Scoped to tenant-b: exactly ITS claimant, no collision with default's.
    expect(
      await resolveAliasUnique(storage, "shadow", "people/other", ["tenant-b"]),
    ).toBe("people/ghost");
    expect(
      await resolveAliasCandidates(storage, "shadow", ["tenant-b"]),
    ).toEqual([{ slug: "people/ghost", source_id: "tenant-b" }]);
    // Unscoped (operator view): both claimants -> unique resolution declines.
    expect(await resolveAliasUnique(storage, "shadow", "people/other")).toBeNull();
    expect(await resolveAliasCandidates(storage, "shadow")).toHaveLength(2);
  });
});
