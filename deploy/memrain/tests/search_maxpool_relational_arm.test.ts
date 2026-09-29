/**
 * Hermetic integration coverage (PGLite, no Bedrock) for three additive search
 * features, all default-OFF and opt-in:
 *
 *   1. per-page max-pool  — each retrieval arm returns its best chunk per
 *      (source, document), so a noisy multi-chunk page can't crowd another
 *      page's best chunk out of the fanout;
 *   2. relational auto-arm — the deterministic typed-edge fan-out fused as a
 *      4th RRF arm surfaces a relationship answer the lexical/vector arms miss;
 *   3. search --explain    — per-signal attribution stamped on each hit.
 *
 * The deterministic embedder (det-embed.ts) drives the vector arm; intent is
 * overridden and expansion/cache disabled so the path is fully deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");
const embedFn = async (text: string) => deterministicEmbed(text);

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-maxpool-rel-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // --- Max-pool corpus: one noisy multi-chunk page + one single-chunk page,
  // both matching the term "alpha". Document ids sort so "doc-multi" < "doc-solo",
  // and every "alpha" chunk ties on ts_rank → without pooling the three
  // doc-multi chunks fill a limit-3 cut and starve doc-solo.
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc-multi",
      sourcePath: "/doc-multi.md",
      title: "doc-multi",
      frontmatter: {},
      embeddingModel: "deterministic-test",
    },
    [
      { text: "alpha one section", entities: [], embedding: deterministicEmbed("alpha one section") },
      { text: "alpha two section", entities: [], embedding: deterministicEmbed("alpha two section") },
      { text: "alpha three section", entities: [], embedding: deterministicEmbed("alpha three section") },
    ],
  );
  await writeDocumentTransaction(
    storage,
    {
      documentId: "doc-solo",
      sourcePath: "/doc-solo.md",
      title: "doc-solo",
      frontmatter: {},
      embeddingModel: "deterministic-test",
    },
    [{ text: "alpha lonely section", entities: [], embedding: deterministicEmbed("alpha lonely section") }],
  );

  // --- Relational corpus: a typed-edge graph whose people pages do NOT mention
  // the query terms in their body, so ONLY the relational arm can surface them.
  const pages: Array<[string, string, string]> = [
    ["people/alice-smith", "person", "Alice enjoys hiking and photography."],
    ["people/bob", "person", "Bob collects vintage synthesizers."],
    ["companies/acme", "company", "Acme builds industrial widgets and gears."],
  ];
  for (const [slug, type, body] of pages) {
    await putPage(storage, { slug, type, title: slug, markdown_body: body });
    await indexPageIntoSearch(storage, { slug, title: slug, markdown_body: body }, { embedFn });
  }
  await addLink(storage, {
    source_slug: "people/alice-smith",
    target_slug: "companies/acme",
    type: "works_at",
    allowAdHocType: true,
  });
  await addLink(storage, {
    source_slug: "people/bob",
    target_slug: "companies/acme",
    type: "works_at",
    allowAdHocType: true,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("per-page max-pool", () => {
  it("keyword arm: pooling rescues a page crowded out by a noisy neighbor", async () => {
    const flat = await keywordSearch(storage.engine(), "alpha", 3, { maxPool: false });
    const pooled = await keywordSearch(storage.engine(), "alpha", 3, { maxPool: true });

    // Without pooling, doc-multi's three chunks fill the top-3 and doc-solo is
    // starved out.
    expect(new Set(flat.map(toDocId))).not.toContain("doc-solo");
    // With pooling, each page is represented once → both pages survive.
    const pooledDocs = pooled.map(toDocId);
    expect(new Set(pooledDocs)).toEqual(new Set(["doc-multi", "doc-solo"]));
    // No document appears twice in the pooled result.
    expect(pooledDocs.length).toBe(new Set(pooledDocs).size);
  });

  it("vector arm: pooling returns at most one chunk per document", async () => {
    const qv = await deterministicEmbedQuery("alpha");
    const pooled = await vectorSearch(storage.engine(), qv, 5, { maxPool: true });
    const docs = pooled.map(toDocId);
    expect(docs.length).toBe(new Set(docs).size);
    expect(new Set(docs)).toContain("doc-solo");
  });
});

describe("relational auto-arm", () => {
  it("surfaces edge-derived people that lexical/vector search misses", async () => {
    // Force keyword-only (throwing embedder → vector arm dropped) so the people
    // pages, which share no lexical token with the query, are unreachable WITHOUT
    // the relational arm — the tiny corpus's vector arm would otherwise return
    // every page and mask the arm's contribution.
    const noEmbed = async (): Promise<number[]> => {
      throw new Error("no-vector");
    };
    const base = {
      k: 8,
      intent: "topic" as const,
      noExpansion: true,
      noCache: true,
      embedQuery: noEmbed,
    };
    const withoutArm = await hybridSearch(storage, "who works at acme", base);
    const withArm = await hybridSearch(storage, "who works at acme", {
      ...base,
      relationalArm: true,
    });

    const slugs = (hits: { sourcePath: string }[]) => new Set(hits.map((h) => h.sourcePath));
    // The people pages carry none of the query terms → absent without the arm.
    expect(slugs(withoutArm)).not.toContain("page://people/alice-smith");
    // The relational arm injects them via the inbound works_at edge.
    const armSlugs = slugs(withArm);
    expect(armSlugs).toContain("page://people/alice-smith");
    expect(armSlugs).toContain("page://people/bob");
  });

  it("is a pure no-op for a non-relational query", async () => {
    const base = {
      k: 8,
      intent: "topic" as const,
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
    };
    const off = await hybridSearch(storage, "industrial widgets gears", base);
    const on = await hybridSearch(storage, "industrial widgets gears", {
      ...base,
      relationalArm: true,
    });
    expect(on.map((h) => h.sourcePath)).toEqual(off.map((h) => h.sourcePath));
  });
});

describe("search --explain", () => {
  it("stamps a per-signal attribution record on every hit when opted in", async () => {
    const hits = await hybridSearch(storage, "alpha", {
      k: 5,
      intent: "topic",
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
      explain: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.explain).toBeDefined();
      expect(Number.isFinite(h.explain!.base)).toBe(true);
      expect(h.explain!.final).toBeCloseTo(h.score);
    }
  });

  it("adds no explain record when the flag is off (zero-cost default)", async () => {
    const hits = await hybridSearch(storage, "alpha", {
      k: 5,
      intent: "topic",
      noExpansion: true,
      noCache: true,
      embedQuery: deterministicEmbedQuery,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.explain === undefined)).toBe(true);
  });
});
