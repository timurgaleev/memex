/**
 * Brain identity — a thin, cheap "who am I + how big am I" read for a
 * thin-client banner. Bundles the running version, the storage engine kind,
 * and the corpus counters (documents / chunks / embeddings / pages / sources)
 * plus the brain's birth timestamp into one object.
 *
 * Pure read; no Bedrock. Reuses `storage.stats()` for the document/chunk/
 * embedding counts and adds the page + source counts the banner wants.
 * Deliberately surfaces NO slugs / titles / bodies — only counts — so it is
 * safe on the public ingress.
 *
 * TENANT AXIS: a scoped caller passes its read set and every counter is
 * computed over that set only. Whole-brain totals are a disclosure in their
 * own right — they tell one tenant how much the others hold, and differencing
 * them across two reads leaks the neighbours' write rate — so a scoped caller
 * never sees them. An unscoped caller (local CLI, internal token) still gets
 * the whole brain.
 */
import type { Storage } from "./storage.ts";
import { VERSION } from "../version.ts";

export interface BrainIdentity {
  version: string;
  engine: string;
  documents: number;
  chunks: number;
  embeddings: number;
  pages: number;
  sources: number;
  /** Earliest page creation timestamp (the brain's birth), or null when empty. */
  created_at: string | null;
}

export async function brainIdentity(
  storage: Storage,
  sourceIds?: string[],
): Promise<BrainIdentity> {
  const engine = storage.engine();
  // `undefined` = unscoped (local CLI / internal token) → whole brain.
  // An ARRAY, empty included, is a scope: a caller granted nothing must be
  // told it holds nothing, not handed the whole brain. The fail-closed path
  // hands us a one-element sentinel that matches no real source, and it has to
  // land in this branch too.
  const scope = sourceIds === undefined ? null : sourceIds;
  if (scope === null) {
    const [stats, pagesRow, sourcesRow, createdRow] = await Promise.all([
      storage.stats(),
      engine.query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM pages WHERE deleted_at IS NULL",
      ),
      engine.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM sources"),
      engine.query<{ created_at: string | null }>(
        "SELECT MIN(created_at)::text AS created_at FROM pages WHERE deleted_at IS NULL",
      ),
    ]);
    return {
      version: VERSION,
      engine: engine.kind,
      documents: stats.documents,
      chunks: stats.chunks,
      embeddings: stats.embeddings,
      pages: pagesRow.rows[0]?.c ?? 0,
      sources: sourcesRow.rows[0]?.c ?? 0,
      created_at: createdRow.rows[0]?.created_at ?? null,
    };
  }
  const [docsRow, chunksRow, embsRow, pagesRow, createdRow, sourcesRow] =
    await Promise.all([
    engine.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM documents WHERE source_id = ANY($1)",
      [scope],
    ),
    engine.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM chunks ch
         JOIN documents d ON d.id = ch.document_id
        WHERE d.source_id = ANY($1)`,
      [scope],
    ),
    engine.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM embeddings e
         JOIN chunks ch ON ch.id = e.chunk_id
         JOIN documents d ON d.id = ch.document_id
        WHERE d.source_id = ANY($1)`,
      [scope],
    ),
    engine.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1)",
      [scope],
    ),
    engine.query<{ created_at: string | null }>(
      `SELECT MIN(created_at)::text AS created_at FROM pages
        WHERE deleted_at IS NULL AND source_id = ANY($1)`,
      [scope],
    ),
    // Count the sources that actually EXIST in the grant, not the length of the
    // grant: a duplicate entry would double, and the fail-closed sentinel names
    // no real source at all — reporting 1 there would claim a tenant the caller
    // cannot see.
    engine.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM sources WHERE id = ANY($1)",
      [scope],
    ),
  ]);
  return {
    version: VERSION,
    engine: engine.kind,
    documents: docsRow.rows[0]?.c ?? 0,
    chunks: chunksRow.rows[0]?.c ?? 0,
    embeddings: embsRow.rows[0]?.c ?? 0,
    pages: pagesRow.rows[0]?.c ?? 0,
    // The sources the caller can actually see — not how many the brain holds.
    sources: sourcesRow.rows[0]?.c ?? 0,
    created_at: createdRow.rows[0]?.created_at ?? null,
  };
}
