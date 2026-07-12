/**
 * Per-entity dimensional ontology (rides entity_facts, migration 097). Covers
 * the merge cases (insert / noop / corroborate / forward-supersede / backdated
 * history / novel-dimension quarantine), asof valid-time travel, tenant
 * isolation, and the conflict detector.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  mergeOntologyFact,
  getOntology,
  discoverOntologyDimensions,
  findOntologyConflicts,
} from "../src/core/ontology-facts.ts";
import { valueHash } from "../src/core/chronicle/ontology.ts";
import type { OntologyObservationInput } from "../src/core/chronicle/types.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-onto-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const ENTITY = "people/alice";
const SCOPE = { sourceIds: ["default"] };

/** entity_facts.source_id FKs to sources — provision a tenant before use. */
async function ensureSource(id: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2)
     ON CONFLICT DO NOTHING`,
    [id, `tenant:${id}`],
  );
}

function merge(obs: Partial<OntologyObservationInput> & { value: string; source_slug: string }) {
  return mergeOntologyFact(storage, {
    entitySlug: ENTITY,
    dimension: "role",
    sourceId: "default",
    ...obs,
  });
}

describe("mergeOntologyFact", () => {
  it("inserts a first observation", async () => {
    const r = await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    expect(r.action).toBe("inserted");
    expect(r.factId).not.toBeNull();
  });

  it("is a noop on an identical re-write from the same source", async () => {
    await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    const r = await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    expect(r.action).toBe("noop");
  });

  it("corroborates + bumps confidence from a different source", async () => {
    const first = await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    const r = await merge({ value: "advisor", source_slug: "meetings/b", validFrom: "2026-06-02" });
    expect(r.action).toBe("corroborated");
    const cur = await storage.engine().query<{ confidence: number }>(
      "SELECT confidence FROM entity_facts WHERE id = $1",
      [first.factId],
    );
    expect(Number(cur.rows[0]!.confidence)).toBeGreaterThan(0.7);
    // The corroboration row itself is retired + linked to the surviving claim.
    const corr = await storage.engine().query<{ forgotten_cause: string; consolidated_into: number }>(
      "SELECT forgotten_cause, consolidated_into FROM entity_facts WHERE id = $1",
      [r.factId],
    );
    expect(corr.rows[0]!.forgotten_cause).toBe("consolidate");
    expect(Number(corr.rows[0]!.consolidated_into)).toBe(Number(first.factId));
  });

  it("forward-supersedes on a newer different value", async () => {
    const first = await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    const r = await merge({ value: "investor", source_slug: "meetings/c", validFrom: "2026-06-15" });
    expect(r.action).toBe("superseded_prior");
    expect(Number(r.supersededId)).toBe(Number(first.factId));
    const vals = await getOntology(storage, ENTITY, SCOPE);
    expect(vals.map((v) => v.value)).toEqual(["investor"]);
  });

  it("records a backdated value as history without rewriting current", async () => {
    await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    await merge({ value: "investor", source_slug: "meetings/c", validFrom: "2026-06-15" });
    const r = await merge({ value: "founder", source_slug: "meetings/d", validFrom: "2026-05-01" });
    expect(r.action).toBe("inserted");
    expect(r.conflict).toBe(true);
    const vals = await getOntology(storage, ENTITY, SCOPE);
    expect(vals.map((v) => v.value)).toEqual(["investor"]);
  });

  it("quarantines a novel dimension and hides it unless includeQuarantined", async () => {
    const r = await mergeOntologyFact(storage, {
      entitySlug: ENTITY, dimension: "mood", value: "buoyant",
      source_slug: "meetings/a", sourceId: "default",
    });
    expect(r.action).toBe("inserted");
    const plain = await getOntology(storage, ENTITY, SCOPE);
    expect(plain.find((v) => v.dimension === "mood")).toBeUndefined();
    const withQ = await getOntology(storage, ENTITY, { ...SCOPE, includeQuarantined: true });
    expect(withQ.find((v) => v.dimension === "mood")?.status).toBe("quarantined");
  });

  it("reopens a value after supersession (A→B→A)", async () => {
    await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    await merge({ value: "investor", source_slug: "meetings/a", validFrom: "2026-06-15" });
    const back = await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-07-01" });
    // The re-open supersedes B forward; the closed historical A no longer blocks it.
    expect(back.action).toBe("superseded_prior");
    const cur = await getOntology(storage, ENTITY, SCOPE);
    expect(cur.map((v) => v.value)).toEqual(["advisor"]);
    // Three rows of history: A (closed), B (closed), A (open).
    const n = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM entity_facts WHERE entity_slug = $1 AND dimension = 'role'",
      [ENTITY],
    );
    expect(n.rows[0]!.n).toBe(3);
    const open = await storage.engine().query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM entity_facts WHERE entity_slug = $1 AND dimension = 'role' AND valid_until IS NULL AND forgotten_at IS NULL",
      [ENTITY],
    );
    expect(open.rows[0]!.n).toBe(1);
  });

  it("time-travels with asof", async () => {
    await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    await merge({ value: "investor", source_slug: "meetings/c", validFrom: "2026-06-15" });
    const past = await getOntology(storage, ENTITY, { ...SCOPE, asof: "2026-06-10" });
    expect(past.map((v) => v.value)).toEqual(["advisor"]);
    const now = await getOntology(storage, ENTITY, SCOPE);
    expect(now.map((v) => v.value)).toEqual(["investor"]);
  });

  it("isolates tenants — a scoped read never sees another source's rows", async () => {
    await ensureSource("tenant-b");
    await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    await mergeOntologyFact(storage, {
      entitySlug: ENTITY, dimension: "role", value: "investor",
      source_slug: "meetings/z", sourceId: "tenant-b", validFrom: "2026-06-01",
    });
    const a = await getOntology(storage, ENTITY, { sourceIds: ["default"] });
    expect(a.map((v) => v.value)).toEqual(["advisor"]);
    const b = await getOntology(storage, ENTITY, { sourceIds: ["tenant-b"] });
    expect(b.map((v) => v.value)).toEqual(["investor"]);
  });
});

describe("discoverOntologyDimensions", () => {
  it("counts entities + observations per dimension in scope", async () => {
    await merge({ value: "advisor", source_slug: "meetings/a", validFrom: "2026-06-01" });
    await mergeOntologyFact(storage, {
      entitySlug: "people/bob", dimension: "role", value: "founder",
      source_slug: "meetings/b", sourceId: "default", validFrom: "2026-06-01",
    });
    const dims = await discoverOntologyDimensions(storage, { sourceIds: ["default"] });
    const role = dims.find((d) => d.dimension === "role");
    expect(role?.entities).toBe(2);
    expect(role?.observations).toBe(2);
  });

  it("omits a private-only dimension under worldOnly", async () => {
    const seed = (dimension: string, value: string, visibility: string) =>
      storage.engine().query(
        `INSERT INTO entity_facts
           (entity_slug, fact, kind, visibility, dimension, value, value_hash, confidence, source_slug, valid_from, source_id)
         VALUES ($1, $2, 'fact', $3, $4, $5, $6, 0.8, 'meetings/x', '2026-06-01'::date, 'default')`,
        [ENTITY, `${dimension}: ${value}`, visibility, dimension, value, valueHash(value)],
      );
    await seed("role", "advisor", "world");
    await seed("salary", "confidential", "private");

    const all = await discoverOntologyDimensions(storage, { sourceIds: ["default"] });
    expect(all.map((d) => d.dimension).sort()).toEqual(["role", "salary"]);
    const world = await discoverOntologyDimensions(storage, { sourceIds: ["default"], worldOnly: true });
    expect(world.map((d) => d.dimension)).toEqual(["role"]);
  });
});

describe("findOntologyConflicts", () => {
  // Two currently-open values from two distinct sources. The merge path
  // supersedes forward (only one open row survives), so a genuine standing
  // conflict is seeded directly to exercise the HAVING clause.
  async function seedOpen(
    value: string,
    source: string,
    sourceId = "default",
    visibility = "private",
    dimension = "role",
  ) {
    await storage.engine().query(
      `INSERT INTO entity_facts
         (entity_slug, fact, kind, visibility, dimension, value, value_hash, confidence, source_slug, valid_from, source_id)
       VALUES ($1, $2, 'fact', $7, $8, $3, $4, 0.8, $5, '2026-06-01'::date, $6)`,
      [ENTITY, `${dimension}: ${value}`, value, valueHash(value), source, sourceId, visibility, dimension],
    );
  }

  it("hides a private value from a remote (worldOnly) conflict read", async () => {
    await seedOpen("advisor", "meetings/a", "default", "world");
    await seedOpen("investor", "meetings/b", "default", "private");
    // Operator sees the disagreement; a remote caller sees only the world value,
    // so it never reads the private one and no conflict is reported.
    expect((await findOntologyConflicts(storage, { sourceIds: ["default"] })).length).toBe(1);
    expect(
      (await findOntologyConflicts(storage, { sourceIds: ["default"], worldOnly: true })).length,
    ).toBe(0);
  });

  it("flags >=2 open values from >=2 sources", async () => {
    await seedOpen("advisor", "meetings/a");
    await seedOpen("investor", "meetings/b");
    const conflicts = await findOntologyConflicts(storage, { sourceIds: ["default"] });
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.dimension).toBe("role");
    expect(conflicts[0]!.values.length).toBe(2);
  });

  it("ignores disagreement from a single source", async () => {
    await seedOpen("advisor", "meetings/a");
    await seedOpen("investor", "meetings/a");
    const conflicts = await findOntologyConflicts(storage, { sourceIds: ["default"] });
    expect(conflicts.length).toBe(0);
  });

  it("does not surface another tenant's rows", async () => {
    await ensureSource("tenant-b");
    await seedOpen("advisor", "meetings/a");
    await seedOpen("investor", "meetings/b", "tenant-b");
    const conflicts = await findOntologyConflicts(storage, { sourceIds: ["default"] });
    expect(conflicts.length).toBe(0);
  });
});
