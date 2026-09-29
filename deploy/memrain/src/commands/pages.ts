/**
 * `memex pages` — full catalog of known wikilink targets.
 *
 * For every entity of type='wikilink' returns name + total mention count.
 * Helps answer "what does this vault think exists" — useful for
 * onboarding and as a sanity check after big imports.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";

export interface PagesOptions {
  /** Cap rows returned. Default 500. */
  limit?: number;
  /** Only return entries whose name matches LIKE pattern (case-insensitive). */
  filter?: string;
}

export async function runPages(opts: PagesOptions = {}): Promise<void> {
  const limit = opts.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error(`memex pages: invalid --limit ${limit}`);
  }
  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const where = opts.filter
      ? "WHERE e.type = 'wikilink' AND e.name ILIKE $2"
      : "WHERE e.type = 'wikilink'";
    const params: unknown[] = [limit];
    if (opts.filter) params.push(`%${opts.filter}%`);
    const r = await storage.engine().query<{
      name: string;
      mention_count: number;
      doc_count: number;
    }>(
      `SELECT e.name,
              COUNT(em.chunk_id)::int AS mention_count,
              COUNT(DISTINCT c.document_id)::int AS doc_count
       FROM entities e
       LEFT JOIN entity_mentions em ON em.entity_id = e.id
       LEFT JOIN chunks c           ON c.id = em.chunk_id
       ${where}
       GROUP BY e.name
       ORDER BY mention_count DESC, e.name
       LIMIT $1`,
      params,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          total: r.rows.length,
          pages: r.rows.map((row) => ({
            name: row.name,
            mentionCount: row.mention_count,
            documentCount: row.doc_count,
          })),
        },
        null,
        2,
      ),
    );
  });
}
