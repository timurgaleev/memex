/**
 * A mutation to the fusion weights must move the metric beyond the bootstrap
 * interval — otherwise the interval is too wide to catch a real regression.
 *
 * Hermetic: a PGLite corpus seeded with the deterministic embedder, the real
 * vectorSearch / keywordSearch arms, and the real reciprocalRankFusion. Each
 * "contested" query has a relevant doc the vector arm ranks first and the
 * keyword arm ranks second, behind a keyword-stuffed distractor the vector arm
 * ranks third. Correct weights keep the relevant doc on top; silencing the
 * vector arm hands rank 1 to the distractor.
 *
 * rrf.ts treats a non-positive weight as 1, so "silenced" is a vanishing
 * positive weight rather than 0.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { reciprocalRankFusion } from "../src/core/rrf.ts";
import { rrfWeightsForLists } from "../src/core/search/intent-weights.ts";
import { reciprocalRank } from "../src/core/search/metrics.ts";
import { bootstrapMeanCI, pairedBootstrapDeltaCI } from "../src/core/search/bootstrap.ts";
import { deterministicEmbed } from "./det-embed.ts";

const POOL = 20;
const TOPICS = [
  "falcon", "harbor", "glacier", "copper", "meadow", "lantern",
  "orchid", "quartz", "tundra", "violet", "walnut", "zephyr",
];
const FILLER =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud " +
  "exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure";

const CORPUS: { id: string; content: string }[] = [];
const QRELS: { id: string; query: string; relevant: string[] }[] = [];

for (const t of TOPICS) {
  const q = `${t}alpha ${t}beta`;
  // Exact match: cosine 1 (vector rank 1), one FTS cover (keyword rank 2).
  CORPUS.push({ id: `rel_${t}`, content: q });
  // Three FTS covers plus filler: keyword rank 1, low cosine (vector rank 3).
  CORPUS.push({ id: `stuffed_${t}`, content: `${q} ${q} ${q} ${FILLER}` });
  // One query term only: FTS (AND) misses it, cosine ~0.71 (vector rank 2).
  CORPUS.push({ id: `half_${t}`, content: `${t}alpha` });
  QRELS.push({ id: t, query: q, relevant: [`rel_${t}`] });
}
// Uncontested queries: a single matching doc, top of both arms either way.
for (const t of ["saffron", "basalt", "cobalt", "pewter"]) {
  CORPUS.push({ id: `solo_${t}`, content: `${t}gamma ${t}delta` });
  QRELS.push({ id: t, query: `${t}gamma ${t}delta`, relevant: [`solo_${t}`] });
}
// Unanswerable queries: the relevant doc is not in the corpus, so every run
// scores 0 and the correct run's interval has real width.
for (const t of ["ember", "fjord"]) {
  QRELS.push({ id: t, query: `${t}omega`, relevant: [`missing_${t}`] });
}

const toDocId = (chunkId: string): string => chunkId.replace(/_c\d+$/, "");

let tmp: string;
let storage: Storage;
const arms = new Map<string, { vector: string[]; keyword: string[] }>();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-eval-mutation-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const d of CORPUS) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: `/${d.id}.md`,
        title: d.id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
      },
      [{ text: d.content, entities: [], embedding: deterministicEmbed(d.content) }],
    );
  }
  for (const q of QRELS) {
    arms.set(q.id, {
      vector: await vectorSearch(storage.engine(), deterministicEmbed(q.query), POOL),
      keyword: await keywordSearch(storage.engine(), q.query, POOL),
    });
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Per-query reciprocal rank of the fused list under the given weights. */
function scoreRun(weights: number[]): number[] {
  return QRELS.map((q) => {
    const { vector, keyword } = arms.get(q.id)!;
    const fused = reciprocalRankFusion([vector, keyword], { weights });
    return reciprocalRank(fused.map((r) => toDocId(r.id)), new Set(q.relevant));
  });
}

const CORRECT = rrfWeightsForLists("topic", 1);

describe("fusion mutation vs the bootstrap interval", () => {
  it("builds the contested shape the mutation relies on", () => {
    const { vector, keyword } = arms.get("falcon")!;
    expect(vector.slice(0, 3).map(toDocId)).toEqual(["rel_falcon", "half_falcon", "stuffed_falcon"]);
    expect(keyword.slice(0, 2).map(toDocId)).toEqual(["stuffed_falcon", "rel_falcon"]);
  });

  it("moves MRR beyond the correct run's interval when the vector arm is silenced", () => {
    const correct = scoreRun(CORRECT);
    const broken = scoreRun([1e-9, CORRECT[1]!]);

    const correctCi = bootstrapMeanCI(correct);
    const brokenMean = bootstrapMeanCI(broken).mean;
    expect(correctCi.lo).toBeLessThan(correctCi.hi);
    expect(brokenMean).toBeLessThan(correctCi.lo);

    const delta = pairedBootstrapDeltaCI(correct, broken);
    expect(delta.hi).toBeLessThan(0);
  });

  it("gives a delta interval of exactly [0, 0] for a no-op mutation", () => {
    const delta = pairedBootstrapDeltaCI(scoreRun(CORRECT), scoreRun([...CORRECT]));
    expect([delta.lo, delta.hi]).toEqual([0, 0]);
  });
});
