/**
 * Diary fence over the raw-chunk search surfaces (`search` + `query`).
 *
 * A non-operator caller (public bearer OR OAuth tenant, even one scoped into the
 * diary's own source) must never receive life/diary/* page chunks — the same
 * interiority the chronicle/ontology reads keep operator-only. The operator
 * (trusted-local, authInfo === undefined) still sees everything.
 *
 * `hybridSearch` is mocked to a canned diary + normal hit so the test needs no
 * Bedrock/pgvector — it isolates the fence wiring in callSearch/callQuery.
 * `dispatchTool` is imported AFTER `mock.module` so it binds the stub, and the
 * real module is restored in afterAll (mock.module is process-global).
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import * as _searchNs from "../src/core/search/index.ts";
const _realSearchExports = { ..._searchNs };

const NORMAL_PATH = "page://chron-a/projects/roadmap";
const DIARY_PATH = "page://chron-a/life/diary/2026-07-01";

let tmp: string;
let storage: Storage;
let dispatchTool: typeof import("../src/mcp/dispatch.ts")["dispatchTool"];

function cannedHits() {
  return [
    { chunkId: "c-normal", documentId: "d-normal", sourcePath: NORMAL_PATH, title: "Roadmap", kind: "markdown", rank: 1, content: "normal body", score: 0.9 },
    { chunkId: "c-diary", documentId: "d-diary", sourcePath: DIARY_PATH, title: "Diary", kind: "markdown", rank: 2, content: "diary interiority", score: 0.8 },
  ];
}

beforeAll(async () => {
  mock.module("../src/core/search/index.ts", () => ({
    hybridSearch: async () => cannedHits(),
    // queryRefine lives in a different module; callQuery's non-refine path uses
    // hybridSearch, which is what we exercise here.
  }));
  ({ dispatchTool } = await import("../src/mcp/dispatch.ts"));
  tmp = mkdtempSync(join(tmpdir(), "memex-chronicle-fence-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  mock.module("../src/core/search/index.ts", () => _realSearchExports);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const paths = (out: any): string[] => out.hits.map((h: any) => h.sourcePath);

describe("search diary fence", () => {
  it("operator search finds both the diary and normal page chunks", async () => {
    const out = payload(await dispatchTool(storage, { name: "search", arguments: { q: "roadmap" } }));
    expect(paths(out)).toContain(NORMAL_PATH);
    expect(paths(out)).toContain(DIARY_PATH);
  });

  it("an OAuth tenant search finds only the normal chunk (diary fenced)", async () => {
    const res = await dispatchTool(
      storage,
      { name: "search", arguments: { q: "roadmap" } },
      { authInfo: auth("chron-a") },
    );
    const out = payload(res);
    expect(paths(out)).toContain(NORMAL_PATH);
    expect(paths(out)).not.toContain(DIARY_PATH);
    expect(res.content[0]!.text).not.toContain("diary interiority");
  });
});

describe("query diary fence", () => {
  it("operator query returns both chunks", async () => {
    const out = payload(await dispatchTool(storage, { name: "query", arguments: { q: "roadmap" } }));
    expect(paths(out)).toContain(DIARY_PATH);
  });

  it("an OAuth tenant query drops the diary chunk", async () => {
    const out = payload(
      await dispatchTool(storage, { name: "query", arguments: { q: "roadmap" } }, { authInfo: auth("chron-a") }),
    );
    expect(paths(out)).toContain(NORMAL_PATH);
    expect(paths(out)).not.toContain(DIARY_PATH);
  });
});
