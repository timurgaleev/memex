/**
 * Fact ids round-trip: `add_fact` hands the id out as a JSON number, and
 * `recall` / `forget_fact` take it back either as that number or as its
 * canonical decimal string. On Postgres the BIGSERIAL id used to come out as a
 * string, which the integer-typed `id` param then refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { toFactId } from "../src/core/facts.ts";
import { coerceFactIdArg, dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

const call = (name: string, args: Record<string, unknown>): Promise<ToolCallResult> =>
  dispatchTool(storage, { name, arguments: args }, {});

const envelope = (r: ToolCallResult): any => JSON.parse(r.content[0]!.text);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-fact-id-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("toFactId", () => {
  it("normalizes number, string and bigint to a number", () => {
    expect(toFactId(42)).toBe(42);
    expect(toFactId("42")).toBe(42);
    expect(toFactId(42n)).toBe(42);
  });

  it("throws on a value that is not a positive safe integer", () => {
    expect(() => toFactId(2n ** 60n)).toThrow();
    expect(() => toFactId("abc")).toThrow();
    expect(() => toFactId(0)).toThrow();
    expect(() => toFactId(null)).toThrow();
  });
});

describe("coerceFactIdArg", () => {
  it("converts only the canonical decimal string, on a copy", () => {
    const args = { id: "42", reason: "r" };
    const out = coerceFactIdArg("forget_fact", args);
    expect(out).toEqual({ id: 42, reason: "r" });
    expect(args.id).toBe("42");
  });

  it("leaves other tools and non-canonical strings untouched", () => {
    expect(coerceFactIdArg("page_get", { id: "42" })).toEqual({ id: "42" });
    // 17 digits is past the pattern's bound; 16 nines is past 2^53.
    for (const bad of ["42abc", "0", "-1", "042", " 42", "1".repeat(17), "9".repeat(16)]) {
      expect(coerceFactIdArg("recall", { id: bad }).id).toBe(bad);
    }
  });
});

describe("fact id round trip through dispatch", () => {
  let id = 0;

  it("add_fact returns a numeric id", async () => {
    const res = envelope(
      await call("add_fact", { entity_slug: "people/rt", fact: "round-trip probe" }),
    );
    expect(typeof res.id).toBe("number");
    id = res.id;
  });

  it("a restatement (inserted:false) also returns a number", async () => {
    const res = envelope(
      await call("add_fact", { entity_slug: "people/rt", fact: "round-trip probe" }),
    );
    expect(res.inserted).toBe(false);
    expect(res.id).toBe(id);
  });

  it("recall accepts the id as a string", async () => {
    const res = envelope(await call("recall", { id: String(id) }));
    expect(res.ok).toBe(true);
    expect(res.fact.id).toBe(id);
  });

  it("forget_fact accepts the id as a string, then recall reports not_found", async () => {
    const res = envelope(await call("forget_fact", { id: String(id), reason: "probe" }));
    expect(res.found).toBe(true);
    expect(res.forgotten).toBe(true);
    const again = await call("recall", { id: String(id) });
    expect(again.isError).toBe(true);
    expect(envelope(again).error).toBe("not_found");
  });

  it("refuses a malformed string id as invalid_params", async () => {
    for (const bad of ["12x", "0", "1".repeat(17)]) {
      const res = await call("forget_fact", { id: bad });
      expect(res.isError).toBe(true);
      expect(envelope(res).error).toBe("invalid_params");
    }
  });
});

// PGLite returns BIGSERIAL as a number, so the block above cannot see the
// Postgres failure. Here every entity_facts id column is turned into the
// decimal string postgres.js actually hands back, and each tool that emits a
// fact id must still answer with a JSON number.
describe("fact ids stay numeric when the engine returns int8 as strings", () => {
  const ID_COLUMNS = ["id", "superseded_by", "consolidated_into"] as const;
  let restore: () => void = () => {};
  let oldId = 0;
  let newId = 0;

  beforeAll(async () => {
    const engine = storage.engine();
    const original = engine.query.bind(engine);
    engine.query = (async (sql: string, params?: unknown[]) => {
      const r = await original(sql, params);
      if (!sql.includes("entity_facts")) return r;
      const rows = (r.rows as Record<string, unknown>[]).map((row) => {
        const out = { ...row };
        for (const col of ID_COLUMNS) {
          if (typeof out[col] === "number") out[col] = String(out[col]);
        }
        return out;
      });
      return { ...r, rows };
    }) as typeof engine.query;
    restore = () => {
      engine.query = original;
    };
  });

  afterAll(() => restore());

  it("add_fact returns a number for a fresh insert", async () => {
    const a = envelope(await call("add_fact", { entity_slug: "people/pg", fact: "old claim" }));
    const b = envelope(await call("add_fact", { entity_slug: "people/pg", fact: "new claim" }));
    expect(typeof a.id).toBe("number");
    expect(typeof b.id).toBe("number");
    oldId = a.id;
    newId = b.id;
  });

  it("entity_facts returns numeric ids and a null-or-number pointer", async () => {
    const res = envelope(await call("entity_facts", { entity_slug: "people/pg" }));
    expect(res.facts.length).toBe(2);
    for (const f of res.facts) {
      expect(typeof f.id).toBe("number");
      expect(f.superseded_by).toBeNull();
      expect(f.consolidated_into).toBeNull();
    }
  });

  it("recall returns the id as a number", async () => {
    const res = envelope(await call("recall", { id: oldId }));
    expect(res.fact.id).toBe(oldId);
  });

  it("fact_supersessions returns id and superseded_by as numbers", async () => {
    await storage.engine().query(
      `UPDATE entity_facts
          SET forgotten_at = now(), forgotten_cause = 'supersede', superseded_by = $2
        WHERE id = $1`,
      [oldId, newId],
    );
    const res = envelope(await call("fact_supersessions", { entity_slug: "people/pg" }));
    expect(res.supersessions.length).toBe(1);
    expect(res.supersessions[0].id).toBe(oldId);
    expect(res.supersessions[0].superseded_by).toBe(newId);
  });
});
