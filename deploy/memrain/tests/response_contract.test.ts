/**
 * Response shapes are pinned, not implied.
 *
 * The input side has been generated-and-frozen for a while: TOOL_DEFS comes
 * from OPERATIONS and a snapshot test fails when a schema moves. The output
 * side had nothing — each handler built its object at the call site, so a
 * renamed key would have shipped silently and a client would have met it in
 * production.
 *
 * This drives each registered tool for real and checks the keys it promises.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { addLink } from "../src/core/links.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import {
  RESPONSE_SHAPES,
  MEMEX_RESPONSE_VERSION,
  missingResponseKeys,
} from "../src/mcp/response-contract.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-respcontract-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: "people/alice", type: "person", markdown_body: "hi" });
  await putPage(storage, { slug: "people/bob", type: "person", markdown_body: "yo" });
  await addLink(storage, {
    source_slug: "people/alice",
    target_slug: "people/bob",
    type: "knows",
  });
  await addFact(storage, { entity_slug: "people/alice", fact: "likes tea" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Arguments that drive each registered tool to a successful response. */
const DRIVERS: Record<string, Record<string, unknown>> = {
  search: { q: "alice" },
  query: { q: "alice" },
  stats: {},
  entity_recall: { slug: "people/alice" },
  entity_facts: { entity_slug: "people/alice" },
  add_fact: { entity_slug: "people/alice", fact: "drinks coffee" },
  page_get: { slug: "people/alice" },
  page_put: { slug: "notes/contract", markdown_body: "x" },
  page_list: {},
  get_links: { slug: "people/alice" },
  backlinks: { name: "people/bob" },
};

describe("response contract", () => {
  it("registers only tools that exist", () => {
    const names = new Set(OPERATIONS.map((o) => o.name));
    for (const tool of RESPONSE_SHAPES.keys()) {
      expect(names.has(tool)).toBe(true);
    }
  });

  it("exercises every registered tool — a registration with no driver is a lie", () => {
    // Iterating the drivers alone let `search` and `query` sit in the registry
    // unchecked, so the "every registered shape is verified" claim was already
    // false on the day it was written.
    expect(Object.keys(DRIVERS).sort()).toEqual([...RESPONSE_SHAPES.keys()].sort());
  });

  it("has a version to pin", () => {
    expect(Number.isInteger(MEMEX_RESPONSE_VERSION)).toBe(true);
    expect(MEMEX_RESPONSE_VERSION).toBeGreaterThan(0);
  });

  for (const [tool, args] of Object.entries(DRIVERS)) {
    it(`${tool} returns the keys it promises`, async () => {
      const r = await dispatchTool(storage, { name: tool, arguments: args });
      expect(r.isError ?? false).toBe(false);
      const payload = JSON.parse((r.content[0] as { text: string }).text);
      expect(missingResponseKeys(tool, payload)).toEqual([]);
    });
  }

  it("reports a missing key rather than passing silently", () => {
    // The guard has to fail when a shape drifts, or it is decoration.
    expect(missingResponseKeys("page_get", { ok: true })).toEqual(["page"]);
    expect(missingResponseKeys("not-registered", {})).toEqual([]);
  });
});
