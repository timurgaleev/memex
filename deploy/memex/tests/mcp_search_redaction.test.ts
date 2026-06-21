/**
 * MCP `search` redaction wiring test (closes the P3 gap left by
 * `mcp_redaction.test.ts`, which covered the page tools but not search).
 *
 * The vault-exfil fix routes public-ingress `search` through `redactBodies`
 * in `callSearch` (dispatch.ts) — a DIFFERENT allowlist (`PUBLIC_SAFE_FIELDS`)
 * than the page tools. The shared `redactBodies` function is unit-tested in
 * `internal_auth_and_redaction.test.ts`; the gap was the MCP-specific wiring:
 * does `dispatchTool(... ,{isPublic:true})` actually apply it to search hits?
 *
 * `hybridSearch` is mocked to a canned hit so the test needs no Bedrock
 * (query embedding / intent / expansion) and no pgvector — it isolates the
 * redaction wiring, which is the only thing under test here. `dispatchTool`
 * is dynamically imported AFTER `mock.module` so it binds the stubbed search.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { ToolCallResult } from "../src/mcp/dispatch.ts";
// Capture the real search exports by VALUE at file-load time — BEFORE
// beforeAll's `mock.module` swaps them. A live `import * as` namespace would
// point at the mock after the swap; spreading into a plain object here copies
// the real function references while they are still real. `mock.module` is
// process-global and bun does NOT auto-restore it between files, so without
// the afterAll restore the stubbed `hybridSearch` (canned "chunk-1" hit)
// leaks into every later file that calls the real hybridSearch (e.g.
// tests/hybrid_cache.test.ts).
import * as _searchNs from "../src/core/search/index.ts";
const _realSearchExports = { ..._searchNs };

const SECRET = "Confidential chunk body — Q3 revenue 4.2M, churn 12%.";

let tmp: string;
let storage: Storage;
let dispatchTool: typeof import("../src/mcp/dispatch.ts")["dispatchTool"];

beforeAll(async () => {
  // Stub the only search export dispatch imports. The canned hit carries:
  //  - every allowlisted field (title/sourcePath/score/documentId/chunkId/
  //    kind/rank) so the public `toEqual` is a COMPLETE allowlist contract;
  //  - a body field (`content`) and two non-allowlisted fields (`intent`,
  //    `snippet`) so we prove the fail-safe strips bodies AND novel keys.
  mock.module("../src/core/search/index.ts", () => ({
    hybridSearch: async () => [
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        sourcePath: "/vault/secret.md",
        title: "Secret",
        kind: "markdown",
        rank: 1,
        content: SECRET,
        snippet: SECRET,
        score: 0.99,
        intent: "topic",
      },
      // A page-derived mirror hit: its slug (`page://people/jane`) is
      // author-written PII and must be dropped from PUBLIC search entirely,
      // while internal callers still receive it.
      {
        chunkId: "page-chunk-1",
        documentId: "doc-page-1",
        sourcePath: "page://people/jane",
        title: "Jane Doe",
        kind: "markdown",
        rank: 2,
        content: SECRET,
        score: 0.88,
        intent: "topic",
      },
    ],
  }));
  ({ dispatchTool } = await import("../src/mcp/dispatch.ts"));

  tmp = mkdtempSync(join(tmpdir(), "memex-mcp-search-redact-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  // Restore the real search module so the stub cannot leak into later test
  // files (see the load-time capture comment on the import above).
  mock.module("../src/core/search/index.ts", () => _realSearchExports);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

/** Leak-shaped guard: the secret must not appear anywhere in the payload. */
function expectNoLeak(result: ToolCallResult): void {
  expect(result.content[0]!.text).not.toContain(SECRET);
}

describe("dispatchTool search redaction", () => {
  it("public ingress strips content (and non-allowlisted fields) from hits", async () => {
    const res = await dispatchTool(
      storage,
      { name: "search", arguments: { q: "revenue" } },
      { isPublic: true },
    );
    const out = payload(res);
    // The page-mirror hit is filtered out → only the vault hit remains.
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]).not.toHaveProperty("content");
    expect(out.hits[0]).not.toHaveProperty("snippet");
    expect(out.hits[0]).not.toHaveProperty("intent");
    expectNoLeak(res);
  });

  it("public ingress drops page-mirror hits entirely (slug is PII)", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(
      out.hits.some(
        (h: { sourcePath?: string }) =>
          typeof h.sourcePath === "string" && h.sourcePath.startsWith("page://"),
      ),
    ).toBe(false);
  });

  it("internal ingress retains page-mirror hits", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: false },
      ),
    );
    expect(out.hits.length).toBe(2);
    expect(
      out.hits.some(
        (h: { sourcePath?: string }) => h.sourcePath === "page://people/jane",
      ),
    ).toBe(true);
  });

  it("public ingress preserves allowlisted hit metadata", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(out.hits[0]).toEqual({
      chunkId: "chunk-1",
      documentId: "doc-1",
      sourcePath: "/vault/secret.md",
      title: "Secret",
      kind: "markdown",
      rank: 1,
      score: 0.99,
    });
  });

  it("internal ingress returns the full hit including content", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: false },
      ),
    );
    expect(out.hits[0].content).toBe(SECRET);
    expect(out.hits[0].intent).toBe("topic");
  });

  it("default (no opts) is internal — content retained", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "search",
        arguments: { q: "revenue" },
      }),
    );
    expect(out.hits[0].content).toBe(SECRET);
  });
});

describe("dispatchTool search MEMEX_PUBLIC_READ_BODIES opt-in", () => {
  // Mutates a process-global env var; relies on Bun running tests within a
  // file serially (the default) so the toggle does not bleed elsewhere.
  const ORIGINAL = process.env["MEMEX_PUBLIC_READ_BODIES"];
  beforeAll(() => {
    process.env["MEMEX_PUBLIC_READ_BODIES"] = "1";
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env["MEMEX_PUBLIC_READ_BODIES"];
    else process.env["MEMEX_PUBLIC_READ_BODIES"] = ORIGINAL;
  });

  it("public ingress returns content when opted in", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(out.hits[0].content).toBe(SECRET);
  });
});
