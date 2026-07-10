/**
 * orphans-purge phase — DB hygiene.
 *
 * Two classes of orphans we delete (always safe):
 *   1. embeddings whose chunk_id no longer matches any chunk
 *      (shouldn't happen due to ON DELETE CASCADE but cheap to verify).
 *   2. entity_mentions whose chunk_id no longer matches any chunk
 *      (same).
 *   3. entities with zero mentions left after step 2.
 *
 * Two classes we REPORT but DO NOT delete (need human eyeballs):
 *   - documents whose source_path no longer exists on disk
 *     (file might have been renamed, not deleted)
 *   - documents with zero chunks (corrupt index — re-run indexer)
 *
 * The dedicated `orphans` command prints these reports
 * interactively with a `--apply` flag for the destructive variants.
 */
import { existsSync } from "node:fs";
import type { Engine } from "../engine/interface.ts";

export interface OrphansPurgeResult {
  deleted: {
    embeddings: number;
    entity_mentions: number;
    entities: number;
  };
  flagged: {
    docs_missing_on_disk: { id: string; sourcePath: string }[];
    docs_with_zero_chunks: { id: string; sourcePath: string }[];
  };
}

export async function orphansPurgePhase(
  engine: Engine,
): Promise<OrphansPurgeResult> {
  // --- Safe deletes ----------------------------------------------------
  const e = await engine.query<{ c: number }>(
    `DELETE FROM embeddings
     WHERE chunk_id NOT IN (SELECT id FROM chunks)
     RETURNING 1`,
  );
  const embeddings = e.rows.length;

  const m = await engine.query<{ c: number }>(
    `DELETE FROM entity_mentions
     WHERE chunk_id NOT IN (SELECT id FROM chunks)
     RETURNING 1`,
  );
  const entity_mentions = m.rows.length;

  const ent = await engine.query<{ c: number }>(
    `DELETE FROM entities
     WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)
     RETURNING 1`,
  );
  const entities = ent.rows.length;

  // --- Read-only flags --------------------------------------------------
  const allDocs = await engine.query<{ id: string; source_path: string }>(
    `SELECT id, source_path FROM documents`,
  );
  const missing: { id: string; sourcePath: string }[] = [];
  // Roots probed once per run: "/vault" → does /vault exist here at all?
  const rootExists = new Map<string, boolean>();
  for (const d of allDocs.rows) {
    // Virtual documents (page:// and page-truth:// mirrors, gmail:/gcal:
    // channel items) live only in the DB — they never have a file on disk, so
    // the disk-existence probe would flag every one of them forever. Only an
    // absolute filesystem path is checkable; virtual lifecycles are owned by
    // the mirror-pages phase / their channel's ingest. Same latent class as
    // the v1.83.0 rechunk-sweep fix.
    if (!d.source_path.startsWith("/")) continue;
    // Remote-ingested docs carry the CLIENT's path namespace (e.g. /vault/…
    // from the operator's laptop) — a root that does not exist on this host
    // says nothing about any individual doc, so skip the whole namespace.
    // Only a file missing under a root that IS present here is a real signal.
    // A depth-1 path (/x.md) has no namespace root; it is probed directly.
    const parts = d.source_path.split("/");
    if (parts.length > 2) {
      const root = "/" + parts[1]!;
      let ok = rootExists.get(root);
      if (ok === undefined) {
        ok = existsSync(root);
        rootExists.set(root, ok);
      }
      if (!ok) continue;
    }
    if (!existsSync(d.source_path)) {
      missing.push({ id: d.id, sourcePath: d.source_path });
    }
  }

  const noChunks = await engine.query<{ id: string; source_path: string }>(
    `SELECT d.id, d.source_path
     FROM documents d
     LEFT JOIN chunks c ON c.document_id = d.id
     WHERE c.id IS NULL
     ORDER BY d.source_path`,
  );

  return {
    deleted: { embeddings, entity_mentions, entities },
    flagged: {
      docs_missing_on_disk: missing,
      docs_with_zero_chunks: noChunks.rows.map((r) => ({
        id: r.id,
        sourcePath: r.source_path,
      })),
    },
  };
}
