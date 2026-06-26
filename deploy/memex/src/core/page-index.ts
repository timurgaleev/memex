/**
 * Page → search bridge.
 *
 * The DB-canonical `pages` store (migration 015) holds the authored body,
 * but search reads `documents`/`chunks`/`embeddings`. Without a bridge a
 * page written via `page_put` is invisible to search. This module mirrors a
 * page's body into the search store by routing it through the same
 * `indexDocument` pipeline the file sweep uses — chunk + embed + write,
 * idempotent per source_path.
 *
 * The mirror document is keyed by a reserved `page://<slug>` source_path so
 * it never collides with file-derived documents (which use real filesystem
 * paths) and so a page delete can find and drop its mirror.
 */
import {
  indexDocument,
  removeDocument,
  type IndexFileOptions,
  type IndexResult,
} from "./indexer.ts";
import type { Storage } from "./storage.ts";

/** Reserved source_path namespace for page-derived search documents. */
export function pageSourcePath(slug: string): string {
  return `page://${slug}`;
}

/** True for a source_path produced by {@link pageSourcePath}. */
export function isPageSourcePath(sourcePath: string): boolean {
  return sourcePath.startsWith("page://");
}

/**
 * Compose the text indexed for a page: the title as an H1 (so the page title
 * is searchable and feeds the title-phrase boost) followed by the body. The
 * H1 is only prepended when the body doesn't already open with one.
 */
function pageText(title: string | null, body: string): string {
  const b = body ?? "";
  if (title && !/^\s*#\s/.test(b)) {
    return `# ${title}\n\n${b}`;
  }
  return b;
}

export interface PageIndexInput {
  slug: string;
  title: string | null;
  markdown_body: string;
  /**
   * Page content hash — stamped onto the mirror document's frontmatter as
   * `page_content_hash` so {@link reconcilePageMirrors} can detect a stale
   * mirror (page changed but a write-time embed failed).
   */
  content_hash?: string;
  /**
   * Owning source (tenant) of the page. Propagated to the mirror document so
   * the page's content is search-isolated to its tenant. Defaults to 'default'.
   */
  source_id?: string;
}

/**
 * Mirror a page into the search store. A page with an empty/whitespace title
 * AND body has nothing to index — its mirror is removed instead of writing an
 * empty husk. (A title-only page IS indexed: the title is searchable.)
 * Returns the index result, or `null` when the page was removed.
 */
export async function indexPageIntoSearch(
  storage: Storage,
  page: PageIndexInput,
  opts: IndexFileOptions = {},
): Promise<IndexResult | null> {
  const text = pageText(page.title, page.markdown_body);
  if (text.trim().length === 0) {
    await removePageFromSearch(storage, page.slug);
    return null;
  }
  const indexOpts: IndexFileOptions = { ...opts };
  return indexDocument(
    storage,
    {
      sourcePath: pageSourcePath(page.slug),
      text,
      sourceId: page.source_id ?? null,
      // Stamp the body hash AND the title: `pages.content_hash` is body-only,
      // so a title-only edit leaves it unchanged. Stamping the title too lets
      // the backstop detect a stale mirror after a title-only edit whose
      // write-time embed failed.
      ...(page.content_hash
        ? {
            extraFrontmatter: {
              page_content_hash: page.content_hash,
              page_title: page.title ?? "",
            },
          }
        : {}),
    },
    indexOpts,
  );
}

export interface ReconcilePageMirrorsResult {
  /** Pages examined whose mirror was missing or stale. */
  scanned: number;
  /** Pages (re)mirrored into the search store. */
  mirrored: number;
  /** Orphan mirrors (page deleted/gone) dropped from the search store. */
  removed: number;
  /** Per-slug failures (e.g. transient embed errors) — retried next run. */
  errors: string[];
}

/**
 * Cycle backstop for the page → search bridge. Two self-healing passes:
 *
 *  1. Re-mirror pages whose `page://<slug>` document is MISSING (a write-time
 *     embed failed) or STALE (`page_content_hash` ≠ the page's content_hash).
 *  2. Drop orphan mirrors whose page was soft-deleted or no longer exists.
 *
 * Bounded per run so a large backlog drains over several cycles rather than
 * hammering Bedrock in one burst. Per-page failures are collected, not thrown,
 * so one bad page can't abort the pass.
 */
export async function reconcilePageMirrors(
  storage: Storage,
  opts: { maxPerRun?: number; embedFn?: IndexFileOptions["embedFn"] } = {},
): Promise<ReconcilePageMirrorsResult> {
  const limit = opts.maxPerRun ?? 200;
  const indexOpts: IndexFileOptions = {};
  if (opts.embedFn) indexOpts.embedFn = opts.embedFn;
  const engine = storage.engine();
  const result: ReconcilePageMirrorsResult = {
    scanned: 0,
    mirrored: 0,
    removed: 0,
    errors: [],
  };

  // Pass 1 — missing or stale mirrors.
  const stale = await engine.query<{
    slug: string;
    title: string | null;
    markdown_body: string;
    content_hash: string;
    source_id: string;
  }>(
    `SELECT p.slug, p.title, p.markdown_body, p.content_hash, p.source_id
       FROM pages p
       LEFT JOIN documents d ON d.source_path = 'page://' || p.slug
      WHERE p.deleted_at IS NULL
        AND (d.id IS NULL
             OR d.source_id <> p.source_id
             OR COALESCE(d.frontmatter->>'page_content_hash', '') <> p.content_hash
             OR COALESCE(d.frontmatter->>'page_title', '') <> COALESCE(p.title, ''))
      ORDER BY p.updated_at DESC
      LIMIT $1`,
    [limit],
  );
  for (const p of stale.rows) {
    result.scanned++;
    try {
      const r = await indexPageIntoSearch(
        storage,
        {
          slug: p.slug,
          title: p.title,
          markdown_body: p.markdown_body,
          content_hash: p.content_hash,
          source_id: p.source_id,
        },
        indexOpts,
      );
      if (r === null) result.removed++;
      else result.mirrored++;
    } catch (e) {
      result.errors.push(
        `${p.slug}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Pass 2 — orphan mirrors (page soft-deleted or gone).
  const orphans = await engine.query<{ source_path: string }>(
    `SELECT d.source_path
       FROM documents d
       LEFT JOIN pages p
         ON p.slug = substring(d.source_path FROM 8) AND p.deleted_at IS NULL
      WHERE d.source_path LIKE 'page://%' AND p.slug IS NULL
      LIMIT $1`,
    [limit],
  );
  for (const o of orphans.rows) {
    try {
      const r = await removeDocument(storage, o.source_path);
      if (r.removed) result.removed++;
    } catch (e) {
      result.errors.push(
        `${o.source_path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}

/** Drop a page's mirror document (idempotent). */
export async function removePageFromSearch(
  storage: Storage,
  slug: string,
): Promise<{ removed: boolean }> {
  return removeDocument(storage, pageSourcePath(slug));
}
