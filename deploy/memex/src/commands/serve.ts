/**
 * `memex serve --http --host H --port N` — starts the HTTP daemon.
 *
 * Loads config (created by `init`), opens PGLite, starts the server,
 * registers SIGINT/SIGTERM for graceful shutdown.
 */
import { Storage } from "../core/storage.ts";
import { startServer } from "../http/server.ts";
import { loadConfig } from "../core/config.ts";
import {
  startObsidianRecipe,
  type ObsidianRecipeHandle,
} from "../recipes/obsidian.ts";
import { startCycleLoop, type CycleHandle } from "../recipes/cycle.ts";
import { Worker } from "../core/jobs/worker.ts";
import { Queue } from "../core/jobs/queue.ts";
import { registerHandler } from "../core/jobs/handlers.ts";
import { registerSource } from "../core/sources.ts";
import { pollGmail } from "../recipes/gmail.ts";
import { pollGcal } from "../recipes/gcal.ts";
import { sweepCodeRoots } from "../core/sweep-code.ts";
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

function vaultPaths(config: ReturnType<typeof loadConfig>): string[] {
  // Precedence (highest first):
  //   1. MEMEX_VAULT_PATHS env  — comma-separated, container override
  //   2. MEMEX_VAULT_PATH env   — single, legacy
  //   3. memex.yml vault_paths.synced + .local concatenated
  //   4. legacy storage.vault       — JSON config singleton
  const plural = process.env.MEMEX_VAULT_PATHS;
  if (plural && plural.length > 0) {
    return plural
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const singular = process.env.MEMEX_VAULT_PATH;
  if (singular && singular.length > 0) return [singular];

  if (config.vault_paths) {
    const synced = config.vault_paths.synced ?? [];
    const local = config.vault_paths.local ?? [];
    const all = [...synced, ...local].filter((s) => s.length > 0);
    if (all.length > 0) return all;
  }

  return config.storage.vault ? [config.storage.vault] : [];
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
  // follow-up: public Cloudflare Tunnel ingress. When the
  // bearer token is present (via MEMEX_PUBLIC_BEARER env populated
  // by fetch-secrets.sh) we accept authenticated read requests; the
  // server.ts guard rejects internal-only routes regardless.
  const publicBearer = process.env.MEMEX_PUBLIC_BEARER;
  if (publicBearer && publicBearer.length > 0) {
    serverOpts.publicBearerToken = publicBearer;
  }
  const server = startServer(serverOpts);

  // + 5: spin up an obsidian recipe per configured vault path.
  // a periodic dream loop that re-embeds stale docs.
  // Env knobs (all optional):
  //   MEMEX_SWEEP_DELAY_MS   ms between files in the initial sweep
  //   MEMEX_SWEEP_MAX_FILES  cap files reindexed per sweep run
  //   MEMEX_DREAM_INTERVAL_S background maintenance loop period (0 = off)
  //   MEMEX_DREAM_STALE_DAYS how old an embedding must be to re-embed
  const recipes: ObsidianRecipeHandle[] = [];
  const vaults = vaultPaths(config);
  if (vaults.length === 0) {
    console.log(
      "[memex] no vault configured (set MEMEX_VAULT_PATHS, MEMEX_VAULT_PATH, or storage.vault) — recipe disabled",
    );
  } else {
    // Sweep knobs: env > memex.yml > defaults.
    const delayMs = envNum("MEMEX_SWEEP_DELAY_MS")
      ?? config.sweep?.per_file_delay_ms;
    const maxFiles = envNum("MEMEX_SWEEP_MAX_FILES")
      ?? config.sweep?.max_files;
    for (const v of vaults) {
      const recipeOpts: Parameters<typeof startObsidianRecipe>[1] = { vault: v };
      if (delayMs !== undefined && delayMs > 0) {
        recipeOpts.sweepPerFileDelayMs = delayMs;
      }
      if (maxFiles !== undefined && maxFiles > 0) {
        recipeOpts.sweepMaxFiles = maxFiles;
      }
      console.log(
        `[memex] starting obsidian recipe on ${v} (delayMs=${recipeOpts.sweepPerFileDelayMs ?? 0}, maxFiles=${recipeOpts.sweepMaxFiles ?? "∞"})`,
      );
      recipes.push(startObsidianRecipe(storage, recipeOpts));
    }
  }

  // Register the gmail source row (idempotent ON CONFLICT). Path
  // prefix is the `gmail:` scheme the recipe stamps onto every
  // document's source_path — `resolveSourceForPath` does longest-
  // matching-prefix LIKE so `gmail:<id>` attributes back to this row.
  // Run async without awaiting — a transient DB error here shouldn't
  // kill recipe startup.
  registerSource(storage.engine(), {
    id: "gmail",
    kind: "mailbox",
    pathPrefix: "gmail:",
    syncPolicy: "local-only",
    indexedPolicy: "verbatim",
    rateLimitPerMinute: 60,
    respectQuietHours: true,
    boostWeight: 0.6,
    description: "Gmail ingest via OAuth + Nova Lite (Postgres-only, no vault file)",
  }).catch((e) =>
    console.warn(
      `[gmail] source registration failed:`,
      e instanceof Error ? e.message : e,
    ),
  );

  // Register the gmail.poll handler. The Worker doesn't pass storage
  // to handlers; closure captures it here.
  registerHandler("gmail.poll", async (payload) => {
    const pollOpts: Parameters<typeof pollGmail>[1] = {};
    if (typeof payload.maxMessages === "number") pollOpts.maxMessages = payload.maxMessages;
    if (typeof payload.sinceHours === "number") pollOpts.sinceHours = payload.sinceHours;
    if (typeof payload.signalThreshold === "number") {
      pollOpts.signalThreshold = payload.signalThreshold;
    }
    return (await pollGmail(storage, pollOpts)) as unknown as Record<string, unknown>;
  });

  // Register the gcal source row + gcal.poll handler. Path prefix
  // `gcal:` is what the recipe stamps onto every document's
  // source_path; `resolveSourceForPath` longest-prefix-matches against
  // it.
  registerSource(storage.engine(), {
    id: "gcal",
    kind: "calendar",
    pathPrefix: "gcal:",
    syncPolicy: "local-only",
    indexedPolicy: "verbatim",
    rateLimitPerMinute: 60,
    respectQuietHours: true,
    boostWeight: 0.6,
    description: "Google Calendar ingest via OAuth + Nova Lite (Postgres-only, no vault file)",
  }).catch((e) =>
    console.warn(
      `[gcal] source registration failed:`,
      e instanceof Error ? e.message : e,
    ),
  );

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

  registerHandler("gcal.poll", async (payload) => {
    const pollOpts: Parameters<typeof pollGcal>[1] = {};
    if (typeof payload.horizonDays === "number") pollOpts.horizonDays = payload.horizonDays;
    if (typeof payload.maxEvents === "number") pollOpts.maxEvents = payload.maxEvents;
    if (typeof payload.signalThreshold === "number") {
      pollOpts.signalThreshold = payload.signalThreshold;
    }
    return (await pollGcal(storage, pollOpts)) as unknown as Record<string, unknown>;
  });

  // Start the durable jobs worker. Single-concurrency for v1 — gmail.poll
  // and gcal.poll are the registered handlers today; both run hourly
  // on staggered timers (:15 + :30 in the configured zone) so they never overlap.
  const worker = new Worker(new Queue(storage.engine()), { intervalMs: 5000 });
  worker.start();
  console.log(`[memex] jobs worker started (intervalMs=5000)`);

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
    await Promise.allSettled(recipes.map((r) => r.stop()));
    await server.stop();
    await storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive — Bun.serve already does this, but make it explicit.
  await new Promise(() => {});
}
