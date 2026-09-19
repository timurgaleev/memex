/**
 * `memex auth doctor <base-url>` — a client-side end-to-end check of a deployed
 * brain, as one report: /health stamp, OAuth discovery, client_credentials
 * mint, MCP initialize/tools-list/whoami, and the caller's tenancy scope.
 *
 * Everything runs from the operator's machine against the public origin, so it
 * sees what a connecting client sees (ingress, TLS, a stale container behind a
 * load balancer), not what the host sees on loopback.
 */
import { lstatSync, readFileSync } from "node:fs";
import { NO_SOURCE_SENTINEL } from "../core/auth-info.ts";
import { parseMcpBody } from "./auth.ts";

export type DoctorCredentials =
  | { kind: "client"; clientId: string; clientSecret: string }
  | { kind: "token"; token: string };

export interface DoctorOptions {
  /** A /health stamp other than this one is drift (FAIL). */
  expectVersion?: string;
  /** whoami must report this write source and read from it alone. */
  expectSource?: string;
  /**
   * whoami must report a trusted (non-public, unredacted) caller whose reads
   * cover the operator's own brain: read_sources null (trusted-local) or a
   * grant that includes `default`, where every PAT and OAuth client without
   * an explicit grant lands.
   */
  expectOperator?: boolean;
}

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  name: CheckName;
  status: CheckStatus;
  detail: string;
}

export interface DoctorWhoami {
  client_id: string | null;
  scopes: string[];
  write_source: string | null;
  read_sources: string[] | null;
  /** null when the server did not report it — treated as untrusted. */
  is_public: boolean | null;
}

export interface DoctorResult {
  ok: boolean;
  baseUrl: string;
  checks: DoctorCheck[];
  version: string | null;
  whoami: DoctorWhoami | null;
  elapsedMs: number;
}

const CHECK_NAMES = [
  "health",
  "discovery",
  "mint",
  "initialize",
  "tools/list",
  "whoami",
  "scope",
] as const;
type CheckName = (typeof CHECK_NAMES)[number];

/** A malformed invocation (bad URL, cleartext transport, unreadable
 *  credentials) rather than an unhealthy brain — the CLI maps it to exit 2. */
export class DoctorUsageError extends Error {}

const DETAIL_MAX = 200;
const REDACTED = "[redacted]";

/**
 * Replace every secret occurrence, then truncate. split/join is a plain
 * substring scan — linear in the body, no regex over server-controlled text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length > 0) out = out.split(s).join(REDACTED);
  }
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX)}…` : out;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Load `{client_id, client_secret}` or `{token}` from a private file. Secrets
 * never ride argv (shell history, `ps`), and a file anyone else can read is a
 * leaked credential — so a loose mode or a symlink (whose target's owner and
 * mode are not what lstat saw) is refused. Errors name the path and mode only.
 */
export function readCredentialFile(path: string): DoctorCredentials {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new DoctorUsageError(`credentials file ${path} cannot be read`);
  }
  if (st.isSymbolicLink()) {
    throw new DoctorUsageError(`credentials file ${path} is a symlink — pass the real file`);
  }
  if (!st.isFile()) {
    throw new DoctorUsageError(`credentials file ${path} is not a regular file`);
  }
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new DoctorUsageError(
      `credentials file ${path} has mode 0${mode.toString(8)} — chmod 600 it first`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DoctorUsageError(`credentials file ${path} is not valid JSON`);
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (typeof obj.client_id === "string" && typeof obj.client_secret === "string" &&
    obj.client_id.length > 0 && obj.client_secret.length > 0) {
    return { kind: "client", clientId: obj.client_id, clientSecret: obj.client_secret };
  }
  if (typeof obj.token === "string" && obj.token.length > 0) {
    return { kind: "token", token: obj.token };
  }
  throw new DoctorUsageError(
    `credentials file ${path} must hold {client_id, client_secret} or {token}`,
  );
}

function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Compare discovery URLs the way the origin was derived: through the URL
 * parser, so case, a default port or a trailing slash is not drift. A value
 * with a real path stays distinct from the bare origin.
 */
function normalizeUrl(s: string): string {
  try {
    const u = new URL(s);
    if (u.pathname === "/" && u.search === "" && u.hash === "") return u.origin;
    return stripSlash(u.href);
  } catch {
    return stripSlash(s);
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** The operator's own source; see `parseLegacyTokenScope` in the provider. */
const OPERATOR_SOURCE = "default";

/**
 * Redirects are never followed. A 307/308 re-sends the body — the client
 * secret in client_secret_post mode — and whether the bearer header survives a
 * cross-origin hop is up to the runtime, so any 3xx is a failure that names
 * where it pointed.
 */
function redirectProblem(res: Response, requestUrl: string, redact: (s: string) => string): string | null {
  if (res.type !== "opaqueredirect" && (res.status < 300 || res.status > 399)) return null;
  const loc = res.headers.get("Location");
  let target = "(no Location)";
  if (loc !== null) {
    try {
      target = new URL(loc, requestUrl).origin;
    } catch {
      target = "(unparseable Location)";
    }
  }
  return `HTTP ${res.status} redirect to ${redact(target)} — not followed`;
}

export function evaluateOperatorScope(w: DoctorWhoami): string | null {
  if (w.is_public !== false) {
    return w.is_public === true
      ? "is_public is true (the static public bearer: redacted bodies, restricted tools)"
      : "whoami did not report is_public";
  }
  if (w.read_sources === null) return null;
  if (w.read_sources.length === 0 || w.read_sources.every((s) => s === NO_SOURCE_SENTINEL)) {
    return "no read grant (fail-closed)";
  }
  if (!w.read_sources.includes(OPERATOR_SOURCE)) {
    return `read grant does not cover '${OPERATOR_SOURCE}'`;
  }
  return null;
}

interface RpcReply {
  ok: boolean;
  detail: string;
  result?: Record<string, unknown>;
}

export async function runRemoteDoctor(
  baseUrl: string,
  creds: DoctorCredentials,
  opts: DoctorOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<DoctorResult> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new DoctorUsageError(`'${baseUrl}' is not a URL`);
  }
  // Credentials go out on the token request and every /mcp probe — never in
  // cleartext to anything but this machine.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new DoctorUsageError(
      `refusing to send credentials over ${parsed.protocol}// to a non-local host — use https://`,
    );
  }
  const origin = parsed.origin;
  const started = Date.now();
  const secrets = creds.kind === "client" ? [creds.clientSecret] : [creds.token];
  const redact = (s: string) => redactSecrets(s, secrets);
  const errText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));

  const checks: DoctorCheck[] = [];
  let version: string | null = null;
  let whoami: DoctorWhoami | null = null;
  const record = (name: CheckName, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });
  const finish = (): DoctorResult => {
    for (const name of CHECK_NAMES) {
      if (!checks.some((c) => c.name === name)) {
        checks.push({ name, status: "skipped", detail: "an earlier check failed" });
      }
    }
    return {
      ok: checks.every((c) => c.status !== "fail"),
      baseUrl: origin,
      checks,
      version,
      whoami,
      elapsedMs: Date.now() - started,
    };
  };

  const getJson = async (path: string): Promise<{ status: number; body: unknown; text: string }> => {
    const url = `${origin}${path}`;
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    const redirected = redirectProblem(res, url, redact);
    if (redirected !== null) throw new Error(`${path}: ${redirected}`);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  };

  // (1) health — liveness plus the build stamp.
  try {
    const { status, body, text } = await getJson("/health");
    const h = (body ?? {}) as { ok?: unknown; version?: unknown };
    if (status !== 200 || h.ok !== true) {
      record("health", "fail", `HTTP ${status}: ${redact(text)}`);
      return finish();
    }
    if (typeof h.version !== "string" || h.version.length === 0) {
      record("health", "fail", "no version stamp in /health");
      return finish();
    }
    version = h.version;
    if (opts.expectVersion !== undefined && h.version !== opts.expectVersion) {
      record("health", "fail", `drift: running ${h.version}, expected ${opts.expectVersion}`);
    } else if (opts.expectVersion === undefined && h.version === "dev") {
      record("health", "warn", "version stamp is 'dev' — built without deploy.sh");
    } else {
      record("health", "ok", `version ${h.version}`);
    }
  } catch (e) {
    record("health", "fail", errText(e));
    return finish();
  }

  // (2) discovery — both documents must describe this origin.
  let tokenEndpoint = "";
  let authMethods: string[] = [];
  try {
    const as = await getJson("/.well-known/oauth-authorization-server");
    const pr = await getJson("/.well-known/oauth-protected-resource");
    const meta = (as.body ?? {}) as Record<string, unknown>;
    const res = (pr.body ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (as.status !== 200 || as.body === null) problems.push(`authorization-server metadata HTTP ${as.status}`);
    if (pr.status !== 200 || pr.body === null) problems.push(`protected-resource metadata HTTP ${pr.status}`);
    const issuer = typeof meta.issuer === "string" ? normalizeUrl(meta.issuer) : "";
    if (problems.length === 0) {
      if (issuer !== origin) problems.push(`issuer ${redact(issuer) || "(missing)"} is not ${origin}`);
      if (typeof meta.token_endpoint !== "string") {
        problems.push("token_endpoint missing");
      } else if (!sameOrigin(meta.token_endpoint, origin)) {
        problems.push(`token_endpoint ${redact(meta.token_endpoint)} is on another origin`);
      } else {
        tokenEndpoint = meta.token_endpoint;
      }
      const grants = Array.isArray(meta.grant_types_supported) ? meta.grant_types_supported : [];
      if (!grants.includes("client_credentials")) problems.push("client_credentials not in grant_types_supported");
      authMethods = Array.isArray(meta.token_endpoint_auth_methods_supported)
        ? meta.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === "string")
        : [];
      const resource = typeof res.resource === "string" ? normalizeUrl(res.resource) : "";
      const servers = Array.isArray(res.authorization_servers)
        ? res.authorization_servers.filter((s): s is string => typeof s === "string").map(normalizeUrl)
        : [];
      if (resource !== origin) problems.push(`protected resource ${redact(resource) || "(missing)"} is not ${origin}`);
      if (!servers.includes(origin)) problems.push("authorization_servers does not name the issuer");
    }
    if (problems.length > 0) {
      record("discovery", "fail", problems.join("; "));
      return finish();
    }
    record("discovery", "ok", `issuer ${origin}`);
  } catch (e) {
    record("discovery", "fail", errText(e));
    return finish();
  }

  // (3) mint — client_credentials against the discovered, same-origin endpoint.
  let bearer: string;
  if (creds.kind === "token") {
    bearer = creds.token;
    record("mint", "skipped", "token file given");
  } else {
    const basicFirst =
      authMethods.find((m) => m === "client_secret_post" || m === "client_secret_basic") ===
      "client_secret_basic";
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (basicFirst) {
      const pair = `${encodeURIComponent(creds.clientId)}:${encodeURIComponent(creds.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else {
      form.set("client_id", creds.clientId);
      form.set("client_secret", creds.clientSecret);
    }
    try {
      const res = await fetchFn(tokenEndpoint, {
        method: "POST",
        headers,
        body: form.toString(),
        redirect: "manual",
      });
      const redirected = redirectProblem(res, tokenEndpoint, redact);
      if (redirected !== null) {
        record("mint", "fail", redirected);
        return finish();
      }
      const text = await res.text();
      if (res.status !== 200) {
        record("mint", "fail", `HTTP ${res.status}: ${redact(text)}`);
        return finish();
      }
      let tok: Record<string, unknown> = {};
      try {
        tok = (JSON.parse(text) ?? {}) as Record<string, unknown>;
      } catch {
        record("mint", "fail", "token response is not JSON");
        return finish();
      }
      const access = typeof tok.access_token === "string" ? tok.access_token : "";
      if (access.length === 0) {
        record("mint", "fail", "no access_token in the token response");
        return finish();
      }
      secrets.push(access);
      const type = typeof tok.token_type === "string" ? tok.token_type : "";
      const ttl = typeof tok.expires_in === "number" ? tok.expires_in : NaN;
      if (type.toLowerCase() !== "bearer" || !(ttl > 0)) {
        record("mint", "fail", `token_type ${type || "(missing)"}, expires_in ${Number.isNaN(ttl) ? "(missing)" : ttl}`);
        return finish();
      }
      bearer = access;
      record("mint", "ok", `bearer, expires in ${ttl}s`);
    } catch (e) {
      record("mint", "fail", errText(e));
      return finish();
    }
  }

  // (4) MCP — an HTTP 200 carrying a JSON-RPC error or isError is still a failure.
  let rpcId = 0;
  const rpc = async (method: string, params: Record<string, unknown>): Promise<RpcReply> => {
    try {
      const res = await fetchFn(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        redirect: "manual",
      });
      const redirected = redirectProblem(res, `${origin}/mcp`, redact);
      if (redirected !== null) return { ok: false, detail: redirected };
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${redact(text)}` };
      const msg = parseMcpBody(text) as { result?: unknown; error?: { message?: unknown } } | null;
      if (msg === null) return { ok: false, detail: `unparseable response: ${redact(text)}` };
      if (msg.error !== undefined) {
        return { ok: false, detail: `JSON-RPC error: ${redact(String(msg.error?.message ?? JSON.stringify(msg.error)))}` };
      }
      if (msg.result === null || typeof msg.result !== "object") {
        return { ok: false, detail: "response has no result" };
      }
      return { ok: true, detail: "", result: msg.result as Record<string, unknown> };
    } catch (e) {
      return { ok: false, detail: errText(e) };
    }
  };

  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "memex-remote-doctor", version: "1.0" },
  });
  if (!init.ok) {
    record("initialize", "fail", init.detail);
    return finish();
  }
  {
    const info = (init.result?.serverInfo ?? {}) as { version?: unknown };
    const served = typeof info.version === "string" ? info.version : "(missing)";
    const problems: string[] = [];
    // /health and /mcp answered by different builds means a stale container is
    // still in the pool.
    if (served !== version) problems.push(`serverInfo.version ${served} differs from /health ${version}`);
    const instr = init.result?.instructions;
    if (typeof instr !== "string" || instr.trim().length === 0) problems.push("no instructions");
    if (problems.length > 0) record("initialize", "fail", problems.join("; "));
    else record("initialize", "ok", `serverInfo ${served}, instructions present`);
  }

  const list = await rpc("tools/list", {});
  if (!list.ok) {
    record("tools/list", "fail", list.detail);
    return finish();
  }
  const tools = Array.isArray(list.result?.tools) ? list.result.tools : [];
  record("tools/list", tools.length > 0 ? "ok" : "fail", `${tools.length} tools`);

  const call = await rpc("tools/call", { name: "whoami", arguments: {} });
  if (!call.ok) {
    record("whoami", "fail", call.detail);
    return finish();
  }
  const content = Array.isArray(call.result?.content) ? call.result.content : [];
  const first = content[0] as { text?: unknown } | undefined;
  const text = typeof first?.text === "string" ? first.text : "";
  if (call.result?.isError === true) {
    record("whoami", "fail", `tool error: ${redact(text)}`);
    return finish();
  }
  try {
    const w = JSON.parse(text) as Record<string, unknown>;
    whoami = {
      client_id: typeof w.client_id === "string" ? w.client_id : null,
      scopes: Array.isArray(w.scopes) ? w.scopes.filter((s): s is string => typeof s === "string") : [],
      write_source: typeof w.write_source === "string" ? w.write_source : null,
      read_sources: Array.isArray(w.read_sources)
        ? w.read_sources.filter((s): s is string => typeof s === "string")
        : null,
      is_public: typeof w.is_public === "boolean" ? w.is_public : null,
    };
  } catch {
    record("whoami", "fail", `whoami payload is not JSON: ${redact(text)}`);
    return finish();
  }
  record("whoami", "ok", `client ${whoami.client_id ?? "(none)"}`);

  // (5) scope — what this credential can actually reach.
  const reads = whoami.read_sources === null ? "null (whole brain)" : `[${whoami.read_sources.join(",")}]`;
  const summary =
    `scopes ${whoami.scopes.join(",") || "(none)"}, write_source ${whoami.write_source ?? "null"}, ` +
    `read_sources ${reads}, is_public ${whoami.is_public ?? "(missing)"}`;
  if (opts.expectSource !== undefined) {
    const src = opts.expectSource;
    // A tenant credential that can also read other sources is not scoped to
    // src, however its write source looks.
    const extra = whoami.read_sources?.filter((s) => s !== src) ?? [];
    const good = whoami.is_public === false && whoami.write_source === src &&
      whoami.read_sources !== null && whoami.read_sources.includes(src) && extra.length === 0;
    const why = extra.length > 0 ? `; extra read sources [${extra.join(",")}]` : "";
    record("scope", good ? "ok" : "fail", good ? summary : `expected source ${src}${why}; got ${summary}`);
  } else if (opts.expectOperator === true) {
    const problem = evaluateOperatorScope(whoami);
    record("scope", problem === null ? "ok" : "fail",
      problem === null ? summary : `expected operator: ${problem}; got ${summary}`);
  } else {
    record("scope", "ok", summary);
  }
  return finish();
}

const PRINT_MAX = 300;

/**
 * Make server-controlled text safe for a terminal: drop C0/C1 control
 * characters (escape sequences could rewrite the report or the screen) and
 * cap the length. A char-code scan, no regex.
 */
export function sanitizeForTerminal(text: string, max = PRINT_MAX): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) continue;
    out += ch;
    if (out.length > max) return `${out.slice(0, max)}…`;
  }
  return out;
}

/** The human-readable report; every detail may carry server-controlled text. */
export function formatDoctorReport(result: DoctorResult): string {
  const marks = { ok: "ok  ", warn: "warn", fail: "FAIL", skipped: "skip" } as const;
  const lines = [`Checking ${sanitizeForTerminal(result.baseUrl)}...`, ""];
  for (const c of result.checks) {
    lines.push(`  [${marks[c.status]}] ${c.name} — ${sanitizeForTerminal(c.detail)}`);
  }
  const secs = (result.elapsedMs / 1000).toFixed(1);
  lines.push("", result.ok ? `Remote doctor passed in ${secs}s.` : `Remote doctor FAILED after ${secs}s.`);
  return lines.join("\n");
}
