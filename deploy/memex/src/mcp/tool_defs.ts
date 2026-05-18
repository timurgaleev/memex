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
  // -------------------------------------------------------------------
  // Graph tools — page-to-page typed relationships (migration 016).
  // Writes (link, unlink) are in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC.
  // Reads (graph_neighbors, graph_query) are open under public bearer.
  // -------------------------------------------------------------------
  {
    name: "link",
    description:
      "Assert a typed link from source_slug to target_slug. Idempotent on (source, target, type) — re-asserting updates confidence + chunk_id. Default confidence 1.0. WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        source_slug: {
          type: "string",
          description:
            "The source page slug. Must reference an existing page (FK constraint).",
        },
        target_slug: {
          type: "string",
          description:
            "The target slug (soft reference; the page may or may not yet exist). Loose names like `Alice Smith` are normalised to `alice-smith`.",
        },
        type: {
          type: "string",
          description:
            "One of: wikilink, mentions, works_at, attended, founded, advises, invested_in, knows, met, located_at, related_to, supersedes, contradicts. Pass allowAdHocType=true to accept other types.",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "0..1, default 1.0 for agent-asserted edges. Use <1.0 only for deterministic-extractor outputs whose surface form was ambiguous.",
        },
        source_chunk_id: { type: "string" },
        allowAdHocType: { type: "boolean" },
      },
      required: ["source_slug", "target_slug", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "unlink",
    description:
      "Remove a typed link. Idempotent — returns removed=0 if no row matched. WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        source_slug: { type: "string" },
        target_slug: { type: "string" },
        type: { type: "string" },
      },
      required: ["source_slug", "target_slug", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "graph_neighbors",
    description:
      "All links touching `slug` (outbound, inbound, or both), newest-first. Optional `type` filter. Returns the link rows with a per-row `direction` annotation.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        type: {
          type: "string",
          description: "Filter to a single link type.",
        },
        direction: {
          type: "string",
          enum: ["outbound", "inbound", "both"],
          description: "Default `both`.",
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "graph_query",
    description:
      "Typed-relationship query. Requires `type` plus at least one of `source_slug` or `target_slug`. Examples: { type:'works_at', source_slug:'people/alice' } → companies Alice works at; { type:'works_at', target_slug:'companies/acme' } → people who work at Acme.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        source_slug: { type: "string" },
        target_slug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  // -------------------------------------------------------------------
  // Entity facts + timeline (Phase A.3, migrations 017+018).
  // Writes (add_fact, add_timeline_event) are in
  // FORBIDDEN_MCP_TOOLS_FROM_PUBLIC. Reads (entity_facts,
  // entity_timeline, entity_recall) are open under public bearer.
  // -------------------------------------------------------------------
  {
    name: "add_fact",
    description:
      "Append a fact about an entity to the entity_facts ledger. Append-only — corrections are new facts, never edits. Idempotent on (entity_slug, fact, source_chunk_id) when source_chunk_id is provided. WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        entity_slug: {
          type: "string",
          description:
            "The entity the fact is about (e.g. `people/alice`). Soft reference — the entity's page need not exist yet.",
        },
        fact: { type: "string", description: "Short claim, one sentence." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        source_slug: {
          type: "string",
          description: "Page the fact was extracted from.",
        },
        source_chunk_id: { type: "string" },
        written_by: { type: "string" },
      },
      required: ["entity_slug", "fact"],
      additionalProperties: false,
    },
  },
  {
    name: "add_timeline_event",
    description:
      "Append a timeline event to an existing page. Append-only. Idempotent on (slug, occurred_at, source_chunk_id) when source_chunk_id is provided. WRITE — internal/MCP-stdio only.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description:
            "The page the event is attached to. Must reference an existing page (FK CASCADE).",
        },
        occurred_at: {
          type: "string",
          description:
            "When the event happened (ISO-8601). Not when it was recorded.",
        },
        event: { type: "string" },
        source_chunk_id: { type: "string" },
      },
      required: ["slug", "occurred_at", "event"],
      additionalProperties: false,
    },
  },
  {
    name: "entity_facts",
    description:
      "List facts about an entity, ordered by confidence (default) or recency. Optional `since` filter on written_at and `source_slug` filter to narrow to facts derived from a single page.",
    inputSchema: {
      type: "object",
      properties: {
        entity_slug: { type: "string" },
        since: { type: "string" },
        source_slug: { type: "string" },
        order: {
          type: "string",
          enum: ["confidence", "recency"],
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["entity_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "entity_timeline",
    description:
      "Chronological event log for a page. Newest-first. Optional `since` / `until` date bounds.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "entity_recall",
    description:
      "One-shot 'what do I know about X?' aggregator. Returns the entity's page (compiled_truth + body) plus top-confidence facts plus most-recent timeline events in a single call. The page may be null when the entity exists only as a soft-stub (facts + timeline allowed, page not yet promoted).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        fact_limit: { type: "integer", minimum: 1, maximum: 200 },
        timeline_limit: { type: "integer", minimum: 1, maximum: 200 },
        redact_body: {
          type: "boolean",
          description:
            "When true, strips markdown_body from the page row. The HTTP public-bearer path forces this on by default; internal MCP callers default false.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
  },
];
