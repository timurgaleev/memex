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
  type: string;
  title?: string;
  compiled_truth?: Record<string, unknown>;
  markdown_body?: string;
  /** Caller identifier for the audit trail. */
  written_by?: string;
  /** Allow a type that isn't in KNOWN_PAGE_TYPES. Default false. */
  allowAdHocType?: boolean;
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
  const type = normaliseType(input.type, input.allowAdHocType);
  const body = input.markdown_body ?? "";
  const truth = input.compiled_truth ?? {};
  const title = input.title ?? null;
  const writtenBy = input.written_by ?? null;
  const hashNew = hashBody(body);
  const truthJson = JSON.stringify(truth);

  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    const existing = await tx.query<{
      content_hash: string;
      type: string;
      title: string | null;
      compiled_truth: unknown;
      version_n: number;
    }>(
      `SELECT p.content_hash, p.type, p.title, p.compiled_truth,
              COALESCE(MAX(v.version_n), 0) AS version_n
       FROM pages p
       LEFT JOIN page_versions v ON v.slug = p.slug
       WHERE p.slug = $1 AND p.deleted_at IS NULL
       GROUP BY p.content_hash, p.type, p.title, p.compiled_truth`,
      [input.slug],
    );

    if (existing.rows.length === 0) {
      // Brand new page.
      await tx.query(
        `INSERT INTO pages (slug, type, title, compiled_truth,
                            markdown_body, content_hash)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [input.slug, type, title, truthJson, body, hashNew],
      );
      await tx.query(
        `INSERT INTO page_versions
           (slug, version_n, hash_prev, hash_new,
            body_snapshot, compiled_truth_snapshot, written_by)
         VALUES ($1, 1, NULL, $2, $3, $4::jsonb, $5)`,
        [input.slug, hashNew, body, truthJson, writtenBy],
      );
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
          body_snapshot, compiled_truth_snapshot, written_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        input.slug,
        nextVersion,
        prev.content_hash,
        hashNew,
        body,
        truthJson,
        writtenBy,
      ],
    );
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
}

export async function appendPage(
  storage: Storage,
  input: AppendInput,
): Promise<PutResult> {
  validateSlug(input.slug);
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("appendPage: content is required");
  }
  const current = await getPage(storage, input.slug);
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
    allowAdHocType: true, // existing type, definitionally allowed
  });
}

export async function getPage(
  storage: Storage,
  slug: string,
): Promise<PageRow | null> {
  validateSlug(slug);
  const r = await storage.engine().query<PageRow>(
    `SELECT slug, type, title, compiled_truth,
            markdown_body, content_hash,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            deleted_at::text AS deleted_at
       FROM pages
       WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
  return r.rows[0] ?? null;
}

export interface ListPagesOptions {
  type?: string;
  since?: string;
  limit?: number;
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
  params.push(limit);
  const sql = `
    SELECT slug, type, title, compiled_truth,
           markdown_body, content_hash,
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
    return { slug, already_deleted: false };
  });
}
