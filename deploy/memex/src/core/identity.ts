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

export async function brainIdentity(storage: Storage): Promise<BrainIdentity> {
  const engine = storage.engine();
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
