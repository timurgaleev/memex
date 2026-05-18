/**
 * Page CRUD HTTP surface — DB-canonical page store.
 *
 * Routes (mounted in http/server.ts):
 *   POST /pages/put       { slug, type, title?, compiled_truth?, markdown_body?, written_by? }
 *   POST /pages/append    { slug, content, written_by? }
 *   POST /pages/delete    { slug, written_by? }
 *   GET  /pages/get?slug=...
 *   POST /pages/list      { type?, since?, limit? }
 *   GET  /pages/versions?slug=...&limit=...
 *
 * Auth model:
 *   - Public ingress: redact `markdown_body` from list/get responses
 *     by default (mirrors the /search redaction). Bodies opt back in
 *     via `MEMEX_PUBLIC_READ_BODIES=1`.
 *   - Public ingress: all WRITE routes are 403 — pages are an internal
 *     surface only. The MCP write tools are also in
 *     FORBIDDEN_MCP_TOOLS_FROM_PUBLIC.
 *   - Internal ingress: write routes additionally require
 *     `MEMEX_INTERNAL_TOKEN` via `evaluateInternalAuth` (caller is
 *     server.ts; this module just renders the request body).
 */
import type { Storage } from "../core/storage.ts";
import { parseJsonBody } from "./body_limit.ts";
import { PUBLIC_GUARD_INTERNALS } from "./public_guard.ts";
import {
  appendPage,
  deletePage,
  getPage,
  listPages,
  pageVersions,
  putPage,
  type PageInput,
  type AppendInput,
  type ListPagesOptions,
} from "../core/pages.ts";
import { syncWikilinksForPage } from "../core/links.ts";

const PUBLIC_SAFE_PAGE_FIELDS = new Set([
  "slug",
  "type",
  "title",
  "compiled_truth",
  "content_hash",
  "created_at",
  "updated_at",
]);

function redactBody<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (PUBLIC_SAFE_PAGE_FIELDS.has(k)) out[k] = row[k];
  }
  return out as T;
}

function shouldRedactForPublic(isPublic: boolean): boolean {
  return isPublic && !PUBLIC_GUARD_INTERNALS.publicReadBodiesAllowed();
}

function errResponse(isPublic: boolean, e: unknown, status: number): Response {
  const msg = isPublic
    ? "pages backend error"
    : e instanceof Error
      ? e.message
      : String(e);
  return Response.json({ ok: false, error: msg }, { status });
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

function isPageInput(b: unknown): b is PageInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    typeof o["type"] === "string" &&
    (o["title"] === undefined || typeof o["title"] === "string") &&
    (o["compiled_truth"] === undefined ||
      (typeof o["compiled_truth"] === "object" && o["compiled_truth"] !== null)) &&
    (o["markdown_body"] === undefined || typeof o["markdown_body"] === "string") &&
    (o["written_by"] === undefined || typeof o["written_by"] === "string") &&
    (o["allowAdHocType"] === undefined ||
      typeof o["allowAdHocType"] === "boolean")
  );
}

export async function handlePagePut(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<PageInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isPageInput(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, type, ... }" },
      { status: 400 },
    );
  }
  try {
    const result = await putPage(storage, parsed.body);
    if (result.changed) {
      // Best-effort: keep the page's wikilink edges in sync with the
      // body. If this throws after the page is already written, the
      // page write stands and the graph is stale — both writes are
      // idempotent so a retry (or a future dream-cycle reconcile pass)
      // heals.
      await syncWikilinksForPage(
        storage,
        result.slug,
        parsed.body.markdown_body ?? "",
      );
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

function isAppendInput(b: unknown): b is AppendInput {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    typeof o["content"] === "string" &&
    (o["written_by"] === undefined || typeof o["written_by"] === "string")
  );
}

export async function handlePageAppend(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<AppendInput>(req);
  if (!parsed.ok) return parsed.response;
  if (!isAppendInput(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, content, ... }" },
      { status: 400 },
    );
  }
  try {
    const result = await appendPage(storage, parsed.body);
    if (result.changed) {
      const fresh = await getPage(storage, result.slug);
      await syncWikilinksForPage(storage, result.slug, fresh?.markdown_body ?? "");
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

interface DeleteRequest {
  slug: string;
  written_by?: string;
}
function isDeleteRequest(b: unknown): b is DeleteRequest {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o["slug"] === "string" &&
    (o["written_by"] === undefined || typeof o["written_by"] === "string")
  );
}

export async function handlePageDelete(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<DeleteRequest>(req);
  if (!parsed.ok) return parsed.response;
  if (!isDeleteRequest(parsed.body)) {
    return Response.json(
      { ok: false, error: "body must be { slug, ... }" },
      { status: 400 },
    );
  }
  try {
    const result = await deletePage(
      storage,
      parsed.body.slug,
      parsed.body.written_by,
    );
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

export async function handlePageGet(
  storage: Storage,
  url: URL,
  isPublic = false,
): Promise<Response> {
  const slug = url.searchParams.get("slug");
  if (!slug) {
    return Response.json(
      { ok: false, error: "query param `slug` is required" },
      { status: 400 },
    );
  }
  try {
    const row = await getPage(storage, slug);
    if (!row) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const out = shouldRedactForPublic(isPublic) ? redactBody(row) : row;
    return Response.json({ ok: true, page: out });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}

function isListRequest(b: unknown): b is ListPagesOptions {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    (o["type"] === undefined || typeof o["type"] === "string") &&
    (o["since"] === undefined || typeof o["since"] === "string") &&
    (o["limit"] === undefined || typeof o["limit"] === "number")
  );
}

export async function handlePageList(
  storage: Storage,
  req: Request,
  isPublic = false,
): Promise<Response> {
  const parsed = await parseJsonBody<ListPagesOptions>(req);
  if (!parsed.ok) return parsed.response;
  // Empty body is a valid "list all" — body_limit returns {} from "".
  const opts = isListRequest(parsed.body) ? parsed.body : {};
  try {
    const rows = await listPages(storage, opts);
    const out = shouldRedactForPublic(isPublic)
      ? rows.map((r) => redactBody(r as unknown as Record<string, unknown>))
      : rows;
    return Response.json({ ok: true, pages: out });
  } catch (e) {
    return errResponse(isPublic, e, 500);
  }
}

export async function handlePageVersions(
  storage: Storage,
  url: URL,
  isPublic = false,
): Promise<Response> {
  const slug = url.searchParams.get("slug");
  if (!slug) {
    return Response.json(
      { ok: false, error: "query param `slug` is required" },
      { status: 400 },
    );
  }
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 20;
  try {
    const rows = await pageVersions(storage, slug, limit);
    // Versions hold body snapshots — redact bodies on public too.
    const out = shouldRedactForPublic(isPublic)
      ? rows.map((r) => ({
          slug: r.slug,
          version_n: r.version_n,
          hash_prev: r.hash_prev,
          hash_new: r.hash_new,
          written_by: r.written_by,
          written_at: r.written_at,
        }))
      : rows;
    return Response.json({ ok: true, versions: out });
  } catch (e) {
    return errResponse(isPublic, e, 400);
  }
}
