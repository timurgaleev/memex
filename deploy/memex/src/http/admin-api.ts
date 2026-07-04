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
import type { Engine } from "../core/engine/interface.ts";
import { registerSource } from "../core/sources.ts";
import { listGrants, getGrant, upsertGrant, revokeGrant, validateGrantSourceIds } from "../core/tenant-grants.ts";
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

/** Per-subject MCP usage rollup shown on the Agents page. */
export interface GrantUsage {
  /** Requests since the start of today (server local `now()` day boundary). */
  requests_today: number;
  /** All-time request count logged for this subject. */
  total_requests: number;
  /** ISO timestamp of the most recent request, or null when never seen. */
  last_used_at: string | null;
}

const EMPTY_USAGE: GrantUsage = { requests_today: 0, total_requests: 0, last_used_at: null };

/**
 * Aggregate `mcp_request_log` into a per-subject usage map keyed by the caller
 * id (`agent_name`, which equals the grant `sub`). One grouped scan; rows with
 * a NULL agent_name (unattributed public/internal traffic) are excluded since
 * they map to no grant. Returns an empty map on a pre-046 brain.
 */
async function grantUsageBySubject(engine: Engine): Promise<Map<string, GrantUsage>> {
  const { rows } = await engine.query<{
    agent_name: string;
    requests_today: number | string;
    total_requests: number | string;
    last_used_at: string | null;
  }>(
    `SELECT agent_name,
            count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS requests_today,
            count(*)::int AS total_requests,
            max(created_at)::text AS last_used_at
       FROM mcp_request_log
      WHERE agent_name IS NOT NULL
      GROUP BY agent_name`,
  );
  const map = new Map<string, GrantUsage>();
  for (const r of rows) {
    map.set(r.agent_name, {
      requests_today: Number(r.requests_today) || 0,
      total_requests: Number(r.total_requests) || 0,
      last_used_at: r.last_used_at,
    });
  }
  return map;
}

/** MCP server name the generated client configs register the brain under. */
const CONFIG_SERVER_NAME = "memex";
/** Never echo a real credential — every snippet ships a placeholder the
 *  operator swaps for the subject's own bearer/JWT before pasting. */
const CONFIG_TOKEN_PLACEHOLDER = "<paste-your-token>";
/** Post-connect self-orientation, mirroring the reference's onboarding note but
 *  written for memex's tool surface (no reference codename). */
const CONFIG_LEARN_NOTE =
  "Once connected, call `get_brain_identity` (whose brain this is) and `list_skills` " +
  "(what it can do). Core tools always work: search, query, get_page, put_page, think, " +
  "find_experts. Always search the brain before answering or writing.";

/** Resolve the public MCP endpoint: the declared `MEMEX_PUBLIC_URL` (same env the
 *  OAuth metadata trusts) if set, else the request origin. Always ends in `/mcp`. */
function publicMcpUrl(url: URL): string {
  const declared = (process.env.MEMEX_PUBLIC_URL ?? "").trim();
  const base = (declared || `${url.protocol}//${url.host}`).replace(/\/+$/, "");
  return `${base}/mcp`;
}

export interface AgentConfigScope {
  /** The grant's write source id (null for a read-only grant). */
  write: string | null;
  /** Source ids this subject may read across (federated read set). */
  read: string[];
}

export interface AgentConfig {
  mcp_url: string;
  name: string;
  sub: string;
  scope: AgentConfigScope;
  /** Client id → ready-to-paste snippet (CLI command or config JSON). */
  snippets: Record<"claude-code" | "claude-desktop" | "chatgpt" | "cursor" | "json", string>;
}

/** The `mcpServers` entry shared by the JSON-config clients (Claude Desktop, Cursor). */
function httpServerEntry(mcpUrl: string): Record<string, unknown> {
  return { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${CONFIG_TOKEN_PLACEHOLDER}` } };
}

/**
 * Build the per-subject onboarding config bundle: the same MCP URL + scope,
 * rendered for each common client so onboarding a new agent is copy-paste. The
 * token is always a placeholder — this endpoint never emits a live secret.
 */
export function buildAgentConfig(p: { mcpUrl: string; sub: string; scope: AgentConfigScope }): AgentConfig {
  const { mcpUrl, sub, scope } = p;
  const mcpServers = { mcpServers: { [CONFIG_SERVER_NAME]: httpServerEntry(mcpUrl) } };
  const scopeLine = `# Provisioned for subject "${sub}" — writes to ${scope.write ?? "(read-only)"}, reads ${scope.read.join(", ") || "(none)"}.`;

  const claudeCode = [
    "# Paste into Claude Code:",
    `claude mcp add ${CONFIG_SERVER_NAME} -t http ${mcpUrl} -H "Authorization: Bearer ${CONFIG_TOKEN_PLACEHOLDER}"`,
    "",
    scopeLine,
    CONFIG_LEARN_NOTE,
  ].join("\n");

  const chatgpt = [
    "# ChatGPT (Developer mode → Connectors) → add a remote MCP server:",
    `#   URL:    ${mcpUrl}`,
    "#   Auth:   Bearer token",
    `#   Token:  ${CONFIG_TOKEN_PLACEHOLDER}`,
    "",
    scopeLine,
    CONFIG_LEARN_NOTE,
  ].join("\n");

  return {
    mcp_url: mcpUrl,
    name: CONFIG_SERVER_NAME,
    sub,
    scope,
    snippets: {
      "claude-code": claudeCode,
      // ~/Library/Application Support/Claude/claude_desktop_config.json
      "claude-desktop": JSON.stringify(mcpServers, null, 2),
      chatgpt,
      // ~/.cursor/mcp.json
      cursor: JSON.stringify(mcpServers, null, 2),
      json: JSON.stringify(
        { schema_version: 1, name: CONFIG_SERVER_NAME, mcp_url: mcpUrl, auth: "bearer", token: CONFIG_TOKEN_PLACEHOLDER, sub, scope },
        null,
        2,
      ),
    },
  };
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

  // GET /admin/api/grants — the provisioned JWT-subject grants (Agents page),
  // each enriched with per-subject MCP usage (requests_today / total_requests /
  // last_used_at). Usage is joined by `agent_name = sub`: the request logger
  // stamps the caller's stable client id (== the JWT subject a grant is keyed
  // on) into `mcp_request_log.agent_name`. A grant with no logged calls carries
  // a zeroed usage block (never null) so the UI renders a uniform row. The join
  // is a best-effort display aid — the request-log DB sink is opt-in
  // (`MEMEX_REQUEST_LOG_DB`), so an empty log simply yields all-zero usage.
  if (p === "/admin/api/grants" && req.method === "GET") {
    if (!deps.requireAdmin(req)) return unauthorized();
    try {
      const grants = await listGrants(engine);
      const usage = await grantUsageBySubject(engine);
      const enriched = grants.map((g) => ({
        ...g,
        usage: usage.get(g.sub) ?? EMPTY_USAGE,
      }));
      return Response.json({ count: enriched.length, grants: enriched });
    } catch (e) {
      return serverError("grants-list", e);
    }
  }

  // GET /admin/api/agent-config?sub=… — per-subject onboarding config export
  // (Agents page "config" drawer). Returns copy-paste MCP client snippets
  // (Claude Code / Claude Desktop / ChatGPT / Cursor / raw JSON) filled with the
  // public MCP URL (MEMEX_PUBLIC_URL, else request origin) and the subject's
  // provisioned scope. The token is always a placeholder — no secret is emitted.
  if (p === "/admin/api/agent-config" && req.method === "GET") {
    if (!deps.requireAdmin(req)) return unauthorized();
    const sub = (url.searchParams.get("sub") ?? "").trim();
    if (!sub) return badRequest("sub required");
    try {
      const grant = await getGrant(engine, sub);
      if (!grant) return Response.json({ error: `no grant for subject "${sub}"` }, { status: 404 });
      const scope = { write: grant.source_id, read: grant.federated_read ?? [] };
      return Response.json(buildAgentConfig({ mcpUrl: publicMcpUrl(url), sub, scope }));
    } catch (e) {
      return serverError("agent-config", e);
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
