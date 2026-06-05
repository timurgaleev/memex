/**
 * Public-ingress body redaction — the SINGLE source of truth shared by
 * both ingress paths (REST routes in `http/` and the MCP JSON-RPC
 * dispatcher in `mcp/`). It lives in `core/` so neither ingress layer
 * imports the other: importing an `http/` route into `mcp/dispatch.ts`
 * created a module cycle that left exports undefined at init.
 *
 * Policy: on public ingress (Cloudflare `Cf-Connecting-Ip`) read tools
 * return only an allowlist of metadata fields — never note bodies —
 * unless the operator opts in with `MEMEX_PUBLIC_READ_BODIES=1`.
 * Allowlists are fail-safe: a new body-ish field is stripped by default.
 */

/** True when the operator opted into returning full bodies publicly. */
export function publicReadBodiesAllowed(): boolean {
  const v = (process.env["MEMEX_PUBLIC_READ_BODIES"] ?? "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

// Search-hit fields safe to return on public ingress.
const PUBLIC_SAFE_FIELDS = new Set([
  "title",
  "sourcePath",
  "score",
  "documentId",
  "chunkId",
  "kind",
  "rank",
]);

/** Strip every search-hit field not in the public allowlist. */
export function redactBodies<T extends Record<string, unknown>>(
  hits: readonly T[],
): T[] {
  return hits.map((h) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(h)) {
      if (PUBLIC_SAFE_FIELDS.has(k)) out[k] = h[k];
    }
    return out as T;
  });
}

// Page/version row fields safe to return on public ingress.
const PUBLIC_SAFE_PAGE_FIELDS = new Set([
  "slug",
  "type",
  "title",
  "compiled_truth",
  "content_hash",
  "created_at",
  "updated_at",
]);

/** Strip every page/version-row field not in the public allowlist. */
export function redactBody<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (PUBLIC_SAFE_PAGE_FIELDS.has(k)) out[k] = row[k];
  }
  return out as T;
}

// Entity-fact row fields safe to return on public ingress. The free-text
// `fact` is note-derived private content — body-equivalent — and is omitted.
const PUBLIC_SAFE_FACT_FIELDS = new Set([
  "id",
  "entity_slug",
  "confidence",
  "source_slug",
  "source_chunk_id",
  "written_by",
  "written_at",
]);

/** Strip the `fact` text (and any non-allowlisted field) from fact rows. */
export function redactFacts<T extends Record<string, unknown>>(
  rows: readonly T[],
): T[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      if (PUBLIC_SAFE_FACT_FIELDS.has(k)) out[k] = r[k];
    }
    return out as T;
  });
}

// Timeline-event row fields safe to return on public ingress. The free-text
// `event` is note-derived private content — body-equivalent — and is omitted.
const PUBLIC_SAFE_TIMELINE_FIELDS = new Set([
  "id",
  "slug",
  "occurred_at",
  "source_chunk_id",
  "written_at",
]);

/** Strip the `event` text (and any non-allowlisted field) from event rows. */
export function redactTimeline<T extends Record<string, unknown>>(
  rows: readonly T[],
): T[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      if (PUBLIC_SAFE_TIMELINE_FIELDS.has(k)) out[k] = r[k];
    }
    return out as T;
  });
}

// Backlink-hit fields safe to return on public ingress. `surfaceForm` is the
// raw note-authored wikilink display text (e.g. `[[people/jane|Jane's lawyer]]`
// → `Jane's lawyer`) — note-derived private content, body-equivalent, omitted.
// `sourcePath`/`title`/`documentId` already surface via the search/page
// allowlists, so they stay consistent with the existing public policy.
const PUBLIC_SAFE_BACKLINK_FIELDS = new Set([
  "documentId",
  "sourcePath",
  "title",
  "mentionCount",
]);

/** Strip `surfaceForm` (and any non-allowlisted field) from backlink hits. */
export function redactBacklinks<T extends Record<string, unknown>>(
  hits: readonly T[],
): T[] {
  return hits.map((h) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(h)) {
      if (PUBLIC_SAFE_BACKLINK_FIELDS.has(k)) out[k] = h[k];
    }
    return out as T;
  });
}

// Job-row fields safe to return on public ingress. The job operational
// status is non-sensitive, but `payload` (arbitrary caller JSON), `result`
// (handler output), `last_error` (raw error text — can embed vault paths /
// note snippets) and `idempotency_key` (caller-derived, often a path) are
// note-derived/free-text and are omitted. Covers JobSummary (jobs_list),
// JobDetail (jobs_get) and the curated jobs_logs object via one allowlist;
// `children_count` is kept for the jobs_logs shape. Fail-safe: a new
// free-text field is dropped by default.
const PUBLIC_SAFE_JOB_FIELDS = new Set([
  "id",
  "kind",
  "status",
  "priority",
  "retry_count",
  "parent_job_id",
  "depth",
  "created_at",
  "updated_at",
  "next_attempt_at",
  "started_at",
  "finished_at",
  "inbox_unread",
  "children_count",
]);

/** Strip free-text/arbitrary fields from a single job row. */
export function redactJob<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (PUBLIC_SAFE_JOB_FIELDS.has(k)) out[k] = row[k];
  }
  return out as T;
}
