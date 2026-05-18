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
import { getPage, validateSlug, type PageRow } from "./pages.ts";
import {
  getEntityTimeline,
  type TimelineEventRow,
} from "./timeline.ts";

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
  limit?: number;
}

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
    params.push(normaliseSince(opts.since));
    where.push(`written_at >= $${params.length}::timestamptz`);
  }
  if (opts.source_slug !== undefined) {
    validateSlug(opts.source_slug);
    params.push(opts.source_slug);
    where.push(`source_slug = $${params.length}`);
  }
  const order =
    opts.order === "recency"
      ? "written_at DESC"
      : "confidence DESC, written_at DESC";
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);
  const r = await storage.engine().query<FactRow>(
    `SELECT id, entity_slug, fact, confidence,
            source_slug, source_chunk_id, written_by,
            written_at::text AS written_at
       FROM entity_facts
       WHERE ${where.join(" AND ")}
       ORDER BY ${order}
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// entityRecall — the combined "what do I know about X?" answer.
// ---------------------------------------------------------------------------

export interface EntityRecallOptions {
  fact_limit?: number;
  timeline_limit?: number;
  redact_body?: boolean;
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
  const [page, facts, timeline] = await Promise.all([
    getPage(storage, slug),
    listFacts(storage, slug, { limit: factLimit, order: "confidence" }),
    getEntityTimeline(storage, slug, { limit: timelineLimit }),
  ]);
  let outPage = page;
  if (page && opts.redact_body) {
    const { markdown_body: _omit, ...rest } = page;
    outPage = rest as PageRow;
  }
  return { slug, page: outPage, facts, timeline };
}
