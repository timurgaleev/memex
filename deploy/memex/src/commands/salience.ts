/**
 * `memex salience [--type <page-type>] [--days N] [--limit N]`
 *
 * The "what matters" surface: live pages ranked by the deterministic
 * `salience` score (migration 036, recomputed by the `recompute-salience`
 * cycle phase) — high-emotion tags + graph connectivity. Read-only.
 *
 *   memex salience                     # top 20 pages by salience, all-time
 *   memex salience --days 14           # only pages touched in the last 14 days
 *   memex salience --type person       # filter to one page type
 *   memex salience --limit 50          # widen the result set
 *
 * Output is JSON ({ ok, pages: [...] }) to match the other read-only commands
 * (`status`, `backlinks`). Salience ranks PAGES (graph entities); it is
 * separate from document hybrid-search ranking.
 *
 * Freshness: the query reads live `pages` rows, but the `salience` column
 * itself is recomputed by the `recompute-salience` cycle phase — so a score
 * reflects link/tag state as of the LAST cycle, not edits made since. Run a
 * cycle to refresh.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";

export interface SalienceCmdOptions {
  /** Filter to a single page `type` (exact match). */
  type?: string;
  /** Only pages whose `updated_at` is within the last N days. 0/undefined = all-time. */
  days?: number;
  /** Max rows. Default 20, clamped to [1, 200]. */
  limit?: number;
}

interface SalienceRow {
  slug: string;
  type: string;
  title: string | null;
  salience: number | string;
  updated_at: string;
}

export async function runSalience(opts: SalienceCmdOptions = {}): Promise<void> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const engine = storage.raw();
    const where: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (opts.type !== undefined && opts.type.length > 0) {
      params.push(opts.type);
      where.push(`type = $${params.length}`);
    }
    if (opts.days !== undefined && opts.days > 0) {
      params.push(opts.days);
      where.push(`updated_at >= NOW() - ($${params.length} || ' days')::interval`);
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    const rows = await engine.query<SalienceRow>(
      `SELECT slug, type, title, salience, updated_at::text AS updated_at
       FROM pages
       WHERE ${where.join(" AND ")}
       ORDER BY salience DESC, updated_at DESC
       LIMIT ${limitParam}`,
      params,
    );

    const pages = rows.rows.map((r) => ({
      slug: r.slug,
      type: r.type,
      title: r.title,
      salience: Number(r.salience) || 0,
      updated_at: r.updated_at,
    }));
    console.log(JSON.stringify({ ok: true, count: pages.length, pages }, null, 2));
  } finally {
    await storage.close();
  }
}
