/**
 * `memex auth <subcommand>` — manage the self-issued OAuth 2.1 provider
 * (client_credentials). The reference-faithful auth surface: register a client,
 * mint a token, present it as `Authorization: Bearer memex_at_…` on `/mcp`.
 *
 * Subcommands:
 *   register-client <name> [--grant-types G] [--scopes S] [--source SRC]
 *                          [--redirect-uris u1,u2]
 *              --redirect-uris makes it an authorization-code (browser) client
 *              — e.g. a hosted MCP connector's callback. Grants then default to
 *              authorization_code,refresh_token unless --grant-types is given.
 *                          [--federated-read a,b,c]
 *              Register a confidential client. Prints client_id (memex_cl_…) +
 *              client_secret (memex_cs_…) ONCE — only the SHA-256 hash persists.
 *   list-clients
 *              JSON list of registered clients (no secrets).
 *   revoke-client <client_id>
 *              Hard-delete a client (cascades to its tokens/codes via FK).
 *   grant-token <client_id> <client_secret> [--scopes S]
 *              Exchange client_credentials for an access token locally (for a
 *              handoff / smoke test) — equivalent to POST /token.
 *   create <name> [--takes-holders a,b]
 *              Mint a long-lived personal access token (access_tokens row).
 *              Prints the token ONCE — only the SHA-256 hash persists. Tenant
 *              scope comes from `permissions.source_id` (operator-set): a
 *              scalar is write+read source, an array is a federated read set
 *              anchored on its first element.
 *   list       Table of personal access tokens (no hashes).
 *   revoke <name>
 *              Soft-revoke a personal access token by name.
 *   permissions <name> set-takes-holders a,b
 *              Replace the token's takes-visibility allow-list.
 */
import { createHash, randomBytes } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { OAuthProvider } from "../core/oauth-provider.ts";

export type AuthSub =
  | "register-client"
  | "list-clients"
  | "revoke-client"
  | "grant-token"
  | "create"
  | "list"
  | "revoke"
  | "permissions"
  | "test";

interface ClientRow {
  client_id: string;
  client_name: string;
  grant_types: string[];
  scope: string | null;
  source_id: string | null;
  federated_read: string[] | null;
  client_id_issued_at: number | null;
}

function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`auth: flag --${key} needs a value`);
      }
      flags[key] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function withProvider<T>(
  fn: (provider: OAuthProvider, storage: Storage) => Promise<T>,
): Promise<T> {
  const storage = new Storage(loadConfig());
  await storage.init();
  try {
    return await fn(new OAuthProvider({ engine: storage.raw() }), storage);
  } finally {
    await storage.close();
  }
}

async function registerClient(name: string, rest: string[]): Promise<void> {
  if (!name) throw new Error("Usage: auth register-client <name> [flags]");
  const { flags } = parseFlags(rest);
  const redirectUris = flags["redirect-uris"]
    ? flags["redirect-uris"].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // RFC 7591 token_endpoint_auth_method. The provider already validates and
  // supports 'none' (public client, PKCE-only, NO secret minted) — this flag
  // finally makes it reachable from the CLI. Omitted → provider default.
  const tokenEndpointAuthMethod = flags["token-endpoint-auth-method"];
  // A client with a redirect_uri is an authorization-code (browser) client, so
  // default its grants accordingly when the operator didn't say otherwise —
  // mirrors the reference. Without a redirect_uri, default to client_credentials.
  const grantTypes = (
    flags["grant-types"] ??
    (redirectUris.length > 0
      ? "authorization_code,refresh_token"
      : "client_credentials")
  )
    .split(/[\s,]+/)
    .filter(Boolean);
  const scopes = flags["scopes"] ?? "read";
  const sourceId = flags["source"] ?? "default";
  const federatedRead = flags["federated-read"]
    ? flags["federated-read"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const { clientId, clientSecret } = await withProvider((p) =>
    p.registerClientManual(
      name,
      grantTypes,
      scopes,
      redirectUris,
      sourceId,
      federatedRead,
      tokenEndpointAuthMethod,
    ),
  );
  // The secret is shown ONCE — only its hash is stored.
  console.log(
    JSON.stringify(
      {
        client_id: clientId,
        client_secret: clientSecret ?? null,
        client_name: name,
        grant_types: grantTypes,
        scope: scopes,
        source_id: sourceId,
        federated_read: federatedRead ?? [sourceId],
        ...(tokenEndpointAuthMethod
          ? { token_endpoint_auth_method: tokenEndpointAuthMethod }
          : {}),
        note:
          clientSecret === undefined
            ? "Public client (auth method 'none') — no secret minted; PKCE authenticates."
            : "Store client_secret now — it is not recoverable.",
      },
      null,
      2,
    ),
  );
}

async function listClients(): Promise<void> {
  const rows = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<ClientRow>(
        `SELECT client_id, client_name, grant_types, scope, source_id,
                federated_read, client_id_issued_at
           FROM oauth_clients ORDER BY client_id_issued_at`,
      )
      .then((r) => r.rows),
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function revokeClient(clientId: string): Promise<void> {
  if (!clientId) throw new Error("Usage: auth revoke-client <client_id>");
  const deleted = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<{ client_id: string }>(
        "DELETE FROM oauth_clients WHERE client_id = $1 RETURNING client_id",
        [clientId],
      )
      .then((r) => r.rows.length),
  );
  console.log(
    JSON.stringify({ revoked: deleted > 0, client_id: clientId }, null, 2),
  );
}

async function grantToken(
  clientId: string,
  clientSecret: string,
  rest: string[],
): Promise<void> {
  if (!clientId || !clientSecret) {
    throw new Error("Usage: auth grant-token <client_id> <client_secret> [--scopes S]");
  }
  const { flags } = parseFlags(rest);
  const tokens = await withProvider((p) =>
    p.exchangeClientCredentials(clientId, clientSecret, flags["scopes"]),
  );
  console.log(JSON.stringify(tokens, null, 2));
}

async function createToken(name: string, rest: string[]): Promise<void> {
  if (!name) throw new Error("Usage: auth create <name> [--takes-holders a,b]");
  const { flags } = parseFlags(rest);
  // Default ['world'] keeps private takes hidden from MCP-bound tokens
  // until the operator explicitly widens the allow-list (reference v0.28).
  // A flag that parses to nothing (e.g. --takes-holders ",") falls back the
  // same way, matching the reference's empty-list handling.
  const parsedHolders = (flags["takes-holders"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const takesHolders = parsedHolders.length > 0 ? parsedHolders : ["world"];
  const token = "memex_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  await withProvider(async (_p, storage) => {
    const existing = await storage
      .raw()
      .query<{ id: number }>(
        "SELECT id FROM access_tokens WHERE name = $1 AND revoked_at IS NULL",
        [name],
      );
    if (existing.rows.length > 0) {
      throw new Error(
        `A token named "${name}" already exists. Revoke it first or use a different name.`,
      );
    }
    // JSONB params must be JS objects, not pre-stringified JSON: postgres.js
    // encodes a string bound to a jsonb position as a jsonb STRING (the
    // reference's "double-encode bug class" its executeRawJsonb guards
    // against), which breaks permissions.source_id scope resolution.
    await storage.raw().query(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions)
       VALUES ($1, $2, $3::text[], $4::jsonb)`,
      [name, tokenHash, ["read", "write"], { takes_holders: takesHolders }],
    );
  });
  console.log(
    JSON.stringify(
      {
        name,
        token,
        takes_holders: takesHolders,
        note: "Store the token now — only its hash persists. Revoke with: memex auth revoke <name>.",
      },
      null,
      2,
    ),
  );
}

async function listTokens(): Promise<void> {
  const rows = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<{
        name: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
        permissions: unknown;
      }>(
        `SELECT name, created_at, last_used_at, revoked_at, permissions
           FROM access_tokens ORDER BY created_at DESC`,
      )
      .then((r) => r.rows),
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function revokeToken(name: string): Promise<void> {
  if (!name) throw new Error("Usage: auth revoke <name>");
  const revoked = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<{ id: number }>(
        `UPDATE access_tokens SET revoked_at = now()
          WHERE name = $1 AND revoked_at IS NULL RETURNING id`,
        [name],
      )
      .then((r) => r.rows.length),
  );
  if (revoked === 0) {
    throw new Error(`No active token found with name "${name}".`);
  }
  console.log(JSON.stringify({ revoked: true, name }, null, 2));
}

async function setPermissions(
  name: string,
  action: string,
  value: string | undefined,
): Promise<void> {
  if (!name || action !== "set-takes-holders" || !value) {
    throw new Error(
      "Usage: auth permissions <name> set-takes-holders world,ada,brain",
    );
  }
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error(
      'takes-holders list cannot be empty (use "world" for default-deny on private)',
    );
  }
  // Deliberate deviation from the reference's wholesale replace: a JSONB
  // merge preserves an operator-set permissions.source_id tenant grant —
  // replacing would silently drop it and floor the token to the empty
  // 'default' source (see PARITY.md).
  const updated = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<{ id: number }>(
        `UPDATE access_tokens
            SET permissions = COALESCE(permissions, '{}'::jsonb) || $2::jsonb
          WHERE name = $1 AND revoked_at IS NULL RETURNING id`,
        [name, { takes_holders: list }],
      )
      .then((r) => r.rows.length),
  );
  if (updated === 0) {
    throw new Error(`Token "${name}" not found.`);
  }
  console.log(
    JSON.stringify({ name, takes_holders: list, updated: true }, null, 2),
  );
}

export interface AuthTestStep {
  step: "initialize" | "tools/list" | "tools/call";
  ok: boolean;
  detail?: string;
}

export interface AuthTestResult {
  ok: boolean;
  url: string;
  steps: AuthTestStep[];
  toolCount: number;
  elapsedMs: number;
}

/** Parse an MCP HTTP response body (plain JSON or SSE `data:` lines). */
function parseMcpBody(text: string): unknown {
  if (text.includes("event:") || text.startsWith("data:")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        return JSON.parse(line.slice(5));
      } catch {
        // non-JSON data line — keep scanning
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Live end-to-end MCP smoke against a deployed brain: initialize handshake,
 * tools/list, then a real tools/call (`stats`). The ship-verify gate in CLI
 * form. Exported with an injectable fetch so tests run hermetic.
 */
export async function runAuthTest(
  url: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthTestResult> {
  // The bearer goes into the Authorization header of every probe — refuse to
  // leak it in cleartext to a non-local plain-http target.
  const parsed = new URL(url);
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error(
      `auth test: refusing to send the token over ${parsed.protocol}// to a non-local host — use https://`,
    );
  }
  const started = Date.now();
  const steps: AuthTestStep[] = [];
  const post = (body: Record<string, unknown>) =>
    fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });

  let toolCount = 0;
  // Step 1: initialize handshake.
  try {
    const res = await post({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "memex-smoke-test", version: "1.0" },
      },
      id: 1,
    });
    if (!res.ok) {
      steps.push({ step: "initialize", ok: false, detail: `${res.status} ${res.statusText}` });
      return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
    }
    steps.push({ step: "initialize", ok: true });
  } catch (e) {
    steps.push({ step: "initialize", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
  }

  // Step 2: tools/list.
  try {
    const res = await post({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 });
    if (!res.ok) {
      steps.push({ step: "tools/list", ok: false, detail: `${res.status}` });
      return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
    }
    const data = parseMcpBody(await res.text()) as {
      result?: { tools?: unknown[] };
    } | null;
    toolCount = data?.result?.tools?.length ?? 0;
    steps.push({ step: "tools/list", ok: true, detail: `${toolCount} tools` });
  } catch (e) {
    steps.push({ step: "tools/list", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
  }

  // Step 3: a REAL tool call — `stats` is the cheap read every scope allows.
  try {
    const res = await post({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "stats", arguments: {} },
      id: 3,
    });
    if (!res.ok) {
      steps.push({ step: "tools/call", ok: false, detail: `${res.status}` });
      return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
    }
    steps.push({ step: "tools/call", ok: true, detail: "stats" });
  } catch (e) {
    steps.push({ step: "tools/call", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
  }

  return { ok: true, url, steps, toolCount, elapsedMs: Date.now() - started };
}

async function testCommand(rest: string[]): Promise<void> {
  const { positional, flags } = parseFlags(rest);
  const url = positional[0];
  const token = flags["token"];
  if (!url || !token) {
    throw new Error("Usage: auth test <url> --token <token>");
  }
  console.log(`Testing MCP server at ${url}...\n`);
  const result = await runAuthTest(url, token);
  for (const s of result.steps) {
    const mark = s.ok ? "ok " : "FAIL";
    console.log(`  [${mark}] ${s.step}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  if (!result.ok) {
    console.error(`\nSmoke FAILED after ${(result.elapsedMs / 1000).toFixed(1)}s.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nBrain is live: ${result.toolCount} tools, round trip ${(result.elapsedMs / 1000).toFixed(1)}s.`,
  );
}

export async function runAuth(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub as AuthSub) {
    case "register-client":
      return registerClient(rest[0]!, rest.slice(1));
    case "list-clients":
      return listClients();
    case "revoke-client":
      return revokeClient(rest[0]!);
    case "grant-token":
      return grantToken(rest[0]!, rest[1]!, rest.slice(2));
    case "create":
      return createToken(rest[0]!, rest.slice(1));
    case "list":
      return listTokens();
    case "revoke":
      return revokeToken(rest[0]!);
    case "permissions":
      return setPermissions(rest[0]!, rest[1]!, rest[2]);
    case "test":
      return testCommand(rest);
    default:
      console.error(
        "Usage: memex auth <register-client|list-clients|revoke-client|grant-token|create|list|revoke|permissions|test>",
      );
      process.exitCode = 1;
  }
}
