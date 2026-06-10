/**
 * Single source of truth for the MCP tool surface.
 *
 * Each tool is declared once here as an `Operation` — a name, a description,
 * and a `params` map of `ParamDef`s. The JSON-Schema `inputSchema` that
 * `tool_defs.ts` exposes to MCP clients is DERIVED from this contract by
 * `operationInputSchema`, so the schema can never drift from the param
 * declarations (the previous failure mode: 25 hand-maintained inline schemas).
 *
 * `tests/tool_defs_contract.test.ts` pins the generated output against a
 * snapshot of the original hand-written defs, so this refactor is provably a
 * zero-behavior change.
 */

// Expressiveness floor (deliberate): a ParamDef can express
// type/description/minimum/maximum/enum only. A tool that needs a JSON-Schema
// construct this can't carry (`items` for typed arrays, `default`, `pattern`,
// `format`, `oneOf`, nested `properties`) is the escape hatch — hand-write that
// tool's def in tool_defs.ts instead of routing it through the generator, so a
// constraint is never silently dropped expecting the generator to carry it.
export type ParamType = "string" | "integer" | "number" | "boolean" | "object";

export interface ParamDef {
  type: ParamType;
  description?: string;
  /** Inclusive lower bound (integer/number). */
  minimum?: number;
  /** Inclusive upper bound (integer/number). */
  maximum?: number;
  /** Allowed string values. */
  enum?: readonly string[];
  /** Listed in the schema's `required` array when true. */
  required?: boolean;
}

export interface Operation {
  name: string;
  description: string;
  /** Declaration order is preserved into `properties` + `required`. */
  params: Record<string, ParamDef>;
}

/** Build a single JSON-Schema property object from a ParamDef. */
export function paramDefToSchema(def: ParamDef): Record<string, unknown> {
  const out: Record<string, unknown> = { type: def.type };
  if (def.minimum !== undefined) out.minimum = def.minimum;
  if (def.maximum !== undefined) out.maximum = def.maximum;
  if (def.enum !== undefined) out.enum = [...def.enum];
  if (def.description !== undefined) out.description = def.description;
  return out;
}

/** Build the full `inputSchema` (draft-7 object schema) for an operation. */
export function operationInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(op.params)) {
    properties[key] = paramDefToSchema(def);
    if (def.required) required.push(key);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = false;
  return schema;
}

// --- helpers to keep the contract terse + matching the original defs --------
const str = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "string", ...o });
const int = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "integer", ...o });
const num = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "number", ...o });
const bool = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "boolean", ...o });
const obj = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "object", ...o });
const req = { required: true } as const;

export const OPERATIONS: readonly Operation[] = [
  {
    name: "search",
    description:
      "Hybrid (vector + keyword) search over the indexed corpus. Returns ranked chunks with their parent document path and title.",
    params: {
      q: str({ ...req, description: "Natural-language query." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 5." }),
      token_budget: int({
        minimum: 1,
        maximum: 200000,
        description:
          "Optional cap on total returned content size (~chars/4 tokens). Hits are kept in rank order; the overflowing tail hit is truncated. Unset = no cap.",
      }),
    },
  },
  {
    name: "index",
    description:
      "Index a markdown document. Either pass `path` (an absolute path the daemon can read) or `sourcePath` + `text` (in-memory).",
    params: {
      path: str({ description: "Absolute path to a .md file." }),
      sourcePath: str(),
      text: str(),
    },
  },
  {
    name: "backlinks",
    description:
      "Find documents whose chunks reference the named entity. Default type is `wikilink` ([[Name]] references in markdown).",
    params: {
      name: str(req),
      type: str({ enum: ["wikilink", "tag", "date"] }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "stats",
    description:
      "Counts of indexed documents / chunks / embeddings. Cheap; no Bedrock calls.",
    params: {},
  },
  {
    name: "log_friction",
    description:
      "Record a friction event — used by the agent to flag when retrieval missed, an answer felt wrong, a tool errored out, OR when a recall produced an unexpectedly good hit (`delight`). When invoked from a skill, include extra.skill = '<skill-slug>' so `memex friction propose-fix` can group the event with the skill that fired it. Set `severity` to confused/error/blocker/nit on negative kinds for triage.",
    params: {
      kind: str({
        ...req,
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
      }),
      query: str(),
      reason: str(),
      sourcePath: str(),
      severity: str({ enum: ["confused", "error", "blocker", "nit"] }),
      extra: obj(),
    },
  },
  {
    name: "page_put",
    description:
      "Create or update a page in the DB-canonical store. Idempotent: re-putting identical content is a no-op. Each real change appends a row to page_versions. WRITE — internal/MCP-stdio only.",
    params: {
      slug: str({
        ...req,
        description:
          "kebab-case identifier with optional `/` namespaces (e.g. people/alice, journal/2026/05/2026-05-18).",
      }),
      type: str({
        ...req,
        description:
          "One of: concept, person, company, meeting, idea, journal, note, email, event, decision, task, source. Pass allowAdHocType=true to accept other types.",
      }),
      title: str(),
      compiled_truth: obj({
        description:
          "Editable jsonb header (tags, related slugs, tier, enriched_at, …).",
      }),
      markdown_body: str(),
      written_by: str({
        description:
          "Optional caller identifier for the audit trail (skill slug, recipe name, …).",
      }),
      allowAdHocType: bool(),
    },
  },
  {
    name: "page_append",
    description:
      "Append text to an existing page's markdown_body. Creates a new page_versions row. Requires the page to exist (use page_put for first write). WRITE — internal/MCP-stdio only.",
    params: {
      slug: str(req),
      content: str(req),
      written_by: str(),
    },
  },
  {
    name: "page_delete",
    description:
      "Soft-delete a page (sets deleted_at; the row + page_versions chain stays for audit). Idempotent. WRITE — internal/MCP-stdio only.",
    params: {
      slug: str(req),
      written_by: str(),
    },
  },
  {
    name: "page_get",
    description:
      "Read a page by slug. Returns an error if the page does not exist or is soft-deleted.",
    params: { slug: str(req) },
  },
  {
    name: "page_list",
    description:
      "List pages, newest-first. Optional filters: `type` (string), `since` (ISO timestamp), `limit` (1..1000, default 50).",
    params: {
      type: str(),
      since: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "page_versions",
    description:
      "Read the edit history of a page, newest-first. Includes body snapshots and compiled_truth snapshots at every revision.",
    params: {
      slug: str(req),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "link",
    description:
      "Assert a typed link from source_slug to target_slug. Idempotent on (source, target, type) — re-asserting updates confidence + chunk_id. Default confidence 1.0. WRITE — internal/MCP-stdio only.",
    params: {
      source_slug: str({
        ...req,
        description:
          "The source page slug. Must reference an existing page (FK constraint).",
      }),
      target_slug: str({
        ...req,
        description:
          "The target slug (soft reference; the page may or may not yet exist). Loose names like `Alice Smith` are normalised to `alice-smith`.",
      }),
      type: str({
        ...req,
        description:
          "One of: wikilink, mentions, works_at, attended, founded, advises, invested_in, knows, met, located_at, related_to, supersedes, contradicts. Pass allowAdHocType=true to accept other types.",
      }),
      confidence: num({
        minimum: 0,
        maximum: 1,
        description:
          "0..1, default 1.0 for agent-asserted edges. Use <1.0 only for deterministic-extractor outputs whose surface form was ambiguous.",
      }),
      source_chunk_id: str(),
      allowAdHocType: bool(),
    },
  },
  {
    name: "unlink",
    description:
      "Remove a typed link. Idempotent — returns removed=0 if no row matched. WRITE — internal/MCP-stdio only.",
    params: {
      source_slug: str(req),
      target_slug: str(req),
      type: str(req),
    },
  },
  {
    name: "graph_neighbors",
    description:
      "All links touching `slug` (outbound, inbound, or both), newest-first. Optional `type` filter. Returns the link rows with a per-row `direction` annotation.",
    params: {
      slug: str(req),
      type: str({ description: "Filter to a single link type." }),
      direction: str({
        enum: ["outbound", "inbound", "both"],
        description: "Default `both`.",
      }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "graph_query",
    description:
      "Typed-relationship query. Requires `type` plus at least one of `source_slug` or `target_slug`. Examples: { type:'works_at', source_slug:'people/alice' } → companies Alice works at; { type:'works_at', target_slug:'companies/acme' } → people who work at Acme.",
    params: {
      type: str(req),
      source_slug: str(),
      target_slug: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "add_fact",
    description:
      "Append a fact about an entity to the entity_facts ledger. Append-only — corrections are new facts, never edits. Idempotent on (entity_slug, fact, source_chunk_id) when source_chunk_id is provided. WRITE — internal/MCP-stdio only.",
    params: {
      entity_slug: str({
        ...req,
        description:
          "The entity the fact is about (e.g. `people/alice`). Soft reference — the entity's page need not exist yet.",
      }),
      fact: str({ ...req, description: "Short claim, one sentence." }),
      confidence: num({ minimum: 0, maximum: 1 }),
      source_slug: str({ description: "Page the fact was extracted from." }),
      source_chunk_id: str(),
      written_by: str(),
    },
  },
  {
    name: "add_timeline_event",
    description:
      "Append a timeline event to an existing page. Append-only. Idempotent on (slug, occurred_at, source_chunk_id) when source_chunk_id is provided. WRITE — internal/MCP-stdio only.",
    params: {
      slug: str({
        ...req,
        description:
          "The page the event is attached to. Must reference an existing page (FK CASCADE).",
      }),
      occurred_at: str({
        ...req,
        description:
          "When the event happened (ISO-8601). Not when it was recorded.",
      }),
      event: str(req),
      source_chunk_id: str(),
    },
  },
  {
    name: "entity_facts",
    description:
      "List facts about an entity, ordered by confidence (default) or recency. Optional `since` filter on written_at and `source_slug` filter to narrow to facts derived from a single page.",
    params: {
      entity_slug: str(req),
      since: str(),
      source_slug: str(),
      order: str({ enum: ["confidence", "recency"] }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "entity_timeline",
    description:
      "Chronological event log for a page. Newest-first. Optional `since` / `until` date bounds.",
    params: {
      slug: str(req),
      since: str(),
      until: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "entity_recall",
    description:
      "One-shot 'what do I know about X?' aggregator. Returns the entity's page (compiled_truth + body) plus top-confidence facts plus most-recent timeline events in a single call. The page may be null when the entity exists only as a soft-stub (facts + timeline allowed, page not yet promoted).",
    params: {
      slug: str(req),
      fact_limit: int({ minimum: 1, maximum: 200 }),
      timeline_limit: int({ minimum: 1, maximum: 200 }),
      redact_body: bool({
        description:
          "When true, strips markdown_body from the page row. The HTTP public-bearer path forces this on by default; internal MCP callers default false.",
      }),
    },
  },
  {
    name: "jobs_submit",
    description:
      "Submit a durable job. Idempotent when `idempotency_key` is provided (re-submit returns the existing row). Optional `parent_job_id` records a fan-out edge so the parent can detect fan-in via the child-done inbox. WRITE -- internal/MCP-stdio only.",
    params: {
      kind: str(req),
      payload: obj(),
      priority: int({ minimum: 1, maximum: 10 }),
      max_retries: int({ minimum: 0, maximum: 10 }),
      parent_job_id: str(),
      idempotency_key: str(),
      not_before: str(),
    },
  },
  {
    name: "jobs_cancel",
    description:
      "Cancel a pending job. By default cascades to all pending descendants. WRITE -- internal/MCP-stdio only.",
    params: {
      id: str(req),
      cascade: bool(),
      reason: str(),
    },
  },
  {
    name: "jobs_list",
    description:
      "List jobs newest-first. Optional filters: status, kind, parent_job_id, since (ISO timestamp), limit (1..1000, default 100).",
    params: {
      status: str(),
      kind: str(),
      parent_job_id: str(),
      since: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "jobs_get",
    description:
      "Get the full detail of a job including payload, result, children, and unread child-done inbox count.",
    params: { id: str(req) },
  },
  {
    name: "jobs_logs",
    description:
      "Compact log view of a job: status, retries, last_error, children count + status breakdown, unread inbox count. Designed to fit in a single chat reply.",
    params: { id: str(req) },
  },
];
