/**
 * http/admin-api.ts — admin data + provisioning endpoints (increment A2).
 *
 * The `/admin/api/*` data routes the admin SPA reads, on Bun.serve. Faithful to
 * the reference's admin API in SHAPE, adapted to memex's tenancy model: the
 * reference provisions OAuth `oauth_clients`; memex provisions tenant `sources`
 * + JWT-subject `source_grants` (the same thing the `tenant` CLI does). These
 * handlers call the SAME provisioning core (`core/sources.ts` +
 * `core/tenant-grants.ts`) so the API and CLI never drift, plus the brain stats.
 *
 * EVERY route gates on `requireAdmin` itself — the public bearer guard exempts
 * `/admin*`, so there is no ambient protection here.
 */
import type { Storage } from "../core/storage.ts";
import { registerSource } from "../core/sources.ts";
import { listGrants, upsertGrant, revokeGrant, validateGrantSourceIds } from "../core/tenant-grants.ts";
import { brainHealthMetrics } from "../core/source-health.ts";
import { getCalibrationProfile } from "../core/synthesis/reads.ts";

export interface AdminApiDeps {
  storage: Storage;
  /** Session check from the AdminAuth instance (http/admin.ts). */
  requireAdmin: (req: Request) => boolean;
}

const unauthorized = () => Response.json({ error: "Admin authentication required" }, { status: 401 });
const badRequest = (msg: string) => Response.json({ error: msg }, { status: 400 });
/** Log the real cause server-side; return a generic message — don't leak
 *  internal / SQL error text to the client (even an admin one). */
function serverError(route: string, e: unknown): Response {
  console.error(`[admin-api] ${route} failed:`, e instanceof Error ? e.message : e);
  return Response.json({ error: "internal error" }, { status: 500 });
}

/**
 * Dispatch an `/admin/api/*` data route. Returns a Response, or null when the
 * path is not a data route (so the caller can fall through to 404).
 */
export async function handleAdminApi(req: Request, url: URL, deps: AdminApiDeps): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/admin/api/")) return null;

  // Single auth gate for the whole data surface — BEFORE touching the engine,
  // so an unauthenticated caller triggers no work at all.
  if (!deps.requireAdmin(req)) return unauthorized();
  const engine = deps.storage.engine();

  // GET /admin/api/full-stats — brain health + corpus counts (Dashboard).
  if (p === "/admin/api/full-stats" && req.method === "GET") {
    try {
      const health = await brainHealthMetrics(engine);
      const counts = await engine.query<{ documents: number; pages: number; chunks: number; grants: number }>(
        `SELECT
           (SELECT count(*) FROM documents WHERE deleted_at IS NULL)::int AS documents,
           (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages,
           (SELECT count(*) FROM chunks)::int AS chunks,
           (SELECT count(*) FROM source_grants)::int AS grants`,
      );
      return Response.json({ health, counts: counts.rows[0] ?? null });
    } catch (e) {
      return serverError("full-stats", e);
    }
  }

  // GET /admin/api/grants — the provisioned JWT-subject grants (Agents page).
  if (p === "/admin/api/grants" && req.method === "GET") {
    if (!deps.requireAdmin(req)) return unauthorized();
    try {
      const grants = await listGrants(engine);
      return Response.json({ count: grants.length, grants });
    } catch (e) {
      return serverError("grants-list", e);
    }
  }

  // POST /admin/api/sources — register a tenant source (= `tenant add`).
  if (p === "/admin/api/sources" && req.method === "POST") {
    if (!deps.requireAdmin(req)) return unauthorized();
    let body: { id?: unknown; name?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.id !== "string" || body.id.length === 0) return badRequest("id required");
    try {
      const row = await registerSource(engine, {
        id: body.id,
        kind: "other",
        pathPrefix: `tenant:${body.id}`,
        description: typeof body.name === "string" ? body.name : null,
      });
      return Response.json({ ok: true, source: row });
    } catch (e) {
      return serverError("sources", e);
    }
  }

  // POST /admin/api/grants — upsert a JWT-subject grant (= `tenant grant`).
  if (p === "/admin/api/grants" && req.method === "POST") {
    if (!deps.requireAdmin(req)) return unauthorized();
    let body: { sub?: unknown; source?: unknown; read?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.sub !== "string" || body.sub.length === 0) return badRequest("sub required");
    if (typeof body.source !== "string" || body.source.length === 0) return badRequest("source required");
    // `read` absent → default to the write source (matches `tenant grant`). When
    // PRESENT it must be a non-empty array of non-empty strings — a malformed
    // value is rejected, never silently coerced to the default.
    let readIds: string[];
    if (body.read === undefined) {
      readIds = [body.source];
    } else if (
      Array.isArray(body.read) &&
      body.read.length > 0 &&
      body.read.every((x) => typeof x === "string" && x.length > 0)
    ) {
      readIds = body.read as string[];
    } else {
      return badRequest("read must be a non-empty array of source ids");
    }
    try {
      const missing = await validateGrantSourceIds(engine, body.source, readIds);
      if (missing.length > 0) return badRequest(`unknown source id(s): ${missing.join(", ")}`);
      const grant = await upsertGrant(engine, { sub: body.sub, sourceId: body.source, federatedRead: readIds });
      return Response.json({ ok: true, grant });
    } catch (e) {
      return serverError("grants-upsert", e);
    }
  }

  // POST /admin/api/revoke-grant — delete a subject's grant (= `tenant revoke`).
  if (p === "/admin/api/revoke-grant" && req.method === "POST") {
    if (!deps.requireAdmin(req)) return unauthorized();
    let body: { sub?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.sub !== "string" || body.sub.length === 0) return badRequest("sub required");
    try {
      const removed = await revokeGrant(engine, body.sub);
      return Response.json({ ok: true, removed, sub: body.sub });
    } catch (e) {
      return serverError("revoke-grant", e);
    }
  }

  // GET /admin/api/requests?page=N — recent MCP request log rows (RequestLog
  // page). The table (mig 046) exists; a request-logger populates it. Paginated.
  if (p === "/admin/api/requests" && req.method === "GET") {
    try {
      const PER = 25;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
      const rows = await engine.query<Record<string, unknown>>(
        // error_message capped (left(...,300)) — admin-only, but it can carry
        // upstream payload/path text; no need to ship the raw blob to the UI.
        `SELECT id, agent_name, operation, latency_ms, status,
                left(error_message, 300) AS error_message, created_at::text AS created_at
           FROM mcp_request_log
          ORDER BY created_at DESC, id DESC
          LIMIT $1 OFFSET $2`,
        [PER, (page - 1) * PER],
      );
      const total = await engine.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_request_log");
      return Response.json({ page, per_page: PER, total: total.rows[0]?.n ?? 0, rows: rows.rows });
    } catch (e) {
      return serverError("requests", e);
    }
  }

  // GET /admin/api/jobs/watch — job queue snapshot (JobsWatch page): status
  // counts + the most-recent jobs.
  if (p === "/admin/api/jobs/watch" && req.method === "GET") {
    try {
      const counts = await engine.query<{ status: string; n: number }>(
        "SELECT status, count(*)::int AS n FROM jobs GROUP BY status ORDER BY status",
      );
      const recent = await engine.query<Record<string, unknown>>(
        `SELECT id, kind, status, retry_count, left(last_error, 300) AS last_error,
                created_at::text AS created_at,
                started_at::text AS started_at, finished_at::text AS finished_at
           FROM jobs
          ORDER BY created_at DESC
          LIMIT 25`,
      );
      return Response.json({ counts: counts.rows, recent: recent.rows });
    } catch (e) {
      return serverError("jobs-watch", e);
    }
  }

  // GET /admin/api/calibration/profile — the latest synthesis calibration
  // scorecard (Calibration page). Null when no profile has been computed yet.
  if (p === "/admin/api/calibration/profile" && req.method === "GET") {
    try {
      const profile = await getCalibrationProfile(engine);
      return Response.json({ profile });
    } catch (e) {
      return serverError("calibration-profile", e);
    }
  }

  return null; // not a known data route
}
