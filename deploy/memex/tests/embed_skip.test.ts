/**
 * embed-skip marker — the predicate, the SQL fragment, and the inline-indexer
 * gate. A page marked `embed_skip` is indexed + keyword-searchable but never
 * embedded; its chunks land with no embeddings row.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import {
  EMBED_SKIP_KEY,
  isEmbedSkipped,
  embedSkipFilterFragment,
} from "../src/core/embed-skip.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

describe("isEmbedSkipped", () => {
  it("is true only when the marker key is present (any value)", () => {
    expect(isEmbedSkipped({ [EMBED_SKIP_KEY]: true })).toBe(true);
    expect(isEmbedSkipped({ [EMBED_SKIP_KEY]: { reason: "oversized" } })).toBe(true);
    expect(isEmbedSkipped({ [EMBED_SKIP_KEY]: false })).toBe(true); // key-existence, not truthiness
    expect(isEmbedSkipped({ kind: "code" })).toBe(false);
    expect(isEmbedSkipped({})).toBe(false);
    expect(isEmbedSkipped(null)).toBe(false);
    expect(isEmbedSkipped(undefined)).toBe(false);
  });
});

describe("embedSkipFilterFragment", () => {
  it("emits a NOT-key-exists boolean and rejects an unsafe alias", () => {
    expect(embedSkipFilterFragment("d")).toBe(
      `NOT (COALESCE(d.frontmatter, '{}'::jsonb) ? 'embed_skip')`,
    );
    expect(() => embedSkipFilterFragment("d; DROP TABLE x")).toThrow();
  });
});

describe("indexDocument embed-skip gate", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-embed-skip-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function embCount(): Promise<number> {
    const r = await storage.engine().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM embeddings");
    return r.rows[0]?.n ?? 0;
  }

  it("indexes chunks but writes no embeddings for an embed_skip page", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/notes/skip.md", text: "---\nembed_skip: true\n---\n\nbody one\n\nbody two" },
      { embedFn: detEmbed },
    );
    const chunks = await storage.engine().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM chunks");
    expect(chunks.rows[0]?.n).toBeGreaterThan(0); // chunks land (keyword-searchable)
    expect(await embCount()).toBe(0); // but no vectors
  });

  it("embeds normally when the marker is absent", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/notes/normal.md", text: "# Title\n\nbody one\n\nbody two" },
      { embedFn: detEmbed },
    );
    expect(await embCount()).toBeGreaterThan(0);
  });
});
