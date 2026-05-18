/**
 * Hot memory -- short-term fact buffer with supersession (Phase A.5).
 *
 * The consolidate phase of the dream cycle (future) reads the
 * unsuperseded subset for each entity, decides what to promote into
 * `entity_facts`, and ages out / discards the rest.
 *
 * No MCP surface in A.5 -- only internal recipes write here today.
 * The schema is in place so future phases can build the consolidate
 * + supersede behaviour without another migration.
 *
 * SECURITY (read before wiring A.6 MCP tools):
 *   `hot_memory.fact` is free-text PII -- the unfiltered stream of
 *   observations the agent has just made about predictable
 *   identifiers (`people/<name>`, `companies/<name>`). The whole
 *   table is "stuff the brain just heard and hasn't vetted." Public
 *   reads MUST be internal-token-only; if a public projection is
 *   ever exposed, return `404` uniformly on miss (never an empty
 *   array tied to a slug) to avoid entity-existence enumeration.
 */
import type { Storage } from "./storage.ts";
import { validateSlug } from "./pages.ts";

const MAX_FACT_LEN = 4000;
const MAX_FREEFORM_LEN = 256;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 100;

export interface RecordHotFactInput {
  entity_slug: string;
  fact: string;
  effective_confidence?: number;
  session_id?: string;
  source_slug?: string;
  source_chunk_id?: string;
  written_by?: string;
}

export interface HotFactRow {
  id: number;
  entity_slug: string;
  fact: string;
  effective_confidence: number;
  session_id: string | null;
  source_slug: string | null;
  source_chunk_id: string | null;
  written_by: string | null;
  superseded_by: number | null;
  written_at: string;
}

function normaliseConfidence(c: number | undefined): number {
  if (c === undefined) return 1.0;
  if (typeof c !== "number" || Number.isNaN(c)) {
    throw new Error("effective_confidence must be a number in [0, 1]");
  }
  if (c < 0 || c > 1) {
    throw new Error("effective_confidence must be in [0, 1]");
  }
  return c;
}

function boundFreeform(
  value: string | undefined,
  label: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.length > MAX_FREEFORM_LEN) {
    throw new Error(
      `${label} exceeds ${MAX_FREEFORM_LEN} chars (${value.length})`,
    );
  }
  return value;
}

export async function recordHotFact(
  storage: Storage,
  input: RecordHotFactInput,
): Promise<{ id: number; entity_slug: string }> {
  validateSlug(input.entity_slug);
  if (typeof input.fact !== "string" || input.fact.length === 0) {
    throw new Error("fact must be a non-empty string");
  }
  if (input.fact.length > MAX_FACT_LEN) {
    throw new Error(`fact exceeds ${MAX_FACT_LEN} chars (${input.fact.length})`);
  }
  const conf = normaliseConfidence(input.effective_confidence);
  if (input.source_slug !== undefined) validateSlug(input.source_slug);
  const sessionId = boundFreeform(input.session_id, "session_id");
  const sourceChunkId = boundFreeform(input.source_chunk_id, "source_chunk_id");
  const writtenBy = boundFreeform(input.written_by, "written_by");
  const r = await storage.engine().query<{ id: number }>(
    `INSERT INTO hot_memory
       (entity_slug, fact, effective_confidence,
        session_id, source_slug, source_chunk_id, written_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.entity_slug,
      input.fact,
      conf,
      sessionId,
      input.source_slug ?? null,
      sourceChunkId,
      writtenBy,
    ],
  );
  return { id: r.rows[0]!.id, entity_slug: input.entity_slug };
}

/**
 * Mark `oldId` as superseded by `newId`. Both rows remain in the
 * table so the audit chain is intact; only the `superseded_by`
 * column updates. Idempotent on re-supersede with the same new id.
 *
 * Lost-update note: under concurrent supersedes with DIFFERENT
 * `newId` values, exactly one writer wins (the one whose insert
 * landed first while `superseded_by` was still NULL). The losing
 * caller receives `updated: false` and the returned
 * `superseded_by` value reveals who actually won; treat that as
 * a signal to re-read state rather than retry blindly.
 */
export async function supersedeHotFact(
  storage: Storage,
  oldId: number,
  newId: number,
): Promise<{ updated: boolean; superseded_by: number | null }> {
  if (oldId === newId) {
    throw new Error("supersedeHotFact: cannot supersede a row by itself");
  }
  const r = await storage.engine().query<{ superseded_by: number | null }>(
    `WITH attempted AS (
       UPDATE hot_memory
         SET superseded_by = $2
         WHERE id = $1
           AND (superseded_by IS NULL OR superseded_by = $2)
         RETURNING superseded_by
     )
     SELECT superseded_by FROM attempted
     UNION ALL
     SELECT superseded_by FROM hot_memory
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM attempted)
     LIMIT 1`,
    [oldId, newId],
  );
  const row = r.rows[0];
  if (!row) {
    return { updated: false, superseded_by: null };
  }
  return {
    updated: row.superseded_by === newId,
    superseded_by: row.superseded_by,
  };
}

export interface ListHotOptions {
  unsuperseded_only?: boolean;
  session_id?: string;
  limit?: number;
}

export async function listHotFacts(
  storage: Storage,
  entitySlug: string,
  opts: ListHotOptions = {},
): Promise<HotFactRow[]> {
  validateSlug(entitySlug);
  const params: unknown[] = [entitySlug];
  const where: string[] = ["entity_slug = $1"];
  if (opts.unsuperseded_only !== false) {
    where.push("superseded_by IS NULL");
  }
  if (opts.session_id !== undefined) {
    params.push(opts.session_id);
    where.push(`session_id = $${params.length}`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  params.push(limit);
  const r = await storage.engine().query<HotFactRow>(
    `SELECT id, entity_slug, fact, effective_confidence,
            session_id, source_slug, source_chunk_id,
            written_by, superseded_by,
            written_at::text AS written_at
       FROM hot_memory
       WHERE ${where.join(" AND ")}
       ORDER BY effective_confidence DESC, written_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}
