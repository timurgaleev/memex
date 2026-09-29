/**
 * The brain tools the agent loop may call, and the one path it calls them by.
 *
 * The allowlist is picked by hand, not derived: every entry is a read-scoped
 * operation, so a call replayed after a crash cannot change anything. Specs
 * are generated from the same `operations.ts` ParamDefs the MCP surface
 * advertises, so the model sees exactly the contract `validateParams` enforces.
 *
 * Calls run through `dispatchTool`. An operator job dispatches with no
 * AuthInfo and reads the whole brain; a tenant job dispatches as the tenant
 * (see authority.ts), so its source grant and every per-tool gate apply. A
 * tenant job's tools are the allowlist narrowed by the client's `bound_tools`.
 * Only the result's text content goes back to the model; `_meta` (the
 * operator's hot-memory payload) is dropped so it never enters a model context.
 */
import { OPERATIONS, operationInputSchema, type Operation } from "../../mcp/operations.ts";
import {
  dispatchTool,
  type ToolCallRequest,
  type ToolCallResult,
} from "../../mcp/dispatch.ts";
import type { Storage } from "../storage.ts";
import type { AuthInfo } from "../auth-info.ts";
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

function allowedOps(tools: readonly string[]): Operation[] {
  return tools.map((name) => {
    if (!ALLOWED.has(name)) throw new Error(`'${name}' is not an agent tool`);
    const op = OPERATIONS.find((o) => o.name === name);
    if (!op) throw new Error(`agent allowlist names an unknown operation '${name}'`);
    if ((op.scope ?? "read") !== "read") {
      throw new Error(`agent allowlist names '${name}', which is not read-scoped`);
    }
    return op;
  });
}

/** Bedrock tool specs for `tools` (default: the whole allowlist), in the order given. */
export function agentToolSpecs(tools: readonly string[] = AGENT_READ_TOOLS): ConverseToolSpec[] {
  return allowedOps(tools).map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: operationInputSchema(op),
  }));
}

export function isAgentTool(name: string): boolean {
  return ALLOWED.has(name);
}

/**
 * Dispatch seam: production is `dispatchTool`, as the tenant when the job
 * carries one and as the operator (no AuthInfo) otherwise.
 */
export type AgentDispatch = (
  storage: Storage,
  req: ToolCallRequest,
  authInfo?: AuthInfo,
) => Promise<ToolCallResult>;

const defaultDispatch: AgentDispatch = (storage, req, authInfo) =>
  dispatchTool(storage, req, authInfo ? { authInfo } : {});

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
 * Run one allowlisted tool. A name outside the allowlist, or outside the job's
 * own tool set when it has one, is refused before anything is dispatched. A tool that throws is reported to the model as an
 * error result rather than failing the job: the model can recover from a bad
 * argument, and the ledger records the failure either way.
 */
export async function dispatchAgentTool(
  storage: Storage,
  name: string,
  input: unknown,
  dispatch: AgentDispatch = defaultDispatch,
  opts: { tools?: readonly string[]; authInfo?: AuthInfo } = {},
): Promise<AgentToolOutput> {
  if (!isAgentTool(name) || (opts.tools !== undefined && !opts.tools.includes(name))) {
    return { text: `tool '${name}' is not available to the agent`, isError: true };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { text: `tool '${name}' needs an object of arguments`, isError: true };
  }
  let result: ToolCallResult;
  try {
    result = await dispatch(storage, { name, arguments: input as Record<string, unknown> }, opts.authInfo);
  } catch (err) {
    return { text: `tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
  const text = result.content.map((block) => block.text).join("\n");
  return { text: capText(text), isError: result.isError === true };
}
