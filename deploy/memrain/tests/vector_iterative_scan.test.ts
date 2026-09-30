/**
 * HNSW iterative scan for filtered vector searches: the settings builder, the
 * pgvector >= 0.8 gate, the PGLite skip path, and the
 * `vector_candidates_incomplete` signal when a filtered index scan comes back
 * short although more matching rows exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine, QueryResult } from "../src/core/engine/interface.ts";
import {
  HNSW_MAX_SCAN_TUPLES,
  pgvectorSupportsIterativeScan,
  vectorScanSettings,
  vectorSearch,
} from "../src/core/search/vector.ts";
import { deterministicEmbed } from "./det-embed.ts";

describe("vectorScanSettings", () => {
  const base = { kind: "postgres" as const, pgvector: "0.8.1", filtered: true, indexServed: true, limit: 20 };

  it("turns on a relaxed iterative scan for a filtered index scan on pgvector 0.8", () => {
    expect(vectorScanSettings(base)).toEqual({
      "hnsw.iterative_scan": "relaxed_order",
      "hnsw.max_scan_tuples": String(HNSW_MAX_SCAN_TUPLES),
    });
  });

  it("raises ef_search above the default alongside it", () => {
    expect(vectorScanSettings({ ...base, limit: 200 })).toEqual({
      "hnsw.ef_search": "200",
      "hnsw.iterative_scan": "relaxed_order",
      "hnsw.max_scan_tuples": String(HNSW_MAX_SCAN_TUPLES),
    });
  });

  it("leaves an unfiltered scan and older pgvector alone", () => {
    expect(vectorScanSettings({ ...base, filtered: false })).toEqual({});
    expect(vectorScanSettings({ ...base, pgvector: "0.7.4" })).toEqual({});
    expect(vectorScanSettings({ ...base, pgvector: null })).toEqual({});
    expect(vectorScanSettings({ ...base, pgvector: "0.7.4", limit: 100 })).toEqual({ "hnsw.ef_search": "100" });
  });

  it("sets nothing on PGLite or for an ordering the index cannot serve", () => {
    expect(vectorScanSettings({ ...base, kind: "pglite", limit: 200 })).toEqual({});
    expect(vectorScanSettings({ ...base, indexServed: false, limit: 200 })).toEqual({});
  });

  it("parses pgvector versions", () => {
    expect(pgvectorSupportsIterativeScan("0.8.0")).toBe(true);
    expect(pgvectorSupportsIterativeScan("0.10.2")).toBe(true);
    expect(pgvectorSupportsIterativeScan("1.0.0")).toBe(true);
    expect(pgvectorSupportsIterativeScan("0.7.4")).toBe(false);
    expect(pgvectorSupportsIterativeScan("")).toBe(false);
  });
});

/** A scripted engine: answers by SQL shape and records every statement. */
function stubEngine(
  kind: Engine["kind"],
  answer: (sql: string, params: unknown[]) => unknown[],
): Engine & { log: string[] } {
  const log: string[] = [];
  const engine: Engine & { log: string[] } = {
    kind,
    log,
    ready: async () => {},
    exec: async () => {},
    close: async () => {},
    query: async <T,>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      log.push(sql);
      return { rows: answer(sql, params) as T[] };
    },
    transaction: async <T,>(fn: (tx: Engine) => Promise<T>): Promise<T> => {
      log.push("BEGIN");
      const r = await fn(engine);
      log.push("COMMIT");
      return r;
    },
  };
  return engine;
}

const VEC: number[] = Array.from({ length: 8 }).fill(0.1) as number[];

describe("vectorSearch on Postgres", () => {
  it("runs a filtered plain-distance scan under the iterative settings, version read once", async () => {
    const engine = stubEngine("postgres", (sql) => {
      if (sql.includes("pg_extension")) return [{ extversion: "0.8.1" }];
      if (sql.includes("set_config")) return [];
      if (sql.includes("count(*)")) return [{ n: 2 }];
      return [{ chunk_id: "c1" }, { chunk_id: "c2" }];
    });
    await vectorSearch(engine, VEC, 10, { sourceIds: ["a"] });
    await vectorSearch(engine, VEC, 10, { sourceIds: ["a"] });
    expect(engine.log.filter((s) => s.includes("pg_extension"))).toHaveLength(1);
    expect(engine.log.filter((s) => s.includes("set_config"))).toHaveLength(2);
    expect(engine.log.some((s) => s.includes("AS MATERIALIZED"))).toBe(true);
  });

  it("reads the version again after a failed read instead of caching the failure", async () => {
    let reads = 0;
    const engine = stubEngine("postgres", (sql) => {
      if (sql.includes("pg_extension")) {
        reads++;
        if (reads === 1) throw new Error("connection reset");
        return [{ extversion: "0.8.1" }];
      }
      if (sql.includes("set_config")) return [];
      if (sql.includes("count(*)")) return [{ n: 2 }];
      return [{ chunk_id: "c1" }, { chunk_id: "c2" }];
    });
    await vectorSearch(engine, VEC, 10, { sourceIds: ["a"] });
    expect(engine.log.some((s) => s.includes("set_config"))).toBe(false);
    await vectorSearch(engine, VEC, 10, { sourceIds: ["a"] });
    await vectorSearch(engine, VEC, 10, { sourceIds: ["a"] });
    expect(reads).toBe(2);
    expect(engine.log.filter((s) => s.includes("set_config"))).toHaveLength(2);
  });

  it("does not wrap an unfiltered default-fanout scan", async () => {
    const engine = stubEngine("postgres", () => [{ chunk_id: "c1" }]);
    await vectorSearch(engine, VEC, 10);
    expect(engine.log.some((s) => s.includes("set_config") || s.includes("pg_extension"))).toBe(false);
  });
});

describe("candidates incomplete", () => {
  it("flags a short filtered scan when more matching rows exist", async () => {
    const engine = stubEngine("postgres", (sql) =>
      sql.includes("count(*)") ? [{ n: 5 }] : [{ chunk_id: "c1" }],
    );
    let flagged = 0;
    await vectorSearch(engine, VEC, 5, { sourceIds: ["a"], onCandidatesIncomplete: () => flagged++ });
    expect(flagged).toBe(1);
  });

  it("stays quiet when the filter simply matches fewer rows", async () => {
    const engine = stubEngine("postgres", (sql) =>
      sql.includes("count(*)") ? [{ n: 1 }] : [{ chunk_id: "c1" }],
    );
    let flagged = 0;
    await vectorSearch(engine, VEC, 5, { sourceIds: ["a"], onCandidatesIncomplete: () => flagged++ });
    expect(flagged).toBe(0);
  });

  it("never probes on PGLite, which runs without the raised ef_search", async () => {
    const engine = stubEngine("pglite", (sql) =>
      sql.includes("count(*)") ? [{ n: 5 }] : [{ chunk_id: "c1" }],
    );
    let flagged = 0;
    await vectorSearch(engine, VEC, 5, { sourceIds: ["a"], onCandidatesIncomplete: () => flagged++ });
    expect(flagged).toBe(0);
    expect(engine.log.some((s) => s.includes("count(*)"))).toBe(false);
  });

  it("never probes an unfiltered or exact (boosted) scan", async () => {
    const engine = stubEngine("pglite", () => [{ chunk_id: "c1" }]);
    let flagged = 0;
    await vectorSearch(engine, VEC, 5, { onCandidatesIncomplete: () => flagged++ });
    await vectorSearch(engine, VEC, 5, { sourceIds: ["a"], sourceBoost: true, onCandidatesIncomplete: () => flagged++ });
    expect(flagged).toBe(0);
    expect(engine.log.some((s) => s.includes("count(*)"))).toBe(false);
  });
});

describe("PGLite skip path", () => {
  let tmp: string;
  let storage: Storage;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-iterscan-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    await registerSource(storage.engine(), { id: "a", kind: "vault", pathPrefix: "/iter-a" });
    await registerSource(storage.engine(), { id: "b", kind: "vault", pathPrefix: "/iter-b" });
    for (const [id, src, text] of [
      ["doc_a1", "a", "alpha notes about retrieval"],
      ["doc_a2", "a", "alpha notes about ranking"],
      ["doc_b1", "b", "beta notes about retrieval"],
    ] as const) {
      await writeDocumentTransaction(
        storage,
        { documentId: id, sourcePath: `/notes/${id}.md`, title: id, frontmatter: {}, embeddingModel: "det", sourceId: src },
        [{ text, entities: [], embedding: deterministicEmbed(text) }],
      );
    }
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("filters by source with no hnsw settings and reports a complete arm", async () => {
    const real = storage.engine();
    const seen: string[] = [];
    const spy: Engine = {
      kind: real.kind,
      ready: () => real.ready(),
      exec: (s) => real.exec(s),
      close: () => real.close(),
      transaction: (fn) => real.transaction(fn),
      query: (sql, params) => {
        seen.push(sql);
        return real.query(sql, params);
      },
    };
    let flagged = 0;
    const ids = await vectorSearch(spy, deterministicEmbed("alpha retrieval"), 200, {
      sourceIds: ["a"],
      onCandidatesIncomplete: () => flagged++,
    });
    expect(ids.sort()).toEqual(["doc_a1_c0", "doc_a2_c0"]);
    expect(seen.some((s) => s.includes("set_config") || s.includes("pg_extension"))).toBe(false);
    expect(flagged).toBe(0);
  });

  it("the Postgres statements run on a real pgvector 0.8 (PGLite as the executor)", async () => {
    const real = storage.engine();
    const seen: string[] = [];
    const recording = (inner: Engine): Engine => ({
      kind: "postgres",
      ready: () => inner.ready(),
      exec: (s) => inner.exec(s),
      close: () => inner.close(),
      transaction: (fn) => inner.transaction((tx) => fn(recording(tx))),
      query: (sql, params) => {
        seen.push(sql);
        return inner.query(sql, params);
      },
    });
    const asPostgres = recording(real);
    const ids = await vectorSearch(asPostgres, deterministicEmbed("alpha retrieval"), 200, { sourceIds: ["a"] });
    expect(ids.sort()).toEqual(["doc_a1_c0", "doc_a2_c0"]);
    expect(seen.some((s) => s.includes("set_config"))).toBe(true);
    expect(seen.some((s) => s.includes("AS MATERIALIZED"))).toBe(true);
  });
});
