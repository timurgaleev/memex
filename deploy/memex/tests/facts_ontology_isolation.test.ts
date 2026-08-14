/**
 * Dimensional ontology rows (mig097: dimension/value/value_hash/dim_status) are
 * per-entity observations with their own read path (getOntology). They must NOT
 * flow through the free-text fact pipelines — embedding, consolidation, recall,
 * or the contradiction probe. This exercises each gateway with one plain fact
 * and one ontology row on the same entity/source and asserts the ontology row
 * stays out. Offline: embeddings are stubbed / set directly, no Bedrock.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  addFact,
  listFacts,
  countUnconsolidatedFacts,
} from "../src/core/facts.ts";
import { embedFactsPhase } from "../src/core/cycle/embed-facts.ts";
import { findTrajectory } from "../src/core/insights.ts";
import { probeContradictionsPhase } from "../src/core/synthesis/contradictions.ts";
import { registerSource } from "../src/core/sources.ts";
import { valueHash } from "../src/core/chronicle/ontology.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

const SOURCE = "tenantA";
const ENTITY = "people/alice";

let tmp: string;
let storage: Storage;

/** Insert a dimensional ontology row directly (mig097 shape): dimension set,
 *  kind='fact', value_hash set, embedding left NULL. Returns its id. */
async function seedOntologyRow(): Promise<number> {
  const value = "engineer";
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO entity_facts
       (entity_slug, fact, kind, dimension, value, value_hash, dim_status,
        confidence, source_id)
     VALUES ($1, $2, 'fact', 'role', $3, $4, 'active', 0.9, $5)
     RETURNING id`,
    [ENTITY, `role: ${value}`, value, valueHash(value), SOURCE],
  );
  return r.rows[0]!.id as number;
}

const fakeSonnet = (text: string): SonnetFn => async () => ({
  text,
  modelId: "eu.anthropic.claude-sonnet-4-6",
  usage: { inputTokens: 100, outputTokens: 40 },
});

const CONTRADICTS = JSON.stringify({
  contradicts: true,
  severity: "high",
  axis: "value",
  confidence: 0.8,
  resolution_command: "",
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ontology-iso-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), {
    id: SOURCE,
    kind: "vault",
    pathPrefix: "/tenant-a",
  });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("dimensional ontology rows are isolated from free-text fact flows", () => {
  it("embed-facts backlog embeds only the plain fact", async () => {
    const plain = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Alice prefers tea",
      source_id: SOURCE,
    });
    const ontologyId = await seedOntologyRow();

    const res = await embedFactsPhase(storage.engine(), {
      embed: async () => new Array(1024).fill(0.1),
    });
    // Only the plain fact is a backlog candidate; the ontology row is skipped.
    expect(res.scanned).toBe(1);
    expect(res.embedded).toBe(1);

    // The ontology row's embedding stays NULL; the plain fact's is now set.
    const nulls = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE embedding IS NULL`,
    );
    expect(nulls.rows.map((r) => r.id)).toEqual([ontologyId]);
    const embedded = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE embedding IS NOT NULL`,
    );
    expect(plain.id).not.toBeNull();
    expect(embedded.rows.map((r) => r.id)).toEqual([plain.id!]);
  });

  it("listFacts recall returns only the plain fact", async () => {
    const plain = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Alice prefers tea",
      source_id: SOURCE,
    });
    await seedOntologyRow();

    const rows = await listFacts(storage, ENTITY, { sourceIds: [SOURCE] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(plain.id!);
    expect(rows[0]!.fact).toBe("Alice prefers tea");
  });

  it("countUnconsolidatedFacts ignores the ontology row", async () => {
    await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Alice prefers tea",
      source_id: SOURCE,
    });
    await seedOntologyRow();

    expect(await countUnconsolidatedFacts(storage, [SOURCE])).toBe(1);
  });

  it("findTrajectory never surfaces the ontology row as a fact point", async () => {
    const plain = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Alice prefers tea",
      source_id: SOURCE,
    });
    await seedOntologyRow();

    const points = await findTrajectory(storage, ENTITY, { sourceIds: [SOURCE] });
    expect(points).toHaveLength(1);
    expect(points[0]!.source).toBe("fact");
    expect(points[0]!.id).toBe(plain.id!);
    expect(points[0]!.text).toBe("Alice prefers tea");
  });

  it("the contradiction probe never pairs the ontology row", async () => {
    // Two plain facts on the same entity form a same-entity fact pair; the
    // ontology row must not be pulled into any pair even though it shares the
    // entity_slug and source. Judge always says "contradicts" so any generated
    // pair would be stored.
    const p1 = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Alice lives in Gotham",
      source_id: SOURCE,
    });
    const p2 = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Alice lives in Metropolis",
      source_id: SOURCE,
    });
    const ontologyId = await seedOntologyRow();

    // No pairsFn → exercises the real defaultPairs SQL (stream 1 self-join).
    await probeContradictionsPhase(storage.engine(), {
      sonnetFn: fakeSonnet(CONTRADICTS),
    });

    const stored = await storage.engine().query<{ a_ref: string; b_ref: string }>(
      `SELECT a_ref, b_ref FROM synth_contradictions`,
    );
    const refs = stored.rows.flatMap((r) => [r.a_ref, r.b_ref]);
    // The ontology row is never referenced; only the plain/plain pair is stored.
    expect(refs).not.toContain(String(ontologyId));
    expect(refs.sort()).toEqual([String(p1.id), String(p2.id)].sort());
  });
});
