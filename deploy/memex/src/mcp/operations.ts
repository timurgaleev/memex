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
import { OperationError } from "../core/operation-error.ts";

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

/**
 * Enforce the declared param contract for one operation: a PRESENT param must
 * match its declared type, enum membership, and numeric bounds. Throws
 * `OperationError('invalid_params')` so the dispatch catch renders the
 * structured envelope.
 *
 * Scope decisions:
 *   - Required-PRESENCE is left to the per-handler guards — they carry richer,
 *     tool-specific messages (e.g. `search: \`q\` is required`); duplicating it
 *     here would shadow those. This validates only what's present.
 *   - Unknown params are NOT rejected: a handler may read an undeclared field,
 *     and the JSON-Schema `additionalProperties:false` already documents the
 *     surface for clients. Tightening to reject unknowns is a separate, riskier
 *     decision.
 *
 * Safe to enforce uniformly: the MCP client derives its params FROM this same
 * contract (the ParamDefs generate the advertised inputSchema), so a
 * well-formed call can never be rejected here — only a malformed one, which the
 * handler would have rejected anyway. Catches the constraints the schema
 * already advertises but individual handlers may not all check by hand.
 */
export function validateParams(
  op: Operation,
  params: Record<string, unknown>,
): void {
  const fail = (key: string, reason: string, suggestion: string): never => {
    throw new OperationError(
      "invalid_params",
      `${op.name}: \`${key}\` ${reason}`,
      suggestion,
    );
  };
  for (const [key, def] of Object.entries(op.params)) {
    const v = params[key];
    // Skip ONLY absent params (presence is the handler's job). A present `null`
    // is NOT skipped: the contract's declared types are non-nullable
    // (paramDefToSchema emits a bare `type`, never `["t","null"]`), so an
    // explicit null is a malformed value and must fail the type check below
    // rather than slip through to a handler's `?? default`.
    if (v === undefined) continue;

    switch (def.type) {
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v)) {
          fail(key, "must be an integer", `Pass \`${key}\` as a whole number.`);
        }
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(key, "must be a finite number", `Pass \`${key}\` as a number.`);
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") {
          fail(key, "must be a boolean", `Pass \`${key}\` as true or false.`);
        }
        break;
      case "string":
        if (typeof v !== "string") {
          fail(key, "must be a string", `Pass \`${key}\` as a string.`);
        }
        break;
      case "object":
        // typeof null === "object", so null must be rejected explicitly; an
        // array is an object too but not a valid JSON object value here.
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          fail(key, "must be an object", `Pass \`${key}\` as a JSON object.`);
        }
        break;
    }

    if (def.enum && !(typeof v === "string" && def.enum.includes(v))) {
      fail(
        key,
        `must be one of: ${def.enum.join(", ")}`,
        `Pass \`${key}\` as one of: ${def.enum.join(", ")}.`,
      );
    }
    if (
      (def.type === "integer" || def.type === "number") &&
      typeof v === "number"
    ) {
      if (def.minimum !== undefined && v < def.minimum) {
        fail(key, `must be >= ${def.minimum}`, `Pass \`${key}\` >= ${def.minimum}.`);
      }
      if (def.maximum !== undefined && v > def.maximum) {
        fail(key, `must be <= ${def.maximum}`, `Pass \`${key}\` <= ${def.maximum}.`);
      }
    }
  }
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
        description:
          "One of: concept, person, company, meeting, idea, journal, note, email, event, decision, task, source. OPTIONAL — inferred from the slug's first segment (people/… → person) when omitted, defaulting to note. Pass allowAdHocType=true to accept other types.",
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
    name: "page_restore",
    description:
      "Undelete a soft-deleted page (clears deleted_at). The inverse of page_delete; no-op if the page is missing or already live. WRITE — internal/MCP-stdio only.",
    params: {
      slug: str(req),
      written_by: str(),
    },
  },
  {
    name: "page_revert",
    description:
      "Roll a page's body back to a prior page_versions snapshot. Creates a NEW version with the old content (history is append-only). `version` is the target version_n (see page_versions). WRITE — internal/MCP-stdio only.",
    params: {
      slug: str(req),
      version: int({ ...req, minimum: 1 }),
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
    name: "traverse_graph",
    description:
      "Recursive N-hop graph walk from a start slug over the link graph — the multi-hop counterpart to graph_neighbors. Returns each reachable node once at its shortest `depth`. `direction` (outbound|inbound|both, default outbound), optional `type` edge filter, `max_depth` (1..10, default 3), `limit` (1..1000, default 100). Example: {start_slug:'people/alice', direction:'both', max_depth:2} → everyone within 2 hops of Alice.",
    params: {
      start_slug: str(req),
      direction: str({ enum: ["outbound", "inbound", "both"] }),
      type: str(),
      max_depth: int({ minimum: 1, maximum: 10 }),
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
      query: str({
        description:
          "Optional topic to focus the recalled facts on (e.g. 'funding history'). When set, the entity's facts are ranked by semantic similarity to it instead of by confidence. Falls-open: reverts to confidence order when embedding is unavailable.",
      }),
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
      timeout_ms: int({ minimum: 1, maximum: 2147483647 }),
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
  {
    name: "get_chunks",
    description:
      "Return a page's (or document's) content chunks in order. Pass `slug` (resolved through the page's page://<slug> search mirror) or `source_path` (a raw document). At least one is required; chunks come back ordered by chunk_index.",
    params: {
      slug: str(),
      source_path: str(),
    },
  },
  {
    name: "resolve_slugs",
    description:
      "Fuzzy-resolve a partial/informal string to canonical page slugs, ranked best-first (exact live-slug → score 1; else pg_trgm similarity over title + slug, soft-deleted excluded). Returns [{slug, title, score}].",
    params: {
      query: str(req),
      limit: int({ minimum: 1, maximum: 100 }),
    },
  },
  {
    name: "add_tag",
    description:
      "Add a tag to a page (normalized: trim + lowercase). Idempotent. The page must exist. WRITE — internal/MCP-stdio only.",
    params: {
      slug: str(req),
      tag: str(req),
    },
  },
  {
    name: "remove_tag",
    description:
      "Remove a tag from a page. Idempotent (removing an absent tag is a no-op). WRITE — internal/MCP-stdio only.",
    params: {
      slug: str(req),
      tag: str(req),
    },
  },
  {
    name: "get_tags",
    description:
      "List a page's tags in lexical order. Empty list for an unknown or untagged page.",
    params: { slug: str(req) },
  },
  {
    name: "relational_recall",
    description:
      "Deterministic relational query — resolves a seed entity from a natural-language relationship question ('who does alice report to?', 'who works at acme', 'how is alice connected to bob') and fans out typed edges. Returns [{slug, relation, depth}]. No LLM.",
    params: {
      query: str(req),
      limit: int({ minimum: 1, maximum: 200 }),
      depth: int({ minimum: 1, maximum: 6 }),
    },
  },
  {
    name: "get_links",
    description:
      "All typed edges touching `slug`, grouped by type and direction. An `outbound` group holds edges where the slug is the source; `inbound` where it is the target. Groups are ordered by type then outbound-before-inbound; edges within a group are newest-first. Optional `limit` (1..1000, default 1000) caps the edges scanned per direction.",
    params: {
      slug: str(req),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "list_link_sources",
    description:
      "The link-type catalogue with live per-type edge counts. Every KNOWN_LINK_TYPES entry is returned (count 0 when unused), plus any ad-hoc type present in the graph (known:false). Ordered by count DESC then type ASC, so the most-used relationship types surface first while the full vocabulary stays discoverable. Returns [{type, count, known}].",
    params: {},
  },
  {
    name: "find_orphans",
    description:
      "Pages with zero inbound links — nothing in the graph references them. The natural enrichment targets (a page nobody links to is new or forgotten). Newest-first. Optional `type` page-type filter; `limit` (1..1000, default 50). Deterministic, no LLM.",
    params: {
      type: str({ description: "Restrict to a single page type (e.g. person)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "find_experts",
    description:
      "Pages ranked by graph link-degree — the hubs of the knowledge base. Degree counts distinct in+out neighbours that resolve to a LIVE page (unresolved [[wikilink]] stubs don't inflate it). Optional `type` page-type filter; `limit` (1..200, default 5). Deterministic, no LLM.",
    params: {
      type: str({ description: "Restrict to a single page type." }),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "find_contradictions",
    description:
      "Page pairs joined by an explicit `contradicts` edge (the conflict markers already asserted in the graph). Surfaces existing edges; does NOT run a fresh probe or call an LLM. Optional `slug` substring filter (matches either side); `limit` (1..200, default 20).",
    params: {
      slug: str({ description: "Substring filter; matches either side of the pair (case-insensitive)." }),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "find_trajectory",
    description:
      "Chronological 'how did this entity change?' log for one slug — the merged, oldest-first view of its entity_facts ledger and its timeline_events. Each fact anchors at its valid_from (else written_at); each event at occurred_at. Optional `since`/`until` ISO bounds on that anchor; `limit` (1..500, default 100). Deterministic, no LLM.",
    params: {
      entity_slug: str({ ...req, description: "The entity to chart (e.g. companies/acme, people/alice)." }),
      since: str({ description: "Lower bound (ISO timestamp) on the point's anchor date." }),
      until: str({ description: "Upper bound (ISO timestamp)." }),
      limit: int({ minimum: 1, maximum: 500 }),
    },
  },
  {
    name: "get_recent_salience",
    description:
      "Live pages ranked by the deterministic `salience` score (migration 036: high-emotion tags + graph link-degree, recomputed by the recompute-salience cycle phase) — the 'what matters' read. Optional `type` filter and `days` recency window. No LLM, no Bedrock. Surfaces page slugs/titles — internal/MCP-stdio only.",
    params: {
      type: str({ description: "Filter to a single page type (exact match), e.g. person." }),
      days: int({ minimum: 1, description: "Only pages updated within the last N days. Omit for all-time." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 20)." }),
    },
  },
  {
    name: "find_anomalies",
    description:
      "Deterministic structural OUTLIERS over the live page graph. memex has no retrieval/access counters, so this keys on the signals it does have: `degree_outlier` (a connectivity hub — link-degree at/above mean + sigma·stddev across live pages) and `stale_salient` (a high-salience page whose updated_at is older than staleDays — important memory gone cold). No LLM. Surfaces page slugs/titles — internal/MCP-stdio only.",
    params: {
      sigma: num({ minimum: 0, description: "Std-devs above the mean degree to flag a hub (default 2)." }),
      staleDays: int({ minimum: 1, description: "Days an updated_at must lag to count a salient page stale (default 90)." }),
      salienceFloor: num({ minimum: 0, maximum: 1, description: "Salience floor for the stale_salient class (default 0.5)." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows per anomaly kind (default 20)." }),
    },
  },
  {
    name: "recall",
    description:
      "Read a single fact by its numeric id from the entity_facts ledger. Returns the fact row (claim, confidence, source, mig037 metadata). Returns an error if the id is unknown or the fact has been forgotten (tombstoned via forget_fact).",
    params: {
      id: int({ ...req, minimum: 1, description: "Fact id (entity_facts.id)." }),
    },
  },
  {
    name: "forget_fact",
    description:
      "Forget (soft-delete) a fact by id — stamps forgotten_at so the fact stops surfacing in recall; the row is retained for audit. Idempotent: a second forget is a no-op (forgotten=false), an unknown id reports found=false. Optional `reason` is stored on the tombstoned row. WRITE — internal/MCP-stdio only.",
    params: {
      id: int({ ...req, minimum: 1, description: "Fact id to forget (entity_facts.id)." }),
      reason: str({ description: "Optional audit note stored on the forgotten row." }),
    },
  },
  {
    name: "get_brain_identity",
    description:
      "Brain identity + counters for a thin-client banner. Returns the running version, the storage engine kind, and corpus counts (documents / chunks / embeddings / pages / sources) plus the brain's earliest created_at. Counts only — no slugs, titles, or bodies. Cheap; no Bedrock.",
    params: {},
  },
  {
    name: "purge_deleted_pages",
    description:
      "Admin escape hatch: HARD-delete pages whose deleted_at is older than `older_than_hours` (default 72). Cascades to page_versions / page_aliases / links via FK. The manual counterpart to the autopilot purge cycle phase. Returns the count + reaped slugs. WRITE — internal/MCP-stdio only.",
    params: {
      older_than_hours: num({
        minimum: 0,
        description: "Age cutoff in hours. Pages soft-deleted longer ago than this are reaped. Default 72.",
      }),
    },
  },
  {
    name: "query",
    description:
      "Refinement search: hybrid-search `q`, then bias the ranking toward a second `refine` term via weighted RRF (a chunk strong for BOTH floats up). Reorders within the primary candidate set — never widens it. Deterministic (no LLM rerank). `primary_weight` / `refine_weight` tune the pull; omit `refine` to behave like plain search.",
    params: {
      q: str({ ...req, description: "Primary natural-language query." }),
      refine: str({ description: "Second term to refine/intersect the ranking against." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 5." }),
      primary_weight: num({ minimum: 0, description: "RRF weight for the primary query. Default 1." }),
      refine_weight: num({ minimum: 0, description: "RRF weight for the refine term. Default 1." }),
    },
  },
  {
    name: "code_callers",
    description:
      "Call-graph: who calls the symbol `name`. Returns the `code-caller` mentions (surface form + chunk + source path) over the indexed code corpus. Deterministic, no LLM. Empty when the symbol is unknown or no code is indexed. Optional `limit` (1..1000, default 200).",
    params: {
      name: str({ ...req, description: "Bare symbol name to find callers of (e.g. `hybridSearch`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "code_callees",
    description:
      "Call-graph: what the symbol enclosing `<path>:<line>` calls. Two-phase — resolves the innermost code-def covering that file:line, then returns its `code-callee` mentions. `resolved_symbol` reports which symbol was matched (null = none covers that line). Deterministic, no LLM. Optional `limit` (1..1000, default 200).",
    params: {
      target: str({ ...req, description: "`<path>:<line>` of a call site / symbol body (e.g. `src/x.ts:42`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "volunteer_context",
    description:
      "Push-based context: given a rolling conversation window, deterministically extract entity candidates, resolve them to existing page pointers (alias 0.9 / title 0.8 / slug-suffix 0.6, + a 0.05 boost for newest-turn or >=2-turn mentions), gate by confidence, cap to N, and return volunteered pages [{slug,title,display,confidence,arm,rationale,synopsis}]. No LLM, no Bedrock. Surfaces page slugs/titles + synopses — internal/MCP-stdio only. Set `stats:true` for the per-arm used/volunteered precision feedback (approximate, derived from last_retrieved_at).",
    params: {
      window: str({ ...req, description: "Conversation window text. 'user:'/'assistant:' line prefixes set the role; unprefixed input is one user turn." }),
      max_pages: int({ minimum: 1, maximum: 5, description: "Max pages volunteered (default 3, cap 5)." }),
      min_confidence: num({ minimum: 0, maximum: 1, description: "Confidence gate 0..1 (default 0.7). At the default, slug-suffix matches never volunteer." }),
      session_id: str({ description: "Opaque session id stamped on each logged volunteer event." }),
      turn: int({ minimum: 0, description: "Turn number stamped on each logged volunteer event." }),
      stats: bool({ description: "Return per-arm used/volunteered precision stats instead of volunteering (uses `turn` as the day window when set)." }),
    },
  },
  {
    name: "advisor",
    description:
      "Ranked, read-only \"what to do next\" for this brain: pending migrations, version drift, stalled/failed jobs, low embedding coverage, and setup smells. Each finding has a severity (high/medium/low/info), a why-it-matters, and the exact fix command. Never mutates, never calls an LLM. Tell the user; ask before running any fix. Internal-only.",
    params: {},
  },
  {
    name: "list_brain_skillpack",
    description:
      "List the brain-resident skillpack this brain ships (the local deploy/skills pack): each skill's slug and one-line description. Read-only. After orienting, ask the user whether to install the pack (memex skillpack).",
    params: {},
  },
  {
    name: "list_concepts",
    description:
      "List synthesized concept pages (LLM-derived from the corpus by the synthesize-concepts cycle phase): concept_slug, title, tier (T1/T2/T3), atom_count, narrative. Ordered by atom_count DESC. Read-only; internal-only (derived over private notes).",
    params: {
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "list_takes",
    description:
      "List synthesized 'takes' (opinionated claims the propose-takes phase derived, optionally graded): take_key, claim_text, kind, weight, domain, status (queued/accepted/rejected). Advisory only — never mutates notes. Read-only; internal-only.",
    params: {
      status: str({ enum: ["queued", "accepted", "rejected"], description: "Filter by review status." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "get_calibration_profile",
    description:
      "The latest narrative calibration/bias profile (from the calibration-profile phase): grade tallies, accuracy, pattern statements, bias tags. Read-only; internal-only. Null when no profile has been generated yet.",
    params: {},
  },
];
