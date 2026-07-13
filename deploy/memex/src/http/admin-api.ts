/**
 * http/admin-api.ts — admin data endpoints (increment A2).
 *
 * The `/admin/api/*` data routes the admin SPA reads, on Bun.serve: the brain
 * stats plus credential management (Agents page), which wraps the same OAuth
 * provider + PAT store the `auth` CLI uses — a unified `agents` view over
 * oauth_clients + access_tokens with per-credential usage, PAT
 * mint/list/revoke, OAuth client register/revoke, and the per-client
 * token_ttl write side.
 *
 * EVERY route gates on `requireAdmin` itself — the public bearer guard exempts
 * `/admin*`, so there is no ambient protection here.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Storage } from "../core/storage.ts";
import type { Engine } from "../core/engine/interface.ts";
import { getSource } from "../core/sources.ts";
import { brainHealthMetrics } from "../core/source-health.ts";
import { getCalibrationProfile } from "../core/synthesis/reads.ts";
import { OAuthProvider, validateTokenEndpointAuthMethod } from "../core/oauth-provider.ts";
import { normalizeScopesInput } from "../core/scope.ts";

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

/** Per-credential MCP usage rollup shown on the Agents page. */
export interface GrantUsage {
  /** Requests since the start of today (server local `now()` day boundary). */
  requests_today: number;
  /** All-time request count logged for this credential. */
  total_requests: number;
  /** ISO timestamp of the most recent request, or null when never seen. */
  last_used_at: string | null;
}

const EMPTY_USAGE: GrantUsage = { requests_today: 0, total_requests: 0, last_used_at: null };

/**
 * Aggregate `mcp_request_log` into a usage map keyed by CREDENTIAL identity
 * (`token_name`). The request logger stamps the OAuth client id (or the
 * legacy PAT name) into `token_name`, so this map joins the credentials
 * table on the Agents page. One grouped scan.
 */
async function usageByTokenName(engine: Engine): Promise<Map<string, GrantUsage>> {
  const { rows } = await engine.query<{
    token_name: string;
    requests_today: number | string;
    total_requests: number | string;
    last_used_at: string | null;
  }>(
    `SELECT token_name,
            count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS requests_today,
            count(*)::int AS total_requests,
            max(created_at)::text AS last_used_at
       FROM mcp_request_log
      WHERE token_name IS NOT NULL
      GROUP BY token_name`,
  );
  const map = new Map<string, GrantUsage>();
  for (const r of rows) {
    map.set(r.token_name, {
      requests_today: Number(r.requests_today) || 0,
      total_requests: Number(r.total_requests) || 0,
      last_used_at: r.last_used_at,
    });
  }
  return map;
}

/** SHA-256 hex digest — same shape the OAuth provider and `auth create` store. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Return the subset of the given source ids that are not registered. */
async function missingSourceIds(engine: Engine, sourceId: string, federatedRead: string[]): Promise<string[]> {
  const toCheck = Array.from(new Set([sourceId, ...federatedRead]));
  const missing: string[] = [];
  for (const id of toCheck) {
    if (!(await getSource(engine, id))) missing.push(id);
  }
  return missing;
}

/**
 * Coerce a `token_ttl` body value to seconds or null (= server default).
 * `null`/`0` clear the override; anything else must be a positive integer.
 * Throws on malformed input so the route can 400 instead of storing junk.
 */
function parseTokenTtl(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === 0) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("token_ttl must be a positive integer (seconds), or null/0 to clear");
  }
  return n;
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
      const counts = await engine.query<{ documents: number; pages: number; chunks: number }>(
        `SELECT
           (SELECT count(*) FROM documents WHERE deleted_at IS NULL)::int AS documents,
           (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages,
           (SELECT count(*) FROM chunks)::int AS chunks`,
      );
      return Response.json({ health, counts: counts.rows[0] ?? null });
    } catch (e) {
      return serverError("full-stats", e);
    }
  }

  // GET /admin/api/agents — unified credentials view (Agents page): OAuth
  // clients + legacy API keys (access_tokens) in one list, each with status
  // and per-credential usage. Usage joins on `token_name` (the credential id
  // the request logger stamps); a legacy key with no logged calls falls back
  // to its own `last_used_at` column (bumped by the legacy verify path).
  if (p === "/admin/api/agents" && req.method === "GET") {
    try {
      const usage = await usageByTokenName(engine);
      const clients = await engine.query<{
        id: string;
        name: string;
        grant_types: string[] | null;
        scope: string | null;
        token_ttl: number | null;
        source_id: string | null;
        federated_read: string[] | null;
        status: string;
        created_at: string;
      }>(
        `SELECT client_id AS id, client_name AS name, grant_types, scope,
                token_ttl, source_id, federated_read,
                CASE WHEN deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status,
                created_at::text AS created_at
           FROM oauth_clients
          ORDER BY created_at DESC`,
      );
      const keys = await engine.query<{
        id: number | string;
        name: string;
        status: string;
        created_at: string;
        last_used_at: string | null;
      }>(
        `SELECT id, name,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status,
                created_at::text AS created_at, last_used_at::text AS last_used_at
           FROM access_tokens
          ORDER BY created_at DESC`,
      );
      const agents = [
        ...clients.rows.map((c) => ({ auth_type: "oauth" as const, ...c, usage: usage.get(c.id) ?? EMPTY_USAGE })),
        ...keys.rows.map((k) => {
          const u = usage.get(k.name) ?? EMPTY_USAGE;
          return {
            auth_type: "api_key" as const,
            id: String(k.id),
            name: k.name,
            grant_types: null,
            scope: null,
            token_ttl: null,
            source_id: null,
            federated_read: null,
            status: k.status,
            created_at: k.created_at,
            usage: { ...u, last_used_at: u.last_used_at ?? k.last_used_at },
          };
        }),
      ];
      return Response.json({ count: agents.length, agents });
    } catch (e) {
      return serverError("agents", e);
    }
  }

  // GET /admin/api/api-keys — legacy personal access tokens (no hashes).
  if (p === "/admin/api/api-keys" && req.method === "GET") {
    try {
      const { rows } = await engine.query<Record<string, unknown>>(
        `SELECT id, name,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END AS status,
                created_at::text AS created_at, last_used_at::text AS last_used_at
           FROM access_tokens
          ORDER BY created_at DESC`,
      );
      return Response.json({ count: rows.length, keys: rows });
    } catch (e) {
      return serverError("api-keys-list", e);
    }
  }

  // POST /admin/api/api-keys — mint a personal access token (= `auth create`).
  // The plaintext token is returned ONCE; only the SHA-256 hash persists. The
  // default permissions block matches the CLI: takes_holders ['world'] keeps
  // private takes hidden until the operator widens the allow-list.
  if (p === "/admin/api/api-keys" && req.method === "POST") {
    let body: { name?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return badRequest("name required");
    try {
      const dup = await engine.query<{ id: number }>(
        "SELECT id FROM access_tokens WHERE name = $1 AND revoked_at IS NULL",
        [name],
      );
      if (dup.rows.length > 0) {
        return badRequest(`an active token named "${name}" already exists — revoke it first`);
      }
      const token = "memex_" + randomBytes(32).toString("hex");
      // JSONB params are JS objects, never pre-stringified (double-encode bug class).
      const inserted = await engine.query<{ id: number | string }>(
        `INSERT INTO access_tokens (name, token_hash, scopes, permissions)
         VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id`,
        [name, sha256Hex(token), ["read", "write"], { takes_holders: ["world"] }],
      );
      return Response.json({
        ok: true,
        id: String(inserted.rows[0]?.id ?? ""),
        name,
        token,
        note: "Store the token now — only its hash persists.",
      });
    } catch (e) {
      return serverError("api-keys-mint", e);
    }
  }

  // POST /admin/api/api-keys/revoke — soft-revoke a PAT by name (= `auth revoke`).
  if (p === "/admin/api/api-keys/revoke" && req.method === "POST") {
    let body: { name?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.name !== "string" || body.name.length === 0) return badRequest("name required");
    try {
      const r = await engine.query<{ id: number }>(
        `UPDATE access_tokens SET revoked_at = now()
          WHERE name = $1 AND revoked_at IS NULL RETURNING id`,
        [body.name],
      );
      if (r.rows.length === 0) {
        return Response.json({ error: `no active token named "${body.name}"` }, { status: 404 });
      }
      return Response.json({ ok: true, revoked: true, name: body.name });
    } catch (e) {
      return serverError("api-keys-revoke", e);
    }
  }

  // POST /admin/api/register-client — operator-trusted OAuth client
  // registration (= `auth register-client`). Same defaults as the CLI: a
  // client with redirect_uris is an authorization-code (browser) client;
  // without, client_credentials. The secret is returned ONCE. An optional
  // `token_ttl` closes the write side of the per-client TTL the token
  // exchange already honors.
  if (p === "/admin/api/register-client" && req.method === "POST") {
    let body: {
      name?: unknown;
      scopes?: unknown;
      scope?: unknown;
      grant_types?: unknown;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: unknown;
      token_ttl?: unknown;
      source?: unknown;
      read?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return badRequest("name required");

    // Accept both `scopes` (SPA convention) and `scope` (OAuth wire
    // convention) — string or string[]; malformed shapes 400, never coerced.
    let scopeString: string;
    try {
      scopeString = normalizeScopesInput(body.scopes ?? body.scope);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid scopes");
    }
    let authMethod: string;
    try {
      authMethod = validateTokenEndpointAuthMethod(body.token_endpoint_auth_method);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token_endpoint_auth_method");
    }
    let tokenTtl: number | null;
    try {
      tokenTtl = parseTokenTtl(body.token_ttl);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token_ttl");
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string" && u.length > 0)
      : [];
    const grantTypes =
      Array.isArray(body.grant_types) && body.grant_types.length > 0
        ? body.grant_types.filter((g): g is string => typeof g === "string" && g.length > 0)
        : redirectUris.length > 0
          ? ["authorization_code", "refresh_token"]
          : ["client_credentials"];
    const sourceId = typeof body.source === "string" && body.source.length > 0 ? body.source : "default";
    let federatedRead: string[] | undefined;
    if (body.read !== undefined) {
      if (
        !Array.isArray(body.read) ||
        body.read.length === 0 ||
        !body.read.every((x) => typeof x === "string" && x.length > 0)
      ) {
        return badRequest("read must be a non-empty array of source ids");
      }
      federatedRead = body.read as string[];
    }

    try {
      // Validate the source scope only when explicitly set — the implicit
      // 'default' floor mirrors the CLI, which does not validate.
      if (body.source !== undefined || federatedRead !== undefined) {
        const missing = await missingSourceIds(engine, sourceId, federatedRead ?? [sourceId]);
        if (missing.length > 0) return badRequest(`unknown source id(s): ${missing.join(", ")}`);
      }
      const provider = new OAuthProvider({ engine });
      const { clientId, clientSecret } = await provider.registerClientManual(
        name,
        grantTypes,
        scopeString,
        redirectUris,
        sourceId,
        federatedRead,
        authMethod,
      );
      if (tokenTtl !== null) {
        await engine.query("UPDATE oauth_clients SET token_ttl = $1 WHERE client_id = $2", [tokenTtl, clientId]);
      }
      return Response.json({
        ok: true,
        client_id: clientId,
        client_secret: clientSecret ?? null,
        client_name: name,
        grant_types: grantTypes,
        scope: scopeString,
        source_id: sourceId,
        federated_read: federatedRead ?? [sourceId],
        token_ttl: tokenTtl,
        note:
          clientSecret === undefined
            ? "Public client (auth method 'none') — no secret minted; PKCE authenticates."
            : "Store client_secret now — it is not recoverable.",
      });
    } catch (e) {
      return serverError("register-client", e);
    }
  }

  // POST /admin/api/update-client-ttl — set/clear a client's per-token TTL
  // override. The exchange path already reads `oauth_clients.token_ttl`;
  // this is the missing write surface.
  if (p === "/admin/api/update-client-ttl" && req.method === "POST") {
    let body: { client_id?: unknown; token_ttl?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    let ttl: number | null;
    try {
      ttl = parseTokenTtl(body.token_ttl);
    } catch (e) {
      return badRequest(e instanceof Error ? e.message : "invalid token_ttl");
    }
    try {
      const r = await engine.query<{ client_id: string }>(
        "UPDATE oauth_clients SET token_ttl = $1 WHERE client_id = $2 RETURNING client_id",
        [ttl, body.client_id],
      );
      if (r.rows.length === 0) {
        return Response.json({ error: `no client "${body.client_id}"` }, { status: 404 });
      }
      return Response.json({ ok: true, client_id: body.client_id, token_ttl: ttl });
    } catch (e) {
      return serverError("update-client-ttl", e);
    }
  }

  // POST /admin/api/revoke-client — soft-delete an OAuth client and kill its
  // live tokens. Soft-delete (not the CLI's hard DELETE) keeps the audit row;
  // deleting the oauth_tokens rows makes every issued access/refresh token
  // fail verification immediately.
  if (p === "/admin/api/revoke-client" && req.method === "POST") {
    let body: { client_id?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body.client_id !== "string" || body.client_id.length === 0) return badRequest("client_id required");
    try {
      const exists = await engine.query<{ client_id: string }>(
        "SELECT client_id FROM oauth_clients WHERE client_id = $1",
        [body.client_id],
      );
      if (exists.rows.length === 0) {
        return Response.json({ error: `no client "${body.client_id}"` }, { status: 404 });
      }
      const soft = await engine.query<{ client_id: string }>(
        `UPDATE oauth_clients SET deleted_at = now()
          WHERE client_id = $1 AND deleted_at IS NULL RETURNING client_id`,
        [body.client_id],
      );
      const tokens = await engine.query<{ n: number }>(
        "DELETE FROM oauth_tokens WHERE client_id = $1 RETURNING 1 AS n",
        [body.client_id],
      );
      return Response.json({
        ok: true,
        revoked: soft.rows.length > 0,
        client_id: body.client_id,
        tokens_deleted: tokens.rows.length,
      });
    } catch (e) {
      return serverError("revoke-client", e);
    }
  }

  // GET /admin/api/requests?page=N — recent MCP request log rows (RequestLog
  // page). The table (mig 046) exists; a request-logger populates it. Paginated.
  if (p === "/admin/api/requests" && req.method === "GET") {
    try {
      const PER = 25;
      const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
      // Optional filters (all parameterized) so an operator can isolate one
      // agent's traffic, one operation, or the failures. `total` honours the
      // same filter so pagination stays correct.
      const filters: unknown[] = [];
      const clauses: string[] = [];
      const agent = url.searchParams.get("agent");
      if (agent) { filters.push(agent); clauses.push(`agent_name = $${filters.length}`); }
      const operation = url.searchParams.get("operation");
      if (operation) { filters.push(operation); clauses.push(`operation = $${filters.length}`); }
      const status = url.searchParams.get("status");
      if (status) { filters.push(status); clauses.push(`status = $${filters.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await engine.query<Record<string, unknown>>(
        // error_message capped (left(...,300)) — admin-only, but it can carry
        // upstream payload/path text; no need to ship the raw blob to the UI.
        // `params` is stored already-redacted (param-redaction.ts), so shipping
        // it lets the operator see WHAT a misbehaving agent called.
        `SELECT id, token_name, agent_name, operation, latency_ms, status, params,
                left(error_message, 300) AS error_message, created_at::text AS created_at
           FROM mcp_request_log ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}`,
        [...filters, PER, (page - 1) * PER],
      );
      const total = await engine.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM mcp_request_log ${where}`,
        filters,
      );
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

  // GET /admin/api/agents/spend — per-OAuth-client daily spend vs budget cap.
  // The mig-081 spend ledger enforces budget_usd_per_day on paid ops; this is
  // the read side so an operator can see who is near their cap.
  if (p === "/admin/api/agents/spend" && req.method === "GET") {
    try {
      const rows = await engine.query<Record<string, unknown>>(
        `SELECT c.client_id, c.client_name, c.budget_usd_per_day AS cap_usd_per_day,
                COALESCE((SELECT SUM(spend_cents) FROM mcp_spend_log
                            WHERE client_id = c.client_id
                              AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS spent_cents_today,
                COALESCE((SELECT SUM(estimated_cents) FROM mcp_spend_reservations
                            WHERE client_id = c.client_id AND status = 'pending'
                              AND expires_at > now()), 0) AS pending_cents
           FROM oauth_clients c
          WHERE c.deleted_at IS NULL
          ORDER BY c.client_name`,
      );
      return Response.json({ agents: rows.rows });
    } catch (e) {
      return serverError("agents-spend", e);
    }
  }

  // GET /admin/api/stats — dashboard rollup counts (auth surface).
  if (p === "/admin/api/stats" && req.method === "GET") {
    try {
      const r = await engine.query<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM oauth_clients WHERE deleted_at IS NULL) AS connected_agents,
           (SELECT count(*)::int FROM oauth_tokens WHERE token_type = 'access' AND revoked_at IS NULL
               AND expires_at > extract(epoch FROM now())) AS active_tokens,
           (SELECT count(*)::int FROM access_tokens WHERE revoked_at IS NULL) AS active_api_keys,
           (SELECT count(*)::int FROM mcp_request_log WHERE created_at > now() - interval '24 hours') AS requests_today`,
      );
      return Response.json(r.rows[0] ?? {});
    } catch (e) {
      return serverError("stats", e);
    }
  }

  // GET /admin/api/health-indicators — token-expiry + error-rate tiles.
  if (p === "/admin/api/health-indicators" && req.method === "GET") {
    try {
      const r = await engine.query<{
        tokens_expiring_24h: number;
        total_24h: number;
        errors_24h: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM oauth_tokens WHERE token_type = 'access' AND revoked_at IS NULL
               AND expires_at > extract(epoch FROM now())
               AND expires_at <= extract(epoch FROM now() + interval '24 hours')) AS tokens_expiring_24h,
           (SELECT count(*)::int FROM mcp_request_log WHERE created_at > now() - interval '24 hours') AS total_24h,
           (SELECT count(*)::int FROM mcp_request_log WHERE created_at > now() - interval '24 hours'
               AND status <> 'success') AS errors_24h`,
      );
      const row = r.rows[0];
      const total = row?.total_24h ?? 0;
      const errRate = total > 0 ? ((row?.errors_24h ?? 0) / total) * 100 : 0;
      return Response.json({
        tokens_expiring_24h: row?.tokens_expiring_24h ?? 0,
        error_rate_24h: Math.round(errRate * 10) / 10,
      });
    } catch (e) {
      return serverError("health-indicators", e);
    }
  }

  return null; // not a known data route
}
