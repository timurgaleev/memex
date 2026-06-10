/**
 * The generated TOOL_DEFS must EXACTLY match the original hand-written defs.
 *
 * `tests/fixtures/tool_defs.snapshot.json` is a frozen copy of the inline
 * schemas as they shipped before the OPERATIONS-contract refactor. Asserting
 * deep equality proves the refactor is a zero-behavior change — the JSON-Schema
 * MCP clients receive is byte-for-byte the same structure.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";

const snapshot = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/tool_defs.snapshot.json"), "utf8"),
) as { name: string; description: string; inputSchema: unknown }[];

describe("TOOL_DEFS generated from OPERATIONS", () => {
  it("exactly matches the original hand-written defs", () => {
    expect(TOOL_DEFS).toEqual(snapshot);
  });

  it("covers the same tools in the same order", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(snapshot.map((t) => t.name));
    expect(OPERATIONS.map((o) => o.name)).toEqual(snapshot.map((t) => t.name));
  });

  it("every generated inputSchema is a closed object schema", () => {
    for (const t of TOOL_DEFS) {
      const s = t.inputSchema as Record<string, unknown>;
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
      expect(typeof s.properties).toBe("object");
    }
  });
});
