/**
 * MCP tool definitions exposed to agent clients.
 *
 * Each tool maps to a thin wrapper over the existing core functions.
 * `inputSchema` follows JSON-Schema draft 7 — the same shape MCP clients
 * (Claude Desktop, openclaw, etc.) expect from tools/list responses.
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "search",
    description:
      "Hybrid (vector + keyword) search over the indexed corpus. Returns ranked chunks with their parent document path and title.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Natural-language query." },
        k: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Number of hits to return. Default 5.",
        },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "index",
    description:
      "Index a markdown document. Either pass `path` (an absolute path the daemon can read) or `sourcePath` + `text` (in-memory).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a .md file." },
        sourcePath: { type: "string" },
        text: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "backlinks",
    description:
      "Find documents whose chunks reference the named entity. Default type is `wikilink` ([[Name]] references in markdown).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["wikilink", "tag", "date"],
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "stats",
    description:
      "Counts of indexed documents / chunks / embeddings. Cheap; no Bedrock calls.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "log_friction",
    description:
      "Record a friction event — used by the agent to flag when retrieval missed, an answer felt wrong, a tool errored out, OR when a recall produced an unexpectedly good hit (`delight`). When invoked from a skill, include extra.skill = '<skill-slug>' so `memex friction propose-fix` can group the event with the skill that fired it. Set `severity` to confused/error/blocker/nit on negative kinds for triage.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "search-miss",
            "wrong-answer",
            "tool-error",
            "low-confidence",
            "other",
            "delight",
            "phase-marker",
            "interrupted",
          ],
        },
        query: { type: "string" },
        reason: { type: "string" },
        sourcePath: { type: "string" },
        severity: {
          type: "string",
          enum: ["confused", "error", "blocker", "nit"],
        },
        extra: { type: "object" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
];
