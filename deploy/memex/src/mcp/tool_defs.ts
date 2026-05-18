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
  // -------------------------------------------------------------------
  // Page tools — DB-canonical page store added in migration 015.
  // Reads are open under the existing public-bearer; writes are listed
  // in mcp/http_transport.ts FORBIDDEN_MCP_TOOLS_FROM_PUBLIC so a
  // bearer-only public client cannot mutate the store. Internal
  // callers reach them through the internal-token gate on the HTTP
  // surface or via stdio MCP transport.
  // -------------------------------------------------------------------
  {
    name: "page_put",
    description:
      "Create or update a page in the DB-canonical store. Idempotent: re-putting identical content is a no-op. Each real change appends a row to page_versions. WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "kebab-case identifier with optional `/` namespaces (e.g. people/alice, journal/2026/05/2026-05-18).",
        },
        type: {
          type: "string",
          description:
            "One of: concept, person, company, meeting, idea, journal, note, email, event, decision, task, source. Pass allowAdHocType=true to accept other types.",
        },
        title: { type: "string" },
        compiled_truth: {
          type: "object",
          description:
            "Editable jsonb header (tags, related slugs, tier, enriched_at, …).",
        },
        markdown_body: { type: "string" },
        written_by: {
          type: "string",
          description:
            "Optional caller identifier for the audit trail (skill slug, recipe name, …).",
        },
        allowAdHocType: { type: "boolean" },
      },
      required: ["slug", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "page_append",
    description:
      "Append text to an existing page's markdown_body. Creates a new page_versions row. Requires the page to exist (use page_put for first write). WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        content: { type: "string" },
        written_by: { type: "string" },
      },
      required: ["slug", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "page_delete",
    description:
      "Soft-delete a page (sets deleted_at; the row + page_versions chain stays for audit). Idempotent. WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        written_by: { type: "string" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "page_get",
    description:
      "Read a page by slug. Returns an error if the page does not exist or is soft-deleted.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "page_list",
    description:
      "List pages, newest-first. Optional filters: `type` (string), `since` (ISO timestamp), `limit` (1..1000, default 50).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        since: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "page_versions",
    description:
      "Read the edit history of a page, newest-first. Includes body snapshots and compiled_truth snapshots at every revision.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
];
