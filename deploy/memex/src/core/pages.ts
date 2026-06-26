/**
 * Pages — DB-canonical CRUD over the page store added in migration 015.
 *
 * Every write goes through this module: it computes the content hash,
 * decides whether the write is a no-op (idempotent re-put with identical
 * content) or a real edit, and appends a row to `page_versions`. Higher
 * layers (HTTP route, MCP dispatch) never touch the SQL directly.
 *
 * Indexing of the resulting page into the legacy `documents` / `chunks`
 * / `embeddings` store is a separate concern owned by a later wiring
 * commit — `putPage` returns enough information for a caller to drive
 * that step (slug + content_hash + chunkable body) without pulling
 * Bedrock into this module.
 */
import { createHash } from "node:crypto";
import type { Storage } from "./storage.ts";
import { bumpPageGeneration } from "./generation.ts";
import { wellFormJsonbValue } from "./well-form.ts";
import { extractAliasNorms, setPageAliases } from "./page-aliases.ts";
import { OperationError } from "./operation-error.ts";

// Catalogue of well-known page types. Not enforced at the DB level (see
// migration 015 comment); kept here so application code can normalise +
// validate at the boundary. New types may be passed through if the
// caller opts in to `allowAdHocType: true`.
export const KNOWN_PAGE_TYPES = [
  "concept",
  "person",
  "company",
  "meeting",
  "idea",
  "journal",
  "note",
  "email",
  "event",
  "decision",
  "task",
  "source",
] as const;

export type KnownPageType = (typeof KNOWN_PAGE_TYPES)[number];

/**
 * Slug first-segment → page type. A page at `people/alice` is a `person`
 * without the caller spelling it out — the vault's folder convention already
 * encodes the type. Used to INFER `type` when a put omits it (an explicit
 * type always wins). Plural and singular prefixes both map.
 */
const SLUG_PREFIX_TYPE: Record<string, KnownPageType> = {
  people: "person", person: "person", persons: "person",
  companies: "company", company: "company", orgs: "company", org: "company",
  meetings: "meeting", meeting: "meeting",
  ideas: "idea", idea: "idea",
  journal: "journal", journals: "journal",
  notes: "note", note: "note",
  emails: "email", email: "email",
  events: "event", event: "event",
  decisions: "decision", decision: "decision",
  tasks: "task", task: "task",
  concepts: "concept", concept: "concept",
  sources: "source", source: "source",
};

/** Infer a page type from a slug's first path segment, or null if unknown. */
export function inferPageType(slug: string): KnownPageType | null {
  if (typeof slug !== "string") return null;
  const seg = slug.split("/")[0]?.toLowerCase() ?? "";
  return SLUG_PREFIX_TYPE[seg] ?? null;
}

// Slug grammar:
//   - lowercase a-z, digits 0-9, hyphen
//   - optional `/` namespaces (each segment must satisfy the same rule)
//   - 1..256 chars total
const SLUG_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
const MAX_SLUG_LEN = 256;

export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("page slug must be a non-empty string");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new Error(`page slug exceeds ${MAX_SLUG_LEN} chars`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `page slug must match kebab-case with optional / namespaces (got ${JSON.stringify(
        slug,
      )})`,
    );
  }
}

export interface PageInput {
  slug: string;
  /** Page type. OPTIONAL: when omitted it is inferred from the slug's first
   *  segment (`people/…` → person), falling back to `note`. An explicit type
   *  always wins. */
  type?: string;
  title?: string;
  compiled_truth?: Record<string, unknown>;
  markdown_body?: string;
  /** Caller identifier for the audit trail. */
  written_by?: string;
  /** Allow a type that isn't in KNOWN_PAGE_TYPES. Default false. */
  allowAdHocType?: boolean;
  /**
   * Owning source (tenant). Defaults to 'default'. A write to a slug already
   * owned by a different source is refused (no cross-tenant overwrite).
   */
  source_id?: string;
}

export interface PageRow {
  slug: string;
  type: string;
  title: string | null;
  compiled_truth: Record<string, unknown>;
  markdown_body: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Owning source (tenant). Carried so the search mirror propagates it. */
  source_id: string;
}

export interface PutResult {
  slug: string;
  /** New version number assigned to this write (>=1). */
  version_n: number;
  /** SHA-256 of the body after the write. */
  content_hash: string;
  /** True when the body actually changed compared to the prior version. */
  changed: boolean;
  /** True when the row didn't exist before. */
  created: boolean;
}

export interface PageVersionRow {
  slug: string;
  version_n: number;
  hash_prev: string | null;
  hash_new: string;
  body_snapshot: string;
  compiled_truth_snapshot: Record<string, unknown>;
  written_by: string | null;
  written_at: string;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function normaliseType(
  type: string | undefined,
  allowAdHoc: boolean | undefined,
): string {
  if (!type || typeof type !== "string") {
    throw new Error("page type is required");
  }
  const t = type.trim().toLowerCase();
  if (!t) throw new Error("page type cannot be blank");
  if (!allowAdHoc && !KNOWN_PAGE_TYPES.includes(t as KnownPageType)) {
    throw new Error(
      `page type ${JSON.stringify(t)} not in KNOWN_PAGE_TYPES; ` +
        `pass allowAdHocType: true to accept it`,
    );
  }
  return t;
}

/**
 * Idempotent upsert. Two paths:
 *   1. row exists, body+truth+title+type identical → no-op, returns
 *      `changed: false`, no new version row.
 *   2. row exists with different content OR row missing → upsert pages,
 *      append `page_versions` with version_n = max(existing) + 1.
 *
 * The whole thing runs in one transaction so a Bedrock failure later in
 * a caller's pipeline cannot leave a page row without its matching
 * version row.
 */
export async function putPage(
  storage: Storage,
  input: PageInput,
): Promise<PutResult> {
  validateSlug(input.slug);
  // An explicit (non-blank) type always wins; a blank/omitted type is resolved
  // INSIDE the transaction (below), where the existing row is known — so an
  // omitted-type re-put PRESERVES the page's current type rather than
  // re-inferring it. Inference (slug prefix → type, default `note`) applies
  // only when creating a page with no explicit type.
  const explicitType =
    typeof input.type === "string" && input.type.trim() !== ""
      ? normaliseType(input.type, input.allowAdHocType)
      : null;
  const body = input.markdown_body ?? "";
  const truth = input.compiled_truth ?? {};
  const title = input.title ?? null;
  const writtenBy = input.written_by ?? null;
  const sourceId = input.source_id ?? "default";
  const hashNew = hashBody(body);
  // Sanitize lone UTF-16 surrogates + NUL ONCE, then derive both the jsonb
  // payload and the alias norms from the sanitized value — otherwise a NUL /
  // lone surrogate inside `aliases` would reach the page_aliases TEXT insert
  // (which Postgres rejects) and abort the whole page write (see well-form.ts).
  const safeTruth = wellFormJsonbValue(truth) as Record<string, unknown>;
  const aliasNorms = extractAliasNorms(safeTruth);
  const truthJson = JSON.stringify(safeTruth);

  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    const existing = await tx.query<{
      content_hash: string;
      type: string;
      title: string | null;
      compiled_truth: unknown;
      source_id: string;
      version_n: number;
    }>(
      `SELECT p.content_hash, p.type, p.title, p.compiled_truth, p.source_id,
              COALESCE(MAX(v.version_n), 0) AS version_n
       FROM pages p
       LEFT JOIN page_versions v ON v.slug = p.slug
       WHERE p.slug = $1 AND p.deleted_at IS NULL
       GROUP BY p.content_hash, p.type, p.title, p.compiled_truth, p.source_id`,
      [input.slug],
    );

    // No cross-tenant overwrite: a slug owned by another source is off-limits.
    const owner = existing.rows[0]?.source_id;
    if (owner !== undefined && owner !== sourceId) {
      throw new OperationError(
        "permission_denied",
        `page '${input.slug}' is owned by another source`,
        "Use a slug within your own source, or request access.",
      );
    }

    // Resolve the type now that the existing row is known: explicit wins;
    // else preserve the existing page's type (an omitted-type update must NOT
    // re-type the page); else (new page) infer from the slug, default `note`.
    const prevType = existing.rows[0]?.type;
    const type =
      explicitType ??
      prevType ??
      normaliseType(inferPageType(input.slug) ?? "note", input.allowAdHocType);

    if (existing.rows.length === 0) {
      // Brand new page.
      await tx.query(
        `INSERT INTO pages (slug, type, title, compiled_truth,
                            markdown_body, content_hash, source_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [input.slug, type, title, truthJson, body, hashNew, sourceId],
      );
      await tx.query(
        `INSERT INTO page_versions
           (slug, version_n, hash_prev, hash_new,
            body_snapshot, compiled_truth_snapshot, written_by, source_id)
         VALUES ($1, 1, NULL, $2, $3, $4::jsonb, $5, $6)`,
        [input.slug, hashNew, body, truthJson, writtenBy, sourceId],
      );
      await bumpPageGeneration(tx, input.slug);
      await setPageAliases(tx, input.slug, aliasNorms);
      return {
        slug: input.slug,
        version_n: 1,
        content_hash: hashNew,
        changed: true,
        created: true,
      };
    }

    const prev = existing.rows[0]!;
    const truthEq =
      typeof prev.compiled_truth === "object" &&
      prev.compiled_truth !== null &&
      JSON.stringify(prev.compiled_truth) === truthJson;
    const idempotent =
      prev.content_hash === hashNew &&
      prev.type === type &&
      prev.title === title &&
      truthEq;

    if (idempotent) {
      return {
        slug: input.slug,
        version_n: prev.version_n,
        content_hash: hashNew,
        changed: false,
        created: false,
      };
    }

    const nextVersion = prev.version_n + 1;
    await tx.query(
      `UPDATE pages
         SET type = $2,
             title = $3,
             compiled_truth = $4::jsonb,
             markdown_body = $5,
             content_hash = $6,
             updated_at = NOW()
       WHERE slug = $1`,
      [input.slug, type, title, truthJson, body, hashNew],
    );
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, source_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        input.slug,
        nextVersion,
        prev.content_hash,
        hashNew,
        body,
        truthJson,
        writtenBy,
        sourceId,
      ],
    );
    await bumpPageGeneration(tx, input.slug);
    await setPageAliases(tx, input.slug, aliasNorms);
    return {
      slug: input.slug,
      version_n: nextVersion,
      content_hash: hashNew,
      changed: true,
      created: false,
    };
  });
}

export interface AppendInput {
  slug: string;
  /** Text to append. A leading newline is added between existing body and the
   *  new chunk only when needed (so callers don't have to worry about it). */
  content: string;
  written_by?: string;
  /**
   * Owning source (tenant). When set, the target page is resolved within this
   * source only — a caller cannot append to a page they do not own (it reads
   * as "does not exist").
   */
  source_id?: string;
}

export async function appendPage(
  storage: Storage,
  input: AppendInput,
): Promise<PutResult> {
  validateSlug(input.slug);
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("appendPage: content is required");
  }
  const scope = input.source_id ? [input.source_id] : undefined;
  const current = await getPage(storage, input.slug, scope);
  if (!current) {
    throw new Error(
      `appendPage: page ${JSON.stringify(input.slug)} does not exist; ` +
        `call putPage to create it first`,
    );
  }
  const sep =
    current.markdown_body.length > 0 &&
    !current.markdown_body.endsWith("\n")
      ? "\n"
      : "";
  const newBody = `${current.markdown_body}${sep}${input.content}`;
  return putPage(storage, {
    slug: input.slug,
    type: current.type,
    title: current.title ?? undefined,
    compiled_truth: current.compiled_truth,
    markdown_body: newBody,
    written_by: input.written_by,
    source_id: current.source_id,
    allowAdHocType: true, // existing type, definitionally allowed
  });
}

export async function getPage(
  storage: Storage,
  slug: string,
  sourceIds?: readonly string[],
): Promise<PageRow | null> {
  validateSlug(slug);
  const params: unknown[] = [slug];
  let scope = "";
  if (sourceIds && sourceIds.length > 0) {
    params.push([...sourceIds]);
    scope = ` AND source_id = ANY($${params.length}::text[])`;
  }
  const r = await storage.engine().query<PageRow>(
    `SELECT slug, type, title, compiled_truth,
            markdown_body, content_hash, source_id,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            deleted_at::text AS deleted_at
       FROM pages
       WHERE slug = $1 AND deleted_at IS NULL${scope}`,
    params,
  );
  return r.rows[0] ?? null;
}

export interface ListPagesOptions {
  type?: string;
  since?: string;
  limit?: number;
  /** Restrict to these owning sources. Omit/empty → unscoped (whole brain). */
  sourceIds?: readonly string[];
}

export async function listPages(
  storage: Storage,
  opts: ListPagesOptions = {},
): Promise<PageRow[]> {
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 50;
  const params: unknown[] = [];
  const where: string[] = ["deleted_at IS NULL"];
  if (opts.type) {
    params.push(opts.type.toLowerCase());
    where.push(`type = $${params.length}`);
  }
  if (opts.since) {
    params.push(opts.since);
    where.push(`updated_at >= $${params.length}::timestamptz`);
  }
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push([...opts.sourceIds]);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const sql = `
    SELECT slug, type, title, compiled_truth,
           markdown_body, content_hash, source_id,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           deleted_at::text AS deleted_at
      FROM pages
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${params.length}`;
  const r = await storage.engine().query<PageRow>(sql, params);
  return r.rows;
}

export async function pageVersions(
  storage: Storage,
  slug: string,
  limit = 20,
): Promise<PageVersionRow[]> {
  validateSlug(slug);
  const cap =
    typeof limit === "number" && limit >= 1 && limit <= 200
      ? Math.floor(limit)
      : 20;
  const r = await storage.engine().query<PageVersionRow>(
    `SELECT slug, version_n, hash_prev, hash_new,
            body_snapshot, compiled_truth_snapshot,
            written_by, written_at::text AS written_at
       FROM page_versions
       WHERE slug = $1
       ORDER BY version_n DESC
       LIMIT $2`,
    [slug, cap],
  );
  return r.rows;
}

export interface DeleteResult {
  slug: string;
  /** True if the row was already soft-deleted (or absent) — call is idempotent. */
  already_deleted: boolean;
}

/**
 * Soft delete. The row remains in `pages` with `deleted_at` set so the
 * audit chain in `page_versions` stays intact. Hard delete (DROP-cascade)
 * is intentionally not exposed via MCP — a future GC job will sweep
 * pages whose `deleted_at` is older than retention.
 */
export async function deletePage(
  storage: Storage,
  slug: string,
  writtenBy?: string,
): Promise<DeleteResult> {
  validateSlug(slug);
  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    const r = await tx.query<{ content_hash: string; deleted_at: string | null }>(
      `SELECT content_hash, deleted_at::text AS deleted_at
         FROM pages WHERE slug = $1`,
      [slug],
    );
    if (r.rows.length === 0 || r.rows[0]!.deleted_at !== null) {
      return { slug, already_deleted: true };
    }
    const ts = new Date().toISOString();
    await tx.query(
      `UPDATE pages SET deleted_at = NOW(), updated_at = NOW()
        WHERE slug = $1`,
      [slug],
    );
    // Append a tombstone version so the history shows the deletion event.
    const nextN = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(version_n), 0)::int + 1 AS n
         FROM page_versions WHERE slug = $1`,
      [slug],
    );
    const tombstone = JSON.stringify({ deleted_at: ts });
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, written_at)
       VALUES ($1, $2, $3, $3, '', $4::jsonb, $5, NOW())`,
      [
        slug,
        nextN.rows[0]!.n,
        r.rows[0]!.content_hash,
        tombstone,
        writtenBy ?? null,
      ],
    );
    await bumpPageGeneration(tx, slug);
    return { slug, already_deleted: false };
  });
}

export interface RestoreResult {
  slug: string;
  /** True when a soft-deleted page was undeleted; false if missing or live. */
  restored: boolean;
}

/**
 * Undelete a soft-deleted page (clear `deleted_at`). The page row + its full
 * version history are kept on delete specifically so this is possible; without
 * it an accidental `page_delete` is unrecoverable. Records a restore event in
 * the version chain. No-op (restored:false) when the page is missing or live.
 */
export async function restorePage(
  storage: Storage,
  slug: string,
  writtenBy?: string,
): Promise<RestoreResult> {
  validateSlug(slug);
  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    const r = await tx.query<{ content_hash: string; deleted_at: string | null }>(
      `SELECT content_hash, deleted_at::text AS deleted_at
         FROM pages WHERE slug = $1`,
      [slug],
    );
    if (r.rows.length === 0 || r.rows[0]!.deleted_at === null) {
      return { slug, restored: false };
    }
    await tx.query(
      `UPDATE pages SET deleted_at = NULL, updated_at = NOW() WHERE slug = $1`,
      [slug],
    );
    const nextN = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(version_n), 0)::int + 1 AS n
         FROM page_versions WHERE slug = $1`,
      [slug],
    );
    const marker = JSON.stringify({ restored_at: new Date().toISOString() });
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, written_at)
       VALUES ($1, $2, $3, $3, '', $4::jsonb, $5, NOW())`,
      [slug, nextN.rows[0]!.n, r.rows[0]!.content_hash, marker, writtenBy ?? null],
    );
    await bumpPageGeneration(tx, slug);
    return { slug, restored: true };
  });
}

export interface RevertResult {
  slug: string;
  /** True when the body was rolled back (false = page missing/deleted, version
   *  not found, target is an event marker, or content already identical). */
  reverted: boolean;
  /** The target version reverted TO (null when not found). */
  from_version: number | null;
  /** The NEW version number created by the revert (null when no change). */
  new_version: number | null;
  reason?: string;
}

/**
 * Roll a page's body back to a prior `page_versions` snapshot. memex keeps a
 * full body snapshot per version but offered no rollback until now. Reverting
 * creates a NEW version with the old content (history is append-only, never
 * rewritten); reuses `putPage` so type/title are preserved and the change flows
 * through the normal write path (generation bump, links, facts).
 */
export async function revertPage(
  storage: Storage,
  slug: string,
  targetVersion: number,
  writtenBy?: string,
): Promise<RevertResult> {
  validateSlug(slug);
  const page = await getPage(storage, slug);
  if (!page) {
    return { slug, reverted: false, from_version: null, new_version: null, reason: "page not found or deleted" };
  }
  const snap = await storage.engine().query<{
    body_snapshot: string;
    compiled_truth_snapshot: Record<string, unknown>;
  }>(
    `SELECT body_snapshot, compiled_truth_snapshot
       FROM page_versions WHERE slug = $1 AND version_n = $2`,
    [slug, targetVersion],
  );
  const row = snap.rows[0];
  if (!row) {
    return { slug, reverted: false, from_version: null, new_version: null, reason: `version ${targetVersion} not found` };
  }
  // An event marker (delete/restore) carries no real body — refuse to revert to
  // it (it would blank the page); use page_restore for deletion events.
  const truth = row.compiled_truth_snapshot ?? {};
  if (
    Object.hasOwn(truth, "deleted_at") ||
    Object.hasOwn(truth, "restored_at")
  ) {
    return { slug, reverted: false, from_version: targetVersion, new_version: null, reason: "target is a delete/restore event, not a content version" };
  }
  // Preserve the CURRENT title + type: page_versions has no title column, and
  // putPage does NOT preserve an omitted title (it nulls it). Passing the live
  // title keeps revert body-only — and keeps revert-to-identical idempotent
  // (omitting it would null the title, forcing a spurious version).
  const put = await putPage(storage, {
    slug,
    markdown_body: row.body_snapshot,
    compiled_truth: truth,
    ...(page.title != null ? { title: page.title } : {}),
    ...(writtenBy ? { written_by: writtenBy } : {}),
  });
  return {
    slug,
    reverted: put.changed,
    from_version: targetVersion,
    new_version: put.changed ? put.version_n : null,
  };
}
