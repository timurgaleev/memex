/**
 * code_def / code_refs reads + recursive code_blast (callers) / code_flow
 * (callees) walks over code_edges_symbol. Seeds two TS files where beta()
 * calls alpha(), exercises the reads + walker directly against the engine.
 * Offline (PGLite, no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeFile } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { codeDefs, codeRefs } from "../src/core/code-graph.ts";
import { classifySink, runRecursiveWalk } from "../src/core/code-walk.ts";

// Cold WASM parser load + two index passes can edge past the 5s default.
setDefaultTimeout(25000);

const dbDir = mkdtempSync(join(tmpdir(), "tb-code-walk-db-"));
const repoDir = mkdtempSync(join(tmpdir(), "tb-code-walk-repo-"));
let storage: Storage;
const alphaPath = join(repoDir, "alpha.ts");
const betaPath = join(repoDir, "beta.ts");

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
  await storage.init();
  writeFileSync(alphaPath, `export function alpha() { return 1; }\n`);
  writeFileSync(
    betaPath,
    `import { alpha } from "./alpha";\nexport function beta() { return alpha(); }\n`,
  );
  await indexCodeFile(storage, alphaPath);
  await indexCodeFile(storage, betaPath);
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  _resetParsersForTests();
});

describe("classifySink", () => {
  it("classifies db / http / file_io / process_exec sinks", () => {
    expect(classifySink("db.query")).toBe("db_call");
    expect(classifySink("Repo::save")).toBe("db_call");
    expect(classifySink("fetch")).toBe("http_call");
    expect(classifySink("readFileSync")).toBe("file_io");
    expect(classifySink("spawn")).toBe("process_exec");
  });
  it("returns unknown for a plain symbol", () => {
    expect(classifySink("alpha")).toBe("unknown");
  });
});

describe("codeDefs", () => {
  it("locates the definition site of alpha", async () => {
    const r = await codeDefs(storage.engine(), "alpha");
    expect(r.query.type).toBe("code-def");
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.mentions.some((m) => m.source_path === alphaPath)).toBe(true);
  });
  it("returns empty for an unknown symbol", async () => {
    const r = await codeDefs(storage.engine(), "no_such_symbol_xyz");
    expect(r.count).toBe(0);
  });
});

describe("codeRefs", () => {
  it("returns the code-ref query shape without throwing", async () => {
    const r = await codeRefs(storage.engine(), "alpha");
    expect(r.query.type).toBe("code-ref");
    expect(r.count).toBeGreaterThanOrEqual(0);
  });
});

describe("runRecursiveWalk — callers (code_blast)", () => {
  it("finds beta as a transitive caller of alpha", async () => {
    const r = await runRecursiveWalk(storage.engine(), "alpha", {
      direction: "callers",
    });
    expect(r.result).toBe("ok");
    if (r.result !== "ok") return;
    const allSymbols = r.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
    expect(allSymbols).toContain("beta");
    expect(r.depth_groups[0]?.confidence).toBeCloseTo(1 / 1.3, 5);
  });
  it("returns not_found for an unknown symbol", async () => {
    const r = await runRecursiveWalk(storage.engine(), "no_such_symbol_xyz", {
      direction: "callers",
    });
    expect(r.result).toBe("not_found");
  });
});

describe("runRecursiveWalk — callees (code_flow)", () => {
  it("finds alpha as a callee of beta", async () => {
    const r = await runRecursiveWalk(storage.engine(), "beta", {
      direction: "callees",
    });
    expect(r.result).toBe("ok");
    if (r.result !== "ok") return;
    const allSymbols = r.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
    expect(allSymbols).toContain("alpha");
  });
});

describe("runRecursiveWalk — bounds + cycle detection", () => {
  it("detects a cycle and respects the depth cap", async () => {
    const engine = storage.engine();
    // Seed a synthetic 2-node cycle a→b→a directly on the edge table.
    const c = await engine.query<{ id: string }>(
      `SELECT id FROM chunks WHERE symbol_name IS NOT NULL LIMIT 1`,
    );
    const chunkId = c.rows[0]?.id;
    expect(chunkId).toBeTruthy();
    await engine.query(
      `INSERT INTO code_edges_symbol
         (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type)
       VALUES ($1,'cyc_a','cyc_b','call'), ($1,'cyc_b','cyc_a','call')
       ON CONFLICT DO NOTHING`,
      [chunkId],
    );
    const r = await runRecursiveWalk(engine, "cyc_a", {
      direction: "callees",
      exact: true,
      depth: 5,
    });
    expect(r.result).toBe("ok");
    if (r.result !== "ok") return;
    expect(r.cycles_detected).toBe(true);
  });
});
