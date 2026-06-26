/**
 * Backlinks — find documents whose chunks contain a wikilink (or other
 * named entity) pointing at a given target.
 *
 * The query is a simple JOIN over entities + entity_mentions + chunks +
 * documents. For now the entity identity is `(type, name)` exact match;
 * future work could add fuzzy / alias resolution.
 */
import type { Storage } from "./storage.ts";
import { entityId, type EntityType } from "./entities.ts";

export interface BacklinkHit {
  documentId: string;
  sourcePath: string;
  title: string | null;
  /** Number of chunks in this document mentioning the target entity. */
  mentionCount: number;
  /** First-seen surface form (helps disambiguate aliases like `[[Foo|F]]`). */
  surfaceForm: string;
}

export interface BacklinksOptions {
  /** Entity type. Defaults to `wikilink` — the "what links here" lookup. */
  type?: EntityType;
  /** Limit on rows returned. Default 50. */
  limit?: number;
  /**
   * Tenant source scope (migration 047). When non-empty, results are filtered
   * to documents whose `source_id = ANY(...)`. Omitted/empty -> unscoped.
   */
  sourceIds?: string[];
}

export async function findBacklinks(
  storage: Storage,
  name: string,
  opts: BacklinksOptions = {},
): Promise<BacklinkHit[]> {
  const type = opts.type ?? "wikilink";
  const limit = opts.limit ?? 50;
  if (limit < 1 || limit > 1000) {
    throw new Error(`backlinks: limit must be in [1, 1000] (got ${limit})`);
  }
  const eid = entityId(type, name);

  const params: unknown[] = [eid, limit];
  let scopeFilter = "";
  // Tenant scope (mig047): filter the joined documents (nullable source_id)
  // only when a non-empty list is given.
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    scopeFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }

  const db = storage.raw();
  const result = await db.query<{
    document_id: string;
    source_path: string;
    title: string | null;
    mention_count: number;
    surface_form: string;
  }>(
    `SELECT
       d.id           AS document_id,
       d.source_path  AS source_path,
       d.title        AS title,
       COUNT(*)::int  AS mention_count,
       MIN(em.surface_form) AS surface_form
     FROM entity_mentions em
     JOIN chunks c   ON c.id = em.chunk_id
     JOIN documents d ON d.id = c.document_id
     WHERE em.entity_id = $1${scopeFilter}
     GROUP BY d.id, d.source_path, d.title
     ORDER BY mention_count DESC, d.title NULLS LAST, d.source_path
     LIMIT $2`,
    params,
  );

  return result.rows.map((r) => ({
    documentId: r.document_id,
    sourcePath: r.source_path,
    title: r.title,
    mentionCount: r.mention_count,
    surfaceForm: r.surface_form,
  }));
}
