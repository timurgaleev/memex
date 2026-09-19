/**
 * Durable fact withdrawal (migration 112). A forgotten claim stays forgotten
 * when anything re-asserts it: add_fact from another page or writer, a raw
 * bulk insert as the extract and transcript paths do it, or a fence re-put.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { putPage } from "../src/core/pages.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";

let tmp: string;
let dbPath: string;
let storage: Storage;

beforeEach(async () => {
  delete process.env.MEMEX_FACTS_FENCE;
  delete process.env.MEMEX_FACTS_DEDUP;
  tmp = mkdtempSync(join(tmpdir(), "memex-withdrawal-"));
  dbPath = join(tmp, "db");
  storage = new Storage({ dbPath });
  await storage.init();
  for (const id of ["tenant-a", "tenant-b"]) {
    await storage.engine().query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT DO NOTHING`,
      [id, `${id}/`],
    );
  }
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const ENTITY = "people/alice";

interface Row {
  id: number;
  fact: string;
  source_id: string;
  forgotten_at: string | null;
  forgotten_cause: string | null;
  forgotten_reason: string | null;
}

async function rows(entity = ENTITY): Promise<Row[]> {
  const r = await storage.engine().query<Row>(
    `SELECT id, fact, source_id, forgotten_at::text AS forgotten_at,
            forgotten_cause, forgotten_reason
       FROM entity_facts WHERE entity_slug = $1 ORDER BY id`,
    [entity],
  );
  return r.rows;
}

async function liveRows(entity = ENTITY): Promise<Row[]> {
  return (await rows(entity)).filter((r) => r.forgotten_at === null);
}

async function withdrawalCount(): Promise<number> {
  const r = await storage
    .engine()
    .query<{ c: number }>("SELECT COUNT(*)::int AS c FROM fact_withdrawals");
  return r.rows[0]!.c;
}

async function seed(fact: string, extra: Partial<Parameters<typeof addFact>[1]> = {}): Promise<number> {
  const r = await addFact(storage, { entity_slug: ENTITY, fact, ...extra });
  return r.id as number;
}

const throwingEmbed = {
  embed: async (): Promise<number[]> => {
    throw new Error("embed must not be called for a withdrawn claim");
  },
};

describe("addFact after a forget", () => {
  it("refuses the same claim from another page and writer, without an embed call", async () => {
    const id = await seed("Works remotely", { source_slug: "notes/a", written_by: "agent-a" });
    const f = await forgetFact(storage, id);
    expect(f.forgotten).toBe(true);

    let embedCalls = 0;
    const r = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Works remotely",
      source_slug: "notes/b",
      written_by: "agent-b",
      dedup: {
        embed: async () => {
          embedCalls += 1;
          return throwingEmbed.embed();
        },
      },
    });
    expect(r).toEqual({ id: null, entity_slug: ENTITY, inserted: false, withdrawn: true });
    expect(embedCalls).toBe(0);
    expect(await liveRows()).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
  });

  it("treats whitespace and case variants as the same claim", async () => {
    const id = await seed("Works remotely from Lisbon");
    await forgetFact(storage, id);
    const r = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "  works\tREMOTELY   from\nlisbon ",
      written_by: "someone-else",
    });
    expect(r.withdrawn).toBe(true);
    expect(await liveRows()).toHaveLength(0);
  });

  it("leaves the claim alone on another entity or another visibility", async () => {
    const id = await seed("Works remotely");
    await forgetFact(storage, id);

    const other = await addFact(storage, { entity_slug: "people/bob", fact: "Works remotely" });
    expect(other.inserted).toBe(true);
    expect(other.withdrawn).toBeUndefined();

    const world = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Works remotely",
      visibility: "world",
    });
    expect(world.inserted).toBe(true);
    expect(await liveRows()).toHaveLength(1);
  });
});

describe("insert trigger", () => {
  it("lands a raw bulk insert of a withdrawn claim already forgotten", async () => {
    const id = await seed("Prefers tea");
    await forgetFact(storage, id);
    // The shape the extract and conversation-facts paths use: a plain INSERT
    // that never consults addFact.
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, source_slug, written_by, kind)
       VALUES ($1, $2, 0.8, 'transcripts/x', 'memex:facts-extract', 'preference'),
              ($1, $3, 0.8, 'transcripts/x', 'memex:facts-extract', 'preference')`,
      [ENTITY, "PREFERS  tea", "Prefers coffee"],
    );
    const all = await rows();
    const variant = all.find((r) => r.fact === "PREFERS  tea")!;
    expect(variant.forgotten_at).not.toBeNull();
    expect(variant.forgotten_cause).toBe("forget");
    expect(variant.forgotten_reason).toBe("withdrawn");
    const unrelated = all.find((r) => r.fact === "Prefers coffee")!;
    expect(unrelated.forgotten_at).toBeNull();
  });

  it("ignores dimensional ontology rows", async () => {
    const id = await seed("Acme");
    await forgetFact(storage, id);
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, dimension, value, value_hash, kind)
       VALUES ($1, 'Acme', 1, 'employer', 'Acme', 'h1', 'fact')`,
      [ENTITY],
    );
    const dim = await storage.engine().query<{ forgotten_at: string | null }>(
      "SELECT forgotten_at::text AS forgotten_at FROM entity_facts WHERE dimension = 'employer'",
    );
    expect(dim.rows[0]!.forgotten_at).toBeNull();
  });
});

describe("forgetFact withdrawal", () => {
  it("expires every live duplicate in the same source and reports the count", async () => {
    const id = await seed("Lives in Berlin", { written_by: "w1" });
    await seed("lives in  berlin", { written_by: "w2" });
    await seed("Lives in Berlin", { written_by: "w3", source_slug: "notes/c" });
    const foreign = await seed("Lives in Berlin", { written_by: "w1", source_id: "tenant-b" });

    const f = await forgetFact(storage, id, { reason: "wrong city" });
    expect(f).toEqual({ id, found: true, forgotten: true, withdrawn_duplicates: 2 });
    const live = await liveRows();
    expect(live.map((r) => r.id)).toEqual([foreign]);
    const swept = (await rows()).filter((r) => r.id !== id && r.id !== foreign);
    expect(swept.every((r) => r.forgotten_reason === `withdrawn with fact ${id}`)).toBe(true);
    expect(await withdrawalCount()).toBe(1);
  });

  it("records no withdrawal for a supersede, so the claim can re-enter", async () => {
    const id = await seed("Leads the platform team");
    const f = await forgetFact(storage, id, { cause: "supersede" });
    expect(f.withdrawn_duplicates).toBe(0);
    expect(await withdrawalCount()).toBe(0);
    const r = await addFact(storage, { entity_slug: ENTITY, fact: "Leads the platform team" });
    expect(r.inserted).toBe(true);
    expect(await liveRows()).toHaveLength(1);
  });

  it("a second forget is still a no-op", async () => {
    const id = await seed("x");
    await forgetFact(storage, id);
    const again = await forgetFact(storage, id);
    expect(again).toEqual({ id, found: true, forgotten: false, withdrawn_duplicates: 0 });
  });
});

describe("tenancy", () => {
  it("an empty grant touches nothing and records nothing", async () => {
    const id = await seed("Owns a boat");
    const f = await forgetFact(storage, id, {}, []);
    expect(f).toEqual({ id, found: false, forgotten: false, withdrawn_duplicates: 0 });
    expect(await withdrawalCount()).toBe(0);
    expect(await liveRows()).toHaveLength(1);
  });

  it("a scoped caller cannot withdraw another tenant's claim", async () => {
    const id = await seed("Owns a boat", { source_id: "tenant-a" });
    await seed("Owns a boat", { source_id: "tenant-b", written_by: "b" });
    const f = await forgetFact(storage, id, {}, ["tenant-b"]);
    expect(f.found).toBe(false);
    expect(await withdrawalCount()).toBe(0);
    expect(await liveRows()).toHaveLength(2);
  });

  it("a scoped forget withdraws only inside its own source", async () => {
    const id = await seed("Owns a boat", { source_id: "tenant-a" });
    await forgetFact(storage, id, {}, ["tenant-a"]);
    const again = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Owns a boat",
      source_id: "tenant-b",
    });
    expect(again.inserted).toBe(true);
    const blocked = await addFact(storage, {
      entity_slug: ENTITY,
      fact: "Owns a boat",
      source_id: "tenant-a",
      written_by: "another",
    });
    expect(blocked.withdrawn).toBe(true);
  });
});

describe("fence reconcile", () => {
  function fenceBody(claims: string[], firstRow = 1): string {
    const facts: ParsedFact[] = claims.map((claim, i) => ({
      rowNum: firstRow + i,
      claim,
      confidence: 1,
      active: true,
    }) as ParsedFact);
    return `# Alice\n\n## Facts\n${renderFactsFence(facts)}\n`;
  }

  async function putAndReconcile(body: string) {
    const r = await putPage(storage, { slug: ENTITY, type: "person", markdown_body: body });
    return reconcileFactsForPage(storage, ENTITY, r.content_hash);
  }

  it("skips a claim forgotten elsewhere and never piles up tombstones", async () => {
    const id = await seed("Speaks Portuguese", { source_slug: "notes/a" });
    await forgetFact(storage, id);

    const body = fenceBody(["Speaks Portuguese", "Plays chess"]);
    const first = await putAndReconcile(body);
    expect(first.added).toBe(1);
    const before = (await rows()).length;
    await putAndReconcile(`${body}\n`);
    await putAndReconcile(body);
    expect((await rows()).length).toBe(before);
    expect((await liveRows()).map((r) => r.fact)).toEqual(["Plays chess"]);
  });

  it("keeps a forgotten fence claim out when it moves to another row", async () => {
    await putAndReconcile(fenceBody(["Speaks Portuguese", "Plays chess"]));
    const target = (await liveRows()).find((r) => r.fact === "Speaks Portuguese")!;
    await forgetFact(storage, target.id);
    // Row 1 stays retired by its own tombstone; the claim resurfacing on row 3
    // is what the withdrawal has to catch.
    const r = await putAndReconcile(fenceBody(["Plays chess", "speaks portuguese"], 2));
    expect(r.added).toBe(1);
    expect((await liveRows()).map((x) => x.fact)).toEqual(["Plays chess"]);
  });
});

describe("migration 112 backfill", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../src/core/migrations/112_fact_withdrawals.sql"),
    "utf8",
  );

  it("withdraws legacy forgets and retires the copies that came back", async () => {
    // A pre-062 tombstone (NULL cause), a resurrected live copy, a supersede
    // tombstone that must not count, and an unrelated live claim.
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, written_by, kind, forgotten_at, forgotten_cause)
       VALUES ($1, 'Drives a red car', 1, 'w', 'belief', now(), NULL),
              ($1, 'Was CTO', 1, 'w', 'belief', now(), 'supersede')`,
      [ENTITY],
    );
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, confidence, written_by, kind)
       VALUES ($1, 'drives a  red car', 1, 'extractor', 'belief'),
              ($1, 'Was CTO', 1, 'extractor', 'belief'),
              ($1, 'Has two cats', 1, 'extractor', 'belief')`,
      [ENTITY],
    );
    await storage.engine().exec(sql);
    expect(await withdrawalCount()).toBe(1);
    const live = (await liveRows()).map((r) => r.fact).sort();
    expect(live).toEqual(["Has two cats", "Was CTO"]);
    const retired = (await rows()).find((r) => r.fact === "drives a  red car")!;
    expect(retired.forgotten_reason).toBe("withdrawn (backfill)");
    expect(retired.forgotten_cause).toBe("forget");

    const snapshot = JSON.stringify(await rows());
    await storage.engine().exec(sql);
    expect(await withdrawalCount()).toBe(1);
    expect(JSON.stringify(await rows())).toBe(snapshot);
  });

  it("a second init applies nothing and keeps the ledger", async () => {
    const id = await seed("Drinks oat milk");
    await forgetFact(storage, id);
    await storage.close();
    storage = new Storage({ dbPath });
    await storage.init();
    expect(await withdrawalCount()).toBe(1);
    const r = await addFact(storage, { entity_slug: ENTITY, fact: "drinks oat milk" });
    expect(r.withdrawn).toBe(true);
  });
});

describe("memex_fact_claim_key", () => {
  async function timeKey(text: string): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await storage.engine().query("SELECT memex_fact_claim_key($1) AS k", [text]);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }

  it("grows linearly on whitespace-heavy input", async () => {
    const unit = " a\t \n";
    await timeKey(unit.repeat(1000));
    const small = await timeKey(unit.repeat(20_000));
    const large = await timeKey(unit.repeat(200_000));
    // 10x the input; a quadratic scan would be ~100x.
    expect(large / Math.max(small, 0.5)).toBeLessThan(35);
  });
});
