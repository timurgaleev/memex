/**
 * `memex serve --http --host H --port N` — starts the HTTP daemon.
 *
 * Loads config (created by `init`), opens PGLite, starts the server,
 * registers SIGINT/SIGTERM for graceful shutdown.
 */
import { randomBytes } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { startServer } from "../http/server.ts";
import { loadConfig } from "../core/config.ts";
import { startCycleLoop, type CycleHandle } from "../recipes/cycle.ts";
import { Worker } from "../core/jobs/worker.ts";
import { Queue } from "../core/jobs/queue.ts";
import { registerRemediationHandlers } from "../core/jobs/remediation-handlers.ts";
import { registerIngestCaptureHandler } from "../http/ingest.ts";
import { registerSource } from "../core/sources.ts";
import { OAuthProvider } from "../core/oauth-provider.ts";
import { sweepCodeRoots } from "../core/sweep-code.ts";
import { installSignalHandlers } from "../core/process-cleanup.ts";
import { basename } from "node:path";

export interface ServeOptions {
  http: boolean;
  host: string;
  port: number;
}

/**
 * Code roots come exclusively from the env var. CSV. Each root becomes
 * its own `sources` row at boot (id = `<basename>-code`).
 */
function codePaths(): string[] {
  const raw = process.env.MEMEX_CODE_PATHS;
  if (!raw || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function codeSourceId(path: string): string {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${base || "root"}-code`;
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  if (!opts.http) {
    throw new Error(
      "memex serve: --http is required. (stdio MCP not yet supported.)",
    );
  }

  // Abnormal-termination net: release a held cycle lock (and any other
  // registered cleanup) on SIGHUP/SIGPIPE/uncaughtException/unhandledRejection.
  // It deliberately does NOT touch SIGINT/SIGTERM — those are owned by the
  // graceful `shutdown()` below, which releases the lock via `cycle.stop()`
  // before `storage.close()`. (A competing SIGTERM handler here would race that
  // drain and exit early.)
  installSignalHandlers();

  const config = loadConfig();
  // Pass the full Config so the factory picks the right engine
  // (pglite vs postgres) per database.type. The legacy { dbPath: ... }
  // shape forced PGLite even when config said postgres.
  const storage = new Storage(config);
  await storage.init();

  const serverOpts: Parameters<typeof startServer>[0] = {
    host: opts.host,
    port: opts.port,
    storage,
  };
  if (config.mcp?.enabled === false) {
    serverOpts.mcpEnabled = false;
  }
  if (config.mcp?.rate_limit_per_minute !== undefined) {
    serverOpts.mcpRateLimitPerMinute = config.mcp.rate_limit_per_minute;
  }
  // Per-token-id cap (post-auth) — defeats IP rotation by an authed client.
  const perToken = Number.parseInt(
    process.env.MEMEX_MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE ?? "",
    10,
  );
  if (Number.isInteger(perToken) && perToken > 0) {
    serverOpts.mcpRateLimitPerTokenPerMinute = perToken;
  }
  // follow-up: public Cloudflare Tunnel ingress. When the
  // bearer token is present (via MEMEX_PUBLIC_BEARER env populated
  // by fetch-secrets.sh) we accept authenticated read requests; the
  // server.ts guard rejects internal-only routes regardless.
  const publicBearer = process.env.MEMEX_PUBLIC_BEARER;
  if (publicBearer && publicBearer.length > 0) {
    serverOpts.publicBearerToken = publicBearer;
  }
  // Shared bearer authenticating peer containers on the docker bridge
  // to /index and /friction. When unset, the server emits a startup
  // warning and stays open (legacy single-node behaviour) — operators
  // are urged to set <secrets_prefix>/memex-internal-token.
  const internalToken = process.env.MEMEX_INTERNAL_TOKEN;
  if (internalToken && internalToken.length > 0) {
    serverOpts.internalToken = internalToken;
  }
  // memex's own OAuth 2.1 provider (client_credentials). When enabled, mounts
  // POST /token and verifies self-issued `memex_at_…` tokens on /mcp. Shares the
  // engine with the brain — the oauth_clients/oauth_tokens tables (migration
  // 046) already exist. The reference-faithful auth path.
  if (config.auth?.selfIssued?.enabled === true) {
    const provider = new OAuthProvider({ engine: storage.raw() });
    serverOpts.oauthProvider = provider;
    // Sweep expired access/refresh tokens + auth codes at startup (reference
    // parity) — the tables otherwise grow until a verify happens to hit the
    // expired row. Best-effort: a sweep failure must never block serve.
    try {
      const swept = await provider.sweepExpiredTokens();
      if (swept > 0) console.error(`[memex] swept ${swept} expired OAuth tokens/codes`);
    } catch (e) {
      console.error(
        "[memex] token sweep failed (non-blocking):",
        e instanceof Error ? e.message : e,
      );
    }
  }
  // Admin surface bootstrap token (A1). Stable when MEMEX_ADMIN_BOOTSTRAP is
  // set; otherwise an ephemeral per-run token printed to stderr (lives only in
  // the operator's terminal — never in a URL). Mounting the `/admin` auth routes
  // either way keeps parity with the reference.
  const adminBootstrap = process.env.MEMEX_ADMIN_BOOTSTRAP?.trim();
  // The admin surface provisions the whole brain (sources, tenant grants), so an
  // operator-set bootstrap token must meet a minimum entropy floor — reject a weak
  // value at boot rather than lean on the login rate limiter alone (reference parity).
  if (adminBootstrap && adminBootstrap.length > 0 && !/^[A-Za-z0-9_-]{32,}$/.test(adminBootstrap)) {
    throw new Error(
      "MEMEX_ADMIN_BOOTSTRAP is too weak: use 32+ chars from [A-Za-z0-9_-] " +
        "(e.g. `openssl rand -base64 32 | tr '+/' '-_'`), or unset it for an ephemeral per-run token.",
    );
  }
  const adminToken = adminBootstrap && adminBootstrap.length > 0 ? adminBootstrap : randomBytes(24).toString("hex");
  serverOpts.adminBootstrapToken = adminToken;
  if (!adminBootstrap) {
    console.error(`[memex] admin bootstrap token (ephemeral, this run only): ${adminToken}`);
  }
  const server = startServer(serverOpts);

  // Markdown ingest is on-demand only: there is no boot-time file watcher.
  // Content enters the brain via the MCP `index` tool / the `memex reindex`
  // CLI (both go through core/sweep.ts → indexer), or via MCP `page_put`.
  // No filesystem vault is watched at startup.

  // code chunkers (graph-only, see TODO External-dep roadmap).
  // Register one source row per MEMEX_CODE_PATHS entry, then run a
  // boot sweep. Both are best-effort: registration errors are warned,
  // sweep errors are logged but do NOT abort serve startup.
  const codeRoots = codePaths();
  if (codeRoots.length === 0) {
    console.log(
      "[memex] no code roots configured (set MEMEX_CODE_PATHS=/path/to/repo[,...] to enable code chunkers)",
    );
  } else {
    for (const root of codeRoots) {
      const sourceId = codeSourceId(root);
      registerSource(storage.engine(), {
        id: sourceId,
        kind: "code",
        pathPrefix: root.endsWith("/") ? root : root + "/",
        syncPolicy: "local-only",
        indexedPolicy: "hashed-only",
        rateLimitPerMinute: 0,
        respectQuietHours: false,
        boostWeight: 1.2,
        description: `Code corpus rooted at ${root} (graph-only via tree-sitter)`,
      }).catch((e) =>
        console.warn(
          `[code] source registration failed for ${sourceId}:`,
          e instanceof Error ? e.message : e,
        ),
      );
    }
    const codeDelayMs = envNum("MEMEX_CODE_SWEEP_DELAY_MS") ?? 0;
    void (async () => {
      try {
        const sweepOpts: Parameters<typeof sweepCodeRoots>[1] = { paths: codeRoots };
        if (codeDelayMs > 0) sweepOpts.perFileDelayMs = codeDelayMs;
        const r = await sweepCodeRoots(storage, sweepOpts);
        for (const pr of r.perRoot) {
          if (pr.missing) {
            console.warn(
              `[code] root '${pr.root}' does not exist on disk — bind-mount or git clone missing?`,
            );
          } else if (pr.files === 0) {
            console.warn(
              `[code] root '${pr.root}' contains 0 indexable files (.ts/.tsx/.py) — is the directory mounted and populated?`,
            );
          }
        }
        console.log(
          `[code] boot sweep: scanned=${r.scanned} reindexed=${r.reindexed} skipped=${r.skipped} parseErrors=${r.parseErrors} errors=${r.errors.length}`,
        );
      } catch (e) {
        console.warn(
          "[code] boot sweep failed:",
          e instanceof Error ? e.message : e,
        );
      }
    })();
  }

  // Start the durable jobs worker. Single-concurrency for v1. (The legacy
  // ingest recipes were removed — markdown enters via on-demand reindex /
  // MCP, code via the boot sweep; jobs remain for future handlers.)
  // A default per-job wall-clock cap is OFF unless MEMEX_JOB_TIMEOUT_MS is set
  // (a blanket cap could dead-letter a legitimately-slow Bedrock phase); a job
  // can still set its own timeoutMs at enqueue.
  const workerOpts: ConstructorParameters<typeof Worker>[1] = {
    intervalMs: 5000,
    // Single-active-worker guard: a double-start / second container / restart
    // overlap elects ONE active worker via the worker_lock row; the rest idle
    // until the holder's heartbeat lapses (migration 042).
    engine: storage.engine(),
  };
  const jobTimeoutRaw = process.env.MEMEX_JOB_TIMEOUT_MS?.trim();
  // Strict: digits only (reject "100abc" -> 100, "1e9" -> 1, negatives, blanks),
  // matching enqueue's positive-integer validation.
  if (jobTimeoutRaw !== undefined && /^\d+$/.test(jobTimeoutRaw)) {
    const parsed = Number.parseInt(jobTimeoutRaw, 10);
    if (parsed > 0) workerOpts.jobTimeoutMs = parsed;
  }
  // Register the `remediation` handler so `doctor --remediate` jobs actually
  // run instead of dead-lettering with "no handler registered".
  registerRemediationHandlers();
  // Register the `ingest_capture` handler so POST /ingest submissions land
  // as inbox pages instead of dead-lettering.
  registerIngestCaptureHandler(storage);
  const worker = new Worker(new Queue(storage.engine()), workerOpts);
  worker.start();
  console.log(
    `[memex] jobs worker started (intervalMs=5000${
      workerOpts.jobTimeoutMs ? `, jobTimeoutMs=${workerOpts.jobTimeoutMs}` : ""
    })`,
  );

  // Cycle loop. Off by default; opt in via env or memex.yml. The
  // `dream.*` config keys drive the cycle's embed-stale phase.
  // Threshold for enabling stays at >=60 s to avoid
  // accidental tight loops.
  const cycleIntervalS = envNum("MEMEX_DREAM_INTERVAL_S")
    ?? config.dream?.interval_s
    ?? 0;
  const cycleStaleDays = envNum("MEMEX_DREAM_STALE_DAYS")
    ?? config.dream?.stale_days
    ?? 30;
  let cycle: CycleHandle | null = null;
  if (Number.isFinite(cycleIntervalS) && cycleIntervalS >= 60) {
    console.log(
      `[memex] starting cycle loop: every ${cycleIntervalS}s, embed-stale at >${cycleStaleDays}d`,
    );
    cycle = startCycleLoop(storage, {
      intervalMs: cycleIntervalS * 1000,
      staleDays: cycleStaleDays,
    });
  }

  // Graceful shutdown on SIGINT / SIGTERM.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[memex] received ${signal}, shutting down`);
    await worker.stop();
    if (cycle) await cycle.stop();
    await server.stop();
    await storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive — Bun.serve already does this, but make it explicit.
  await new Promise(() => {});
}
