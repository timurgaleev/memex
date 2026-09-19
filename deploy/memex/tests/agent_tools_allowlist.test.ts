/**
 * The agent's tool allowlist is read-only and closed: every entry is a
 * read-scoped operation outside the write and operator-only sets, no write the
 * public ingress forbids is reachable, anything else is refused before it is
 * dispatched, and what goes back to the model is capped text without `_meta`.
 */
import { describe, expect, it } from "bun:test";
import { OPERATIONS, WRITE_SCOPED_TOOLS, operationInputSchema } from "../src/mcp/operations.ts";
import { OPERATOR_ONLY_TOOLS, type ToolCallRequest, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { PUBLIC_GUARD_INTERNALS } from "../src/http/public_guard.ts";
import {
  AGENT_READ_TOOLS,
  MAX_AGENT_TOOL_OUTPUT_CHARS,
  agentToolSpecs,
  dispatchAgentTool,
  isAgentTool,
} from "../src/core/agent/tools.ts";
import type { Storage } from "../src/core/storage.ts";

const storage = {} as Storage;

function countingDispatch(result: ToolCallResult): {
  calls: ToolCallRequest[];
  fn: (s: Storage, req: ToolCallRequest) => Promise<ToolCallResult>;
} {
  const calls: ToolCallRequest[] = [];
  return {
    calls,
    fn: async (_s, req) => {
      calls.push(req);
      return result;
    },
  };
}

describe("AGENT_READ_TOOLS", () => {
  it("names only existing read-scoped operations", () => {
    for (const name of AGENT_READ_TOOLS) {
      const op = OPERATIONS.find((o) => o.name === name);
      expect(op, name).toBeDefined();
      expect(op!.scope ?? "read").toBe("read");
    }
  });

  it("is disjoint from the write-scoped and operator-only sets", () => {
    for (const name of AGENT_READ_TOOLS) {
      expect(WRITE_SCOPED_TOOLS.has(name), name).toBe(false);
      expect(OPERATOR_ONLY_TOOLS.has(name), name).toBe(false);
    }
  });

  it("reaches no tool the public ingress forbids except the pinned content reads", () => {
    // These four are forbidden publicly because they return note content or
    // slugs; the operator's agent reads the whole brain anyway. Anything else
    // from the forbidden set — every destructive write among it — stays out.
    const PINNED_CONTENT_READS = ["get_chunks", "get_links", "get_tags", "resolve_slugs"];
    const forbidden = PUBLIC_GUARD_INTERNALS.FORBIDDEN_MCP_TOOLS_FROM_PUBLIC;
    const overlap = AGENT_READ_TOOLS.filter((n) => forbidden.has(n)).sort();
    expect(overlap).toEqual(PINNED_CONTENT_READS);
    for (const name of forbidden) {
      const op = OPERATIONS.find((o) => o.name === name);
      if (op && (op.scope ?? "read") !== "read") expect(isAgentTool(name), name).toBe(false);
    }
    for (const name of PUBLIC_GUARD_INTERNALS.PUBLIC_WRITE_TOOLS) {
      expect(isAgentTool(name), name).toBe(false);
    }
  });
});

describe("agentToolSpecs", () => {
  it("produces exactly the allowlist, with the operation's own input schema", () => {
    const specs = agentToolSpecs();
    expect(specs.map((s) => s.name)).toEqual([...AGENT_READ_TOOLS]);
    for (const spec of specs) {
      const op = OPERATIONS.find((o) => o.name === spec.name)!;
      expect(spec.inputSchema).toEqual(operationInputSchema(op));
      expect(spec.description).toBe(op.description);
    }
  });
});

describe("dispatchAgentTool", () => {
  it("refuses a write or unknown tool without dispatching it", async () => {
    const d = countingDispatch({ content: [{ type: "text", text: "x" }] });
    for (const name of ["page_put", "page_delete", "jobs_submit", "no_such_tool"]) {
      const r = await dispatchAgentTool(storage, name, { slug: "a" }, d.fn);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("not available");
    }
    expect(d.calls).toHaveLength(0);
  });

  it("refuses non-object arguments without dispatching", async () => {
    const d = countingDispatch({ content: [{ type: "text", text: "x" }] });
    const r = await dispatchAgentTool(storage, "search", ["q"], d.fn);
    expect(r.isError).toBe(true);
    expect(d.calls).toHaveLength(0);
  });

  it("dispatches an allowlisted read and drops _meta", async () => {
    const d = countingDispatch({
      content: [{ type: "text", text: "hit one" }, { type: "text", text: "hit two" }],
      _meta: { brain_hot_memory: { secret: "operator-only" } },
    });
    const r = await dispatchAgentTool(storage, "search", { q: "memex" }, d.fn);
    expect(d.calls).toEqual([{ name: "search", arguments: { q: "memex" } }]);
    expect(r).toEqual({ text: "hit one\nhit two", isError: false });
    expect(r.text).not.toContain("operator-only");
  });

  it("caps the output handed back to the model", async () => {
    const big = "a".repeat(MAX_AGENT_TOOL_OUTPUT_CHARS * 3);
    const d = countingDispatch({ content: [{ type: "text", text: big }] });
    const r = await dispatchAgentTool(storage, "page_get", { slug: "big" }, d.fn);
    expect(r.text.length).toBeLessThan(MAX_AGENT_TOOL_OUTPUT_CHARS + 100);
    expect(r.text).toContain("[truncated:");
  });

  it("reports a tool error and a throwing tool as error results", async () => {
    const err = countingDispatch({ content: [{ type: "text", text: "bad slug" }], isError: true });
    expect(await dispatchAgentTool(storage, "page_get", { slug: "x" }, err.fn)).toEqual({
      text: "bad slug",
      isError: true,
    });
    const r = await dispatchAgentTool(storage, "page_get", { slug: "x" }, async () => {
      throw new Error("boom");
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("boom");
  });
});
