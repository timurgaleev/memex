/**
 * Entity facts — append-only fact ledger per entity, plus the
 * `entityRecall` aggregator that returns the entity's page row +
 * top-confidence facts + most-recent timeline events in a single
 * call. The combined response is what the agent reaches for when
 * the operator asks "what do I know about X?".
 *
 * Schema: `entity_facts` (migration 018).
 *
 * Writes are append-only with idempotency on
 * (entity_slug, fact, source_chunk_id) for chunk-sourced facts.
 * Manual facts (no source_chunk_id) bypass dedup.
 */
import type { Storage } from "./storage.ts";
import { embedText } from "./embedding.ts";
import { getPage, validateSlug, type PageRow } from "./pages.ts";
import {
  getEntityTimeline,
  type TimelineEventRow,
} from "./timeline.ts";
import { effectiveConfidence, factDecayEnabled } from "./facts-decay.ts";

export interface AddFactInput {
  entity_slug: string;
  fact: string;
  confidence?: number;
  source_slug?: string;
  source_chunk_id?: string;
  written_by?: string;
}

export interface FactRow {
  id: number;
  entity_slug: string;
  fact: string;
  confidence: number;
  source_slug: string | null;
  source_chunk_id: string | null;
  written_by: string | null;
  written_at: string;
  /** mig037 metadata. NULL on legacy rows / a fence without these columns. */
  kind: string | null;
  notability: string | null;
  /** DATE text `YYYY-MM-DD` or NULL. */
  valid_from: string | null;
  valid_until: string | null;
}

export interface AddFactResult {
  id: number | null;
  entity_slug: string;
  /** False when the (entity_slug, fact, source_chunk_id) tuple already existed. */
  inserted: boolean;
}

function normaliseConfidence(c: number | undefined): number {
  if (c === undefined) return 1.0;
  if (typeof c !== "number" || Number.isNaN(c)) {
    throw new Error("confidence must be a number in [0, 1]");
  }
  if (c < 0 || c > 1) {
    throw new Error("confidence must be in [0, 1]");
  }
  return c;
}

/**
 * Append a fact about an entity. Idempotent on
 * (entity_slug, fact, source_chunk_id) — a recipe re-emitting the
 * same fact from the same chunk does not duplicate. Manual entries
 * (no source_chunk_id) always insert.
 */
export async function addFact(
  storage: Storage,
  input: AddFactInput,
): Promise<AddFactResult> {
  validateSlug(input.entity_slug);
  if (typeof input.fact !== "string" || input.fact.length === 0) {
    throw new Error("fact must be a non-empty string");
  }
  const conf = normaliseConfidence(input.confidence);
  const sourceSlug = input.source_slug ?? null;
  if (sourceSlug !== null) validateSlug(sourceSlug);
  const chunkId = input.source_chunk_id ?? null;
  const writtenBy = input.written_by ?? null;

  if (chunkId === null) {
    const r = await storage.engine().query<{ id: number }>(
      `INSERT INTO entity_facts
         (entity_slug, fact, confidence, source_slug, source_chunk_id, written_by)
       VALUES ($1, $2, $3, $4, NULL, $5)
       RETURNING id`,
      [input.entity_slug, input.fact, conf, sourceSlug, writtenBy],
    );
    return {
      id: r.rows[0]?.id ?? null,
      entity_slug: input.entity_slug,
      inserted: true,
    };
  }
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO entity_facts
       (entity_slug, fact, confidence, source_slug, source_chunk_id, written_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (entity_slug, fact, source_chunk_id)
       WHERE source_chunk_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [input.entity_slug, input.fact, conf, sourceSlug, chunkId, writtenBy],
  );
  return {
    id: r.rows[0]?.id ?? null,
    entity_slug: input.entity_slug,
    inserted: r.rows.length > 0,
  };
}

export interface ListFactsOptions {
  /** ISO timestamp lower bound on written_at. */
  since?: string | Date;
  /** Filter to a single source page. */
  source_slug?: string;
  /** Sort by confidence DESC (default) or written_at DESC. */
  order?: "confidence" | "recency";
  /**
   * A pre-embedded query vector (1024-dim). When present, facts are ranked by
   * cosine similarity to it (migration 038) — embedded facts first, ordered by
   * distance, then unembedded facts by the normal confidence order. Overrides
   * `order`. The caller embeds the query (entityRecall does, falls-open).
   */
  queryVector?: number[];
  limit?: number;
  /**
   * Apply confidence decay (migration 037 `kind`/`valid_until` consumer):
   * facts past `valid_until` are dropped and the rest are re-ranked by
   * `effectiveConfidence` (older facts of a short-lived kind sink). Deterministic
   * and LLM-free. Ignored when `queryVector` is set (semantic order wins) and
   * for `order: "recency"`. Default OFF; `entityRecall` defaults it from
   * `MEMEX_FACT_DECAY`.
   */
  decay?: boolean;
}

/** When decay re-ranks in TS we fetch a wide candidate set first, then trim. */
const DECAY_FETCH_CAP = 1000;

function normaliseSince(v: string | Date): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Error("since: invalid Date");
    return v.toISOString();
  }
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("since must be a non-empty ISO string or Date");
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`since: cannot parse ${JSON.stringify(v)}`);
  }
  return d.toISOString();
}

export async function listFacts(
  storage: Storage,
  entitySlug: string,
  opts: ListFactsOptions = {},
): Promise<FactRow[]> {
  validateSlug(entitySlug);
  const params: unknown[] = [entitySlug];
  const where: string[] = ["entity_slug = $1"];
  if (opts.since !== undefined) {
    // `since` is a record-time predicate (written_at), independent of decay's
    // validity-time anchoring (valid_from): "facts recorded since X, then
    // decay-ranked". A fact recorded before `since` is intentionally excluded
    // even if its valid_from is recent -- the two filters compose by design.
    params.push(normaliseSince(opts.since));
    where.push(`written_at >= $${params.length}::timestamptz`);
  }
  if (opts.source_slug !== undefined) {
    validateSlug(opts.source_slug);
    params.push(opts.source_slug);
    where.push(`source_slug = $${params.length}`);
  }
  const hasQueryVector = !!(opts.queryVector && opts.queryVector.length > 0);
  // Decay re-ranks in TS, so it only applies to the plain confidence path:
  // a semantic query (cosine) or an explicit recency sort take precedence.
  // When `decay` is unset the global `MEMEX_FACT_DECAY` flag governs, so every
  // fact-reading surface (entity_facts + entity_recall) honors it uniformly.
  const decay = opts.decay ?? factDecayEnabled();
  const wantDecay = decay && !hasQueryVector && opts.order !== "recency";

  // When decaying, drop rows that are definitely past their `valid_until` at the
  // SQL layer so they do not consume slots in the `DECAY_FETCH_CAP` candidate
  // window (a ledger full of expired rows could otherwise crowd out fresh facts,
  // returning too few). The bound is `>= CURRENT_DATE` (keep today + future):
  // `rankByDecay` makes the exact, timezone-correct expiry call in TS, and this
  // SQL bound is conservative enough that it never drops a row TS would keep,
  // regardless of session timezone.
  if (wantDecay) {
    where.push("(valid_until IS NULL OR valid_until >= CURRENT_DATE)");
  }

  // Semantic order when a query vector is supplied: rank by cosine distance,
  // embedded facts first (NULL distance sorts last), then the normal tiebreak.
  let order: string;
  if (hasQueryVector) {
    params.push(JSON.stringify(opts.queryVector));
    order = `embedding <=> $${params.length}::vector ASC NULLS LAST, confidence DESC, written_at DESC`;
  } else {
    order =
      opts.order === "recency"
        ? "written_at DESC"
        : "confidence DESC, written_at DESC";
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  // When decaying, fetch a wide candidate set (confidence-DESC, expired rows
  // already filtered above) then re-rank + trim in TS so the true top-N by
  // effective confidence is returned. A per-entity ledger is small, so the cap
  // is not a correctness risk in practice; the documented residual is an entity
  // with more than DECAY_FETCH_CAP live facts, where a fresh low-confidence fact
  // below the confidence-DESC window could be missed.
  const sqlLimit = wantDecay ? DECAY_FETCH_CAP : limit;
  params.push(sqlLimit);
  const r = await storage.engine().query<FactRow>(
    `SELECT id, entity_slug, fact, confidence,
            source_slug, source_chunk_id, written_by,
            written_at::text AS written_at,
            kind, notability,
            valid_from::text  AS valid_from,
            valid_until::text AS valid_until
       FROM entity_facts
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}
       LIMIT $${params.length}`,
    params,
  );
  if (!wantDecay) return r.rows;
  return rankByDecay(r.rows, limit);
}

/**
 * Re-rank a fetched fact set by `effectiveConfidence`: drop facts that have
 * decayed to 0 (expired / past `valid_until`), sort by effective confidence
 * DESC with the same `confidence`/`written_at` tiebreak as the SQL path, then
 * trim to `limit`. A single `now` is captured so all rows decay against one
 * clock.
 */
function rankByDecay(rows: FactRow[], limit: number): FactRow[] {
  const now = new Date();
  const scored: { row: FactRow; eff: number }[] = [];
  for (const row of rows) {
    const eff = effectiveConfidence(row, now);
    if (eff > 0) scored.push({ row, eff });
  }
  scored.sort((a, b) => {
    if (b.eff !== a.eff) return b.eff - a.eff;
    if (b.row.confidence !== a.row.confidence) {
      return b.row.confidence - a.row.confidence;
    }
    return b.row.written_at.localeCompare(a.row.written_at);
  });
  return scored.slice(0, limit).map((s) => s.row);
}

// ---------------------------------------------------------------------------
// entityRecall — the combined "what do I know about X?" answer.
// ---------------------------------------------------------------------------

/** Max chars of `query` embedded for semantic focus (a topic, not a document). */
const MAX_QUERY_LEN = 512;

export interface EntityRecallOptions {
  fact_limit?: number;
  timeline_limit?: number;
  redact_body?: boolean;
  /**
   * Optional topic to focus the recalled facts on. When set, the entity's
   * facts are ranked by semantic similarity to it (migration 038) instead of by
   * confidence. Falls-open: if embedding the query fails (Bedrock down), recall
   * silently reverts to the confidence order.
   */
  query?: string;
  /** Injectable embedder (tests). Defaults to the Bedrock Titan path. */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Apply confidence decay to the recalled facts (mig037 consumer). When
   * undefined, defaults to the `MEMEX_FACT_DECAY` env flag. Ignored when
   * `query` (semantic focus) is supplied.
   */
  decay?: boolean;
}

export interface EntityRecallResult {
  slug: string;
  /** null when the entity has no page row yet (soft-stub case). */
  page: PageRow | null;
  facts: FactRow[];
  timeline: TimelineEventRow[];
}

/**
 * One-shot recall: the page row (compiled_truth, body) plus top-N
 * highest-confidence facts plus most-recent-N timeline events. The
 * page may be null — facts and timeline can attach to entities that
 * have not yet been promoted into `pages`.
 *
 * `redact_body: true` strips `markdown_body` from the page so the
 * caller (typically a public-bearer HTTP path) gets the agent-safe
 * shape.
 */
export async function entityRecall(
  storage: Storage,
  slug: string,
  opts: EntityRecallOptions = {},
): Promise<EntityRecallResult> {
  validateSlug(slug);
  const factLimit =
    typeof opts.fact_limit === "number" &&
    opts.fact_limit >= 1 &&
    opts.fact_limit <= 200
      ? Math.floor(opts.fact_limit)
      : 25;
  const timelineLimit =
    typeof opts.timeline_limit === "number" &&
    opts.timeline_limit >= 1 &&
    opts.timeline_limit <= 200
      ? Math.floor(opts.timeline_limit)
      : 25;
  // Falls-open semantic focus: embed the query topic; on any failure recall
  // reverts to the confidence order (queryVector stays undefined).
  let queryVector: number[] | undefined;
  if (typeof opts.query === "string" && opts.query.trim()) {
    const embed = opts.embed ?? ((t: string) => embedText(t));
    // Cap the embedded text to bound Bedrock cost/latency (a topic, not a doc).
    const q = opts.query.trim().slice(0, MAX_QUERY_LEN);
    try {
      queryVector = await embed(q);
    } catch {
      queryVector = undefined;
    }
  }
  const listOpts: ListFactsOptions = { limit: factLimit, order: "confidence" };
  if (queryVector) listOpts.queryVector = queryVector;
  // Decay applies only to the plain confidence path (not semantic focus).
  // Pass the caller's flag through (undefined -> listFacts defaults from env).
  else if (opts.decay !== undefined) listOpts.decay = opts.decay;
  const [page, facts, timeline] = await Promise.all([
    getPage(storage, slug),
    listFacts(storage, slug, listOpts),
    getEntityTimeline(storage, slug, { limit: timelineLimit }),
  ]);
  let outPage = page;
  if (page && opts.redact_body) {
    const { markdown_body: _omit, ...rest } = page;
    outPage = rest as PageRow;
  }
  return { slug, page: outPage, facts, timeline };
}
