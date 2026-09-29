/**
 * Embed targeting (`memex embed <slug> / --slugs / --all / --source`) —
 * the scoped forceReembed path in core/embed-backfill.ts. Pins: slug scope
 * (raw path, page:// mirror, .md twin), source scope, whole-corpus --all,
 * dry-run accounting, and that out-of-scope embeddings survive untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { runEmbedBackfill } from "../src/core/embed-backfill.ts";
import { registerSource } from "../src/core/sources.ts";
import { deterministicEmbed } from "./det-embed.ts";

const detEmbed = (t: string) => Promise.resolve(deterministicEmbed(t));

const dir = mkdtempSync(join(tmpdir(), "memex-embed-target-"));
let storage: Storage;

async function vectorOf(chunkId: string): Promise<string | null> {
  const r = await storage
    .engine()
    .query<{ v: string }>(
      "SELECT vector::text AS v FROM embeddings WHERE chunk_id = $1",
      [chunkId],
    );
  return r.rows[0]?.v ?? null;
}

async function embeddingCount(): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM embeddings");
  return r.rows[0]?.n ?? 0;
}

async function seed(): Promise<void> {
  await registerSource(storage.engine(), {
    id: "tenant-b",
    kind: "other",
    pathPrefix: "notes/",
  });
  // Fully embedded page mirror (default tenant).
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_page",
      sourcePath: "page://people/alice",
      title: "Alice",
      frontmatter: {},
      embeddingModel: "det",
    },
    [
      {
        text: "alice works on retrieval",
        entities: [],
        embedding: deterministicEmbed("alice works on retrieval"),
      },
    ],
  );
  // Fully embedded file twin under a non-default source.
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_file",
      sourcePath: "notes/bob.md",
      title: "Bob",
      frontmatter: {},
      embeddingModel: "det",
      sourceId: "tenant-b",
    },
    [
      {
        text: "bob writes about vectors",
        entities: [],
        embedding: deterministicEmbed("bob writes about vectors"),
      },
    ],
  );
  // Un-embedded markdown doc (the plain-backfill candidate).
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc_missing",
      sourcePath: "notes/carol.md",
      title: "Carol",
      frontmatter: {},
      embeddingModel: "det",
    },
    [{ text: "carol has no vector yet", entities: [] }],
  );
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
  await seed();
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("embed targeting", () => {
  it("dry-run reports missing + force-cleared without writing", async () => {
    const r = await runEmbedBackfill(storage.engine(), {
      dryRun: true,
      embed: detEmbed,
      slugs: ["people/alice"],
      forceReembed: true,
    });
    expect(r.forceCleared).toBe(1); // alice's existing vector would drop
    expect(r.candidates).toBe(1); // …and re-embed (missing carol is out of scope)
    expect(await embeddingCount()).toBe(2); // nothing written
  });

  it("re-embeds exactly the targeted slug (page:// mirror form)", async () => {
    const before = await vectorOf("doc_page_c0");
    const bobBefore = await vectorOf("doc_file_c0");
    const r = await runEmbedBackfill(storage.engine(), {
      embed: (t) => Promise.resolve(deterministicEmbed(t + " reembedded")),
      slugs: ["people/alice"],
      forceReembed: true,
    });
    expect(r.forceCleared).toBe(1);
    expect(r.embedded).toBe(1);
    const after = await vectorOf("doc_page_c0");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before); // the vector actually changed
    expect(await vectorOf("doc_file_c0")).toBe(bobBefore); // out of scope untouched
    // carol (missing, out of scope) stayed un-embedded.
    expect(await vectorOf("doc_missing_c0")).toBeNull();
  });

  it("matches the .md file twin by bare slug and scopes by --source", async () => {
    // slug 'notes/bob' matches 'notes/bob.md'; source scope must agree.
    const wrongSource = await runEmbedBackfill(storage.engine(), {
      dryRun: true,
      embed: detEmbed,
      slugs: ["notes/bob"],
      sourceId: "default",
      forceReembed: true,
    });
    expect(wrongSource.forceCleared).toBe(0); // bob is tenant-b, not default
    const rightSource = await runEmbedBackfill(storage.engine(), {
      dryRun: true,
      embed: detEmbed,
      slugs: ["notes/bob"],
      sourceId: "tenant-b",
      forceReembed: true,
    });
    expect(rightSource.forceCleared).toBe(1);
  });

  it("--all re-embeds the whole embeddable corpus and fills the gaps", async () => {
    const r = await runEmbedBackfill(storage.engine(), {
      embed: detEmbed,
      forceReembed: true, // the --all mapping (no slug scope)
    });
    expect(r.forceCleared).toBe(2); // alice + bob dropped and re-embedded
    expect(r.embedded).toBe(3); // …plus carol finally embedded
    expect(await embeddingCount()).toBe(3);
    expect(await vectorOf("doc_missing_c0")).not.toBeNull();
  });
});
