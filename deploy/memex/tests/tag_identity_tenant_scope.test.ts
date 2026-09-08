/**
 * Two whole-brain reads a scoped caller should never get.
 *
 * `addTag` probed `pages` for the slug with no source filter, so its
 * "page not found" error doubled as a cross-tenant existence oracle: a tenant
 * could enumerate another tenant's slugs one call at a time, learning which
 * exist without ever reading one. `brainIdentity` counted documents, chunks,
 * embeddings, pages and sources across the whole brain, so every tenant was
 * told how much its neighbours hold — and differencing two reads leaks their
 * write rate.
 *
 * Both now scope to the caller. An unscoped caller (local CLI, internal token)
 * still sees everything, which is what the last test in each block pins.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { addTag, getTags } from "../src/core/tags.ts";
import { brainIdentity } from "../src/core/identity.ts";

const A = "tenant-a";
const B = "tenant-b";
const A_SLUG = "notes/a-only";
const B_SLUG = "notes/b-only";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-tag-identity-scope-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: A, kind: "other", pathPrefix: "tenant:a" });
  await registerSource(e, { id: B, kind: "other", pathPrefix: "tenant:b" });

  await putPage(storage, {
    slug: A_SLUG,
    markdown_body: "a body",
    source_id: A,
  });
  await putPage(storage, {
    slug: B_SLUG,
    markdown_body: "b body",
    source_id: B,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("addTag existence probe", () => {
  it("the owning tenant can tag its own page", async () => {
    await addTag(storage, A_SLUG, "own", A);
    expect(await getTags(storage, A_SLUG, [A])).toContain("own");
  });

  it("another tenant's page is indistinguishable from one that does not exist", async () => {
    const foreign = await addTag(storage, A_SLUG, "probe", B).then(
      () => null,
      (e: Error) => e.message,
    );
    const absent = await addTag(storage, "notes/nothing-here", "probe", B).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(foreign).not.toBeNull();
    // The oracle is closed only if the two failures are the same ERROR, not
    // merely if the foreign call fails. Each message quotes its own slug, so
    // compare the shape with the slug substituted out.
    const shape = (m: string | null) =>
      m === null ? null : m.replace(/"[^"]*"/, '"<slug>"');
    expect(shape(foreign)).toBe(shape(absent));
  });

  it("the refused tag leaves no row behind for either tenant", async () => {
    expect(await getTags(storage, A_SLUG, [B])).not.toContain("probe");
    expect(await getTags(storage, A_SLUG, [A])).not.toContain("probe");
  });

  it("an unscoped caller still tags any page", async () => {
    await addTag(storage, B_SLUG, "operator");
    expect(await getTags(storage, B_SLUG)).toContain("operator");
  });
});

describe("brainIdentity tenant scope", () => {
  it("a scoped caller counts only its own pages", async () => {
    const a = await brainIdentity(storage, [A]);
    const b = await brainIdentity(storage, [B]);
    expect(a.pages).toBe(1);
    expect(b.pages).toBe(1);
  });

  it("a scoped caller's source count is its own read set, not the brain's", async () => {
    const a = await brainIdentity(storage, [A]);
    expect(a.sources).toBe(1);
    const both = await brainIdentity(storage, [A, B]);
    expect(both.sources).toBe(2);
    expect(both.pages).toBe(2);
  });

  it("a scoped caller's document count excludes the other tenant's", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO documents (id, source_path, source_id) VALUES ($1, $2, $3)`,
      ["doc-a", "tenant:a/one.md", A],
    );
    await e.query(
      `INSERT INTO documents (id, source_path, source_id) VALUES ($1, $2, $3)`,
      ["doc-b", "tenant:b/one.md", B],
    );
    const a = await brainIdentity(storage, [A]);
    const whole = await brainIdentity(storage);
    expect(a.documents).toBe(1);
    expect(whole.documents).toBe(2);
  });

  it("a grant of NOTHING counts nothing — it must not widen to the whole brain", async () => {
    const none = await brainIdentity(storage, []);
    expect(none.pages).toBe(0);
    expect(none.sources).toBe(0);
    // The fail-closed path hands a sentinel that names no real source.
    const sentinel = await brainIdentity(storage, ["__no_source__"]);
    expect(sentinel.pages).toBe(0);
    expect(sentinel.sources).toBe(0);
  });

  it("counts sources that exist, not entries in the grant", async () => {
    const dup = await brainIdentity(storage, [A, A, "not-a-source"]);
    expect(dup.sources).toBe(1);
  });

  it("an unscoped caller still sees the whole brain", async () => {
    const whole = await brainIdentity(storage);
    expect(whole.pages).toBe(2);
    // Every registered source, including the implicit 'default'.
    expect(whole.sources).toBeGreaterThanOrEqual(2);
  });
});
