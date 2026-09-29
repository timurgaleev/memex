/**
 * Config loader — layers JSON (boot-essential, written by `init`) with
 * YAML (optional, declarative runtime config) and finally process env
 * (highest precedence, for container-time overrides).
 *
 * Discovery order:
 *   1. <config dir>/config.json   — required, written by `init`
 *   2. <config dir>/memrain.yml, else memex.yml — optional overlay
 *   3. process.env.MEMRAIN_*    — applied at the call site (serve.ts)
 *
 * The config dir is resolved by `resolveConfigDir`.
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
  /** Connection URL with sslmode=require. Override via MEMRAIN_POSTGRES_URL. */
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
 * memrain's own OAuth 2.1 provider (client_credentials). When
 * `selfIssued.enabled === true` the server mounts `/token` and verifies
 * self-issued `memrain_at_…` bearer tokens on the MCP ingress, scoping each to its
 * registered `oauth_clients` row. Default-OFF — the static public bearer stays
 * the sole path. This is the canonical auth surface.
 */
export interface SelfIssuedConfig {
  enabled?: boolean;
}

/**
 * Optional auth overlay. Default-OFF → the static public bearer is the only auth
 * path (unchanged). `selfIssued` is memrain's own client_credentials provider.
 */
export interface AuthConfig {
  selfIssued?: SelfIssuedConfig;
}

export interface Config {
  database: DatabaseConfig;
  embedding: BedrockEmbeddingConfig;
  storage: StorageConfig;

  // Overlay sections — populated from memrain.yml (or the legacy memex.yml) when present.
  vault_paths?: VaultPathsConfig;
  sweep?: SweepConfig;
  dream?: DreamConfig;
  mcp?: McpConfig;
  evalCapture?: EvalCaptureConfig;
  auth?: AuthConfig;
}

/** Config directory names under the home directory. */
export const CONFIG_DIR_NAME = ".memrain";
export const LEGACY_CONFIG_DIR_NAME = ".memex";

/** Overlay file names; the new one wins when both exist (no merge). */
export const YAML_NAME = "memrain.yml";
export const LEGACY_YAML_NAME = "memex.yml";

type Env = Record<string, string | undefined>;

/**
 * The explicit config-file override, or null. Operators (and tests) use it
 * when ~/.memrain points at a production install and the current process wants
 * a different one without a shell-level HOME swap (which Bun's homedir()
 * ignores anyway — it goes through getpwuid).
 */
export function configPathOverride(env: Env = process.env): string | null {
  const override = env.MEMRAIN_CONFIG_PATH;
  return override && override.length > 0 ? override : null;
}

let legacyDirNoted = false;

/**
 * The config directory, in this order:
 *   1. the directory of the config-path override;
 *   2. ~/.memrain when it holds config.json;
 *   3. ~/.memex when it holds config.json;
 *   4. ~/.memrain (a fresh install).
 * A config found in the legacy directory is used as is; nothing is moved.
 */
export function resolveConfigDir(env: Env = process.env, home: string = homedir()): string {
  const override = configPathOverride(env);
  if (override) return dirname(override);
  const current = join(home, CONFIG_DIR_NAME);
  if (existsSync(join(current, "config.json"))) return current;
  const legacy = join(home, LEGACY_CONFIG_DIR_NAME);
  if (existsSync(join(legacy, "config.json"))) {
    if (!legacyDirNoted) {
      legacyDirNoted = true;
      console.error(`[memrain] using the legacy config directory ${legacy}; move it to ${current}`);
    }
    return legacy;
  }
  return current;
}

export function defaultConfigPath(env: Env = process.env, home: string = homedir()): string {
  return configPathOverride(env) ?? join(resolveConfigDir(env, home), "config.json");
}

export function defaultYamlPath(configJsonPath: string): string {
  const dir = dirname(configJsonPath);
  const current = join(dir, YAML_NAME);
  return existsSync(current) ? current : join(dir, LEGACY_YAML_NAME);
}

export function loadConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new Error(
      `memrain: config not found at ${path}. Run 'memrain init --pglite' first.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `memrain: invalid JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const cfg = parsed as Partial<Config>;
  if (!cfg.database) {
    throw new Error(`memrain: config.database is required`);
  }
  if (cfg.database.type === "pglite") {
    if (
      typeof cfg.database.path !== "string" ||
      cfg.database.path.length === 0
    ) {
      throw new Error(
        `memrain: config.database.path must be a non-empty string for type=pglite`,
      );
    }
  } else if (cfg.database.type === "postgres") {
    // URL is optional in the JSON; MEMRAIN_POSTGRES_URL env is the
    // expected source on the EC2 host (populated by fetch-secrets.sh).
  } else {
    throw new Error(
      `memrain: config.database.type must be "pglite" or "postgres" (got ${(cfg.database as { type?: string })?.type ?? "undefined"})`,
    );
  }
  if (!cfg.embedding || cfg.embedding.provider !== "bedrock-titan") {
    throw new Error(`memrain: config.embedding.provider must be "bedrock-titan"`);
  }

  const merged = cfg as Config;

  // Overlay the YAML if present. The YAML is purely additive — it never
  // overrides database / embedding — those are JSON-only to keep boot
  // surface small.
  const yamlPath = defaultYamlPath(path);
  if (existsSync(yamlPath)) {
    let overlay: Partial<Config>;
    try {
      overlay = (parseYaml(readFileSync(yamlPath, "utf8")) ?? {}) as Partial<Config>;
    } catch (e) {
      throw new Error(
        `memrain: invalid YAML at ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`,
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

/**
 * OAuth clients exist but the self-issued provider is off. Every OAuth client
 * is then refused, and the usual cause is a config.json written fresh by
 * `init` next to a database that already has clients (a moved or missing data
 * directory). Returns the operator-facing sentence, or null when consistent.
 */
export function selfIssuedMismatch(config: Config, liveOauthClients: number): string | null {
  if (liveOauthClients === 0 || config.auth?.selfIssued?.enabled === true) return null;
  return (
    `${liveOauthClients} OAuth client(s) registered but auth.selfIssued.enabled is not true, ` +
    `so every OAuth client is refused: config.json looks recreated; data dir moved?`
  );
}
