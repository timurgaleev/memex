/**
 * Config loader — layers JSON (boot-essential, written by `init`) with
 * YAML (optional, declarative runtime config) and finally process env
 * (highest precedence, for container-time overrides).
 *
 * Discovery order:
 *   1. ~/.memex/config.json   — required, written by `init`
 *   2. ~/.memex/memex.yml  — optional overlay
 *   3. process.env.MEMEX_*    — applied at the call site (serve.ts)
 *
 * Why split JSON + YAML: the JSON is small + machine-written + bash-easy
 * (jq friendly), the YAML is the human-edited declarative knob panel.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";

// --- JSON shape (boot-essential) -------------------------------------------

export interface PGliteDatabaseConfig {
  type: "pglite";
  path: string;
}

export interface PostgresDatabaseConfig {
  type: "postgres";
  /** Connection URL with sslmode=require. Override via MEMEX_POSTGRES_URL. */
  url?: string;
}

export type DatabaseConfig = PGliteDatabaseConfig | PostgresDatabaseConfig;

export interface BedrockEmbeddingConfig {
  provider: "bedrock-titan";
  model: string;
  region: string;
}

export interface StorageConfig {
  vault?: string;
}

// --- YAML shape (optional runtime knobs) -----------------------------------

export interface VaultPathsConfig {
  /** Paths backed by an external synchronised store. */
  synced?: string[];
  /** Paths NOT synchronised (workspace/memory). multi-path. */
  local?: string[];
}

export interface SweepConfig {
  /** ms between consecutive file indexes during the initial sweep. */
  per_file_delay_ms?: number;
  /** Cap on files re-indexed per sweep run. */
  max_files?: number;
}

export interface DreamConfig {
  /** Loop period in seconds. <60 disables the loop. */
  interval_s?: number;
  /** Re-embed if existing embeddings are older than this many days. */
  stale_days?: number;
}

export interface McpConfig {
  /** Whether the MCP transport is mounted at POST /mcp. Default true. */
  enabled?: boolean;
  /** Per-IP rate limit. Default 60 req/min. */
  rate_limit_per_minute?: number;
}

export interface EvalCaptureConfig {
  /**
   * When true, every retrieval call lands a row in `eval_candidates`.
   * Default false — opt-in. Once on, the firehose grows fast; trim with
   * a periodic `DELETE FROM eval_candidates WHERE captured_at < …`.
   */
  enabled?: boolean;
  /**
   * When true (default), the query text is PII-scrubbed in-process
   * before INSERT. Set false ONLY when you've taken on the privacy
   * policy decision yourself.
   */
  scrub?: boolean;
}

// --- Combined --------------------------------------------------------------

/**
 * memex's own OAuth 2.1 provider (client_credentials). When
 * `selfIssued.enabled === true` the server mounts `/token` and verifies
 * self-issued `memex_at_…` bearer tokens on the MCP ingress, scoping each to its
 * registered `oauth_clients` row. Default-OFF — the static public bearer stays
 * the sole path. This is memex's reference-faithful auth surface.
 */
export interface SelfIssuedConfig {
  enabled?: boolean;
}

/**
 * Optional auth overlay. Default-OFF → the static public bearer is the only auth
 * path (unchanged). `selfIssued` is memex's own client_credentials provider.
 */
export interface AuthConfig {
  selfIssued?: SelfIssuedConfig;
}

export interface Config {
  database: DatabaseConfig;
  embedding: BedrockEmbeddingConfig;
  storage: StorageConfig;

  // Overlay sections — populated from memex.yml when present.
  vault_paths?: VaultPathsConfig;
  sweep?: SweepConfig;
  dream?: DreamConfig;
  mcp?: McpConfig;
  evalCapture?: EvalCaptureConfig;
  auth?: AuthConfig;
}

export function defaultConfigPath(): string {
  // Operators (and tests) override via MEMEX_CONFIG_PATH. Useful when
  // ~/.memex points at a production install and the current process
  // wants a different one without a shell-level HOME swap (which Bun's
  // homedir() ignores anyway — it goes through getpwuid).
  const override = process.env.MEMEX_CONFIG_PATH;
  if (override && override.length > 0) return override;
  return join(homedir(), ".memex", "config.json");
}

export function defaultYamlPath(configJsonPath: string): string {
  return join(dirname(configJsonPath), "memex.yml");
}

export function loadConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new Error(
      `memex: config not found at ${path}. Run 'memex init --pglite' first.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `memex: invalid JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const cfg = parsed as Partial<Config>;
  if (!cfg.database) {
    throw new Error(`memex: config.database is required`);
  }
  if (cfg.database.type === "pglite") {
    if (
      typeof cfg.database.path !== "string" ||
      cfg.database.path.length === 0
    ) {
      throw new Error(
        `memex: config.database.path must be a non-empty string for type=pglite`,
      );
    }
  } else if (cfg.database.type === "postgres") {
    // URL is optional in the JSON; MEMEX_POSTGRES_URL env is the
    // expected source on the EC2 host (populated by fetch-secrets.sh).
  } else {
    throw new Error(
      `memex: config.database.type must be "pglite" or "postgres" (got ${(cfg.database as { type?: string })?.type ?? "undefined"})`,
    );
  }
  if (!cfg.embedding || cfg.embedding.provider !== "bedrock-titan") {
    throw new Error(`memex: config.embedding.provider must be "bedrock-titan"`);
  }

  const merged = cfg as Config;

  // Overlay memex.yml if present. The YAML is purely additive — it never
  // overrides database / embedding — those are JSON-only to keep boot
  // surface small.
  const yamlPath = defaultYamlPath(path);
  if (existsSync(yamlPath)) {
    let overlay: Partial<Config>;
    try {
      overlay = (parseYaml(readFileSync(yamlPath, "utf8")) ?? {}) as Partial<Config>;
    } catch (e) {
      throw new Error(
        `memex: invalid YAML at ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (overlay.vault_paths) merged.vault_paths = overlay.vault_paths;
    if (overlay.sweep) merged.sweep = overlay.sweep;
    if (overlay.dream) merged.dream = overlay.dream;
    if (overlay.mcp) merged.mcp = overlay.mcp;
    if (overlay.evalCapture) merged.evalCapture = overlay.evalCapture;
    if (overlay.auth) merged.auth = overlay.auth;
    if (overlay.storage?.vault && !merged.storage.vault) {
      merged.storage.vault = overlay.storage.vault;
    }
  }

  return merged;
}
