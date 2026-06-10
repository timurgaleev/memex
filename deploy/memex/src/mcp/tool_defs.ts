/**
 * MCP tool definitions exposed to agent clients.
 *
 * The list is DERIVED from the single-source-of-truth `OPERATIONS` contract in
 * `operations.ts` — each `inputSchema` is generated from the operation's
 * `ParamDef`s, so the JSON-Schema shape MCP clients (Claude Code, Cursor,
 * Codex, …) receive from tools/list can never drift from the param
 * declarations. `inputSchema` follows JSON-Schema draft 7.
 */
import { OPERATIONS, operationInputSchema } from "./operations.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFS: readonly ToolDef[] = OPERATIONS.map((op) => ({
  name: op.name,
  description: op.description,
  inputSchema: operationInputSchema(op),
}));
