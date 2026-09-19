/**
 * The brain tools the agent loop may call, and the one path it calls them by.
 *
 * The allowlist is picked by hand, not derived: every entry is a read-scoped
 * operation, so a call replayed after a crash cannot change anything. Specs
 * are generated from the same `operations.ts` ParamDefs the MCP surface
 * advertises, so the model sees exactly the contract `validateParams` enforces.
 *
 * Calls run through `dispatchTool` as the operator (no AuthInfo): the loop is
 * operator-only and reads the whole brain, and every per-tool gate and param
 * check still applies. Only the result's text content goes back to the model;
 * `_meta` (the operator's hot-memory payload) is dropped so it never enters a
 * model context.
 */
import { OPERATIONS, operationInputSchema, type Operation } from "../../mcp/operations.ts";
import {
  dispatchTool,
  type ToolCallRequest,
  type ToolCallResult,
} from "../../mcp/dispatch.ts";
import type { Storage } from "../storage.ts";
import type { ConverseToolSpec } from "../llm/converse.ts";

export const AGENT_READ_TOOLS: readonly string[] = [
  "search",
  "page_get",
  "page_list",
  "get_links",
  "backlinks",
  "get_tags",
  "get_chunks",
  "entity_recall",
  "entity_facts",
  "resolve_slugs",
];

const ALLOWED: ReadonlySet<string> = new Set(AGENT_READ_TOOLS);

/** Largest tool output handed back to the model, in characters. */
export const MAX_AGENT_TOOL_OUTPUT_CHARS = 16_384;

function allowedOps(): Operation[] {
  return AGENT_READ_TOOLS.map((name) => {
    const op = OPERATIONS.find((o) => o.name === name);
    if (!op) throw new Error(`agent allowlist names an unknown operation '${name}'`);
    if ((op.scope ?? "read") !== "read") {
      throw new Error(`agent allowlist names '${name}', which is not read-scoped`);
    }
    return op;
  });
}

/** Bedrock tool specs for the allowlist, in allowlist order. */
export function agentToolSpecs(): ConverseToolSpec[] {
  return allowedOps().map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: operationInputSchema(op),
  }));
}

export function isAgentTool(name: string): boolean {
  return ALLOWED.has(name);
}

/** Dispatch seam: production is `dispatchTool` as the operator. */
export type AgentDispatch = (
  storage: Storage,
  req: ToolCallRequest,
) => Promise<ToolCallResult>;

const operatorDispatch: AgentDispatch = (storage, req) => dispatchTool(storage, req, {});

export interface AgentToolOutput {
  text: string;
  isError: boolean;
}

function capText(text: string): string {
  if (text.length <= MAX_AGENT_TOOL_OUTPUT_CHARS) return text;
  const dropped = text.length - MAX_AGENT_TOOL_OUTPUT_CHARS;
  return `${text.slice(0, MAX_AGENT_TOOL_OUTPUT_CHARS)}\n[truncated: ${dropped} more characters]`;
}

/**
 * Run one allowlisted tool. A name outside the allowlist is refused before
 * anything is dispatched. A tool that throws is reported to the model as an
 * error result rather than failing the job: the model can recover from a bad
 * argument, and the ledger records the failure either way.
 */
export async function dispatchAgentTool(
  storage: Storage,
  name: string,
  input: unknown,
  dispatch: AgentDispatch = operatorDispatch,
): Promise<AgentToolOutput> {
  if (!isAgentTool(name)) {
    return { text: `tool '${name}' is not available to the agent`, isError: true };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { text: `tool '${name}' needs an object of arguments`, isError: true };
  }
  let result: ToolCallResult;
  try {
    result = await dispatch(storage, { name, arguments: input as Record<string, unknown> });
  } catch (err) {
    return { text: `tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  const text = result.content.map((block) => block.text).join("\n");
  return { text: capText(text), isError: result.isError === true };
}
