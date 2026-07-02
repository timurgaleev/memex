/**
 * Page tags — thin CRUD over the `tags` table from migration 023.
 *
 * The table is page-scoped: a `(slug, tag)` pair, with the pair as its
 * PRIMARY KEY. There is no FK to `pages` at the schema level (migration 023
 * declares the table standalone), so this module enforces page existence at
 * the application boundary — an add against an unknown or soft-deleted page
 * throws rather than silently planting an orphan tag.
 *
 * All three ops are deterministic, brain-internal, and Bedrock-free:
 *   addTag     — idempotent insert (ON CONFLICT DO NOTHING).
 *   removeTag  — idempotent delete (a no-op when the tag isn't set).
 *   getTags    — distinct tags for a page, lexical order.
 *
 * Tags are normalized at the boundary (trim + lowercase) so `Idea`, `idea `
 * and `idea` collapse to one stored value — the PK then dedupes for free.
 */
import type { Storage } from "./storage.ts";

/** Upper bound on a single normalized tag (defence vs unbounded writes).
 *  An over-limit tag is REJECTED, not truncated — truncating would collapse
 *  two distinct long tags onto one key. */
const MAX_TAG_LEN = 128;

/**
 * Normalize a tag to its stored form: trim, collapse internal whitespace,
 * lowercase. Returns "" for a non-string or all-whitespace input (the caller
 * rejects empties).
 */
export function normalizeTag(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Resolve a tag to its validated stored form, or throw with a clear message. */
function requireTag(tag: unknown): string {
  const norm = normalizeTag(tag);
  if (!norm) throw new Error("tag must be a non-empty string");
  if (norm.length > MAX_TAG_LEN) {
    throw new Error(`tag exceeds ${MAX_TAG_LEN} chars`);
  }
  return norm;
}

/** True iff a live (non-soft-deleted) page exists at `slug`. */
async function pageExists(storage: Storage, slug: string): Promise<boolean> {
  const r = await storage.engine().query<{ one: number }>(
    `SELECT 1 AS one FROM pages WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
    [slug],
  );
  return r.rows.length > 0;
}

/**
 * Tag a page. Idempotent: re-adding an existing tag is a no-op. Throws when
 * the page does not exist (or is soft-deleted) — the same fail-fast contract
 * the reference implementation uses, so a caller never plants an orphan tag.
 */
export async function addTag(
  storage: Storage,
  slug: string,
  tag: string,
  sourceId?: string,
): Promise<void> {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("addTag: `slug` is required");
  }
  const norm = requireTag(tag);
  // Tenant scope (mig047): stamp source_id only when provided so the NOT NULL
  // column's DEFAULT 'default' applies otherwise (never pass NULL).
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
  // ponytail: check-then-act TOCTOU — a concurrent page_delete between this
  // check and the insert could tag a just-deleted page. The tags table has no
  // FK (migration 023 is standalone), so the DB can't enforce it. Harmless +
  // accepted: soft-delete is reversible, an orphan tag is inert and cleaned on
  // restore, and tag writes are single-operator/internal-only. Add an FK if
  // tags ever go multi-writer.
  if (!(await pageExists(storage, slug))) {
    throw new Error(`addTag failed: page "${slug}" not found`);
  }
  const params: unknown[] = [slug, norm];
  const sourceCol = scope !== null ? ", source_id" : "";
  if (scope !== null) params.push(scope);
  // The conflict target folds in source_id (migration 059) so each tenant owns
  // its own (slug, tag, source_id) row — a per-tenant add never no-ops (or
  // clobbers) another tenant's identical (slug, tag). When source_id is not
  // explicitly inserted the column DEFAULT 'default' fills the arbitration value.
  await storage.engine().query(
    `INSERT INTO tags (slug, tag${sourceCol}) VALUES ($1, $2${scope !== null ? ", $3" : ""})
     ON CONFLICT (slug, tag, source_id) DO NOTHING`,
    params,
  );
}

/**
 * Remove a tag from a page. Idempotent: deleting a tag that isn't set (or a
 * tag on a page that doesn't exist) is a silent no-op — remove asserts an
 * absence, so the post-state is identical either way.
 */
export async function removeTag(
  storage: Storage,
  slug: string,
  tag: string,
  sourceId?: string,
): Promise<void> {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("removeTag: `slug` is required");
  }
  const norm = requireTag(tag);
  // Tenant write scope (mig047): when set, only a tag stamped to this source is
  // removed — a scoped caller can never unset another tenant's tag. Unset →
  // whole-brain by (slug, tag), unchanged.
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
  const params: unknown[] = [slug, norm];
  let sourceFilter = "";
  if (scope !== null) {
    params.push(scope);
    sourceFilter = ` AND source_id = $${params.length}`;
  }
  await storage.engine().query(
    `DELETE FROM tags WHERE slug = $1 AND tag = $2${sourceFilter}`,
    params,
  );
}

/**
 * List the tags for a page, lexically ordered. Returns [] for an unknown page
 * (a read never throws on a missing slug — an absent page simply has no tags).
 */
export async function getTags(
  storage: Storage,
  slug: string,
  sourceIds?: readonly string[],
): Promise<string[]> {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("getTags: `slug` is required");
  }
  // Tenant scope (mig047): a scoped caller sees only tags stamped to its own
  // source(s). No-op when unset — the whole page's tags, as today.
  const params: unknown[] = [slug];
  let sourceFilter = "";
  if (sourceIds && sourceIds.length) {
    params.push(sourceIds);
    sourceFilter = ` AND source_id = ANY($${params.length}::text[])`;
  }
  const r = await storage.engine().query<{ tag: string }>(
    `SELECT tag FROM tags WHERE slug = $1${sourceFilter} ORDER BY tag COLLATE "C" ASC`,
    params,
  );
  return r.rows.map((row) => row.tag);
}
