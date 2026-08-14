/**
 * Runtime config — the DB-plane knob store behind `memex config` (migration
 * 088), an engine-config surface over memex's env-shaped knobs.
 *
 * memex knobs are MEMEX_* env vars read all over the codebase, so instead of
 * threading a config object through every resolver, the DB plane stores
 * env-shaped keys and {@link applyRuntimeEnvOverlay} projects them onto
 * `process.env` at engine-connect time (Storage.init) — ONLY for keys the real
 * environment did not set. Resolution order therefore stays:
 *
 *   per-call SearchOptions → real env → runtime_config row → code default
 *
 * Long-lived processes (serve) read the overlay once at boot; a `config set`
 * against a running server takes effect on the next restart, while every fresh
 * CLI invocation sees it immediately.
 *
 * Key alphabet is locked to ^MEMEX_[A-Z0-9_]{1,64}$ — the overlay must never
 * become an injection surface for PATH / LD_PRELOAD / NODE_OPTIONS.
 */
import type { Engine } from "./engine/interface.ts";

export const RUNTIME_CONFIG_KEY_RE = /^MEMEX_[A-Z0-9_]{1,64}$/;

export function isRuntimeConfigKey(key: string): boolean {
  return RUNTIME_CONFIG_KEY_RE.test(key);
}

/**
 * Sensitive-key detector shared by every display surface so `show` and the
 * `set` confirmation can't drift. Word-segment
 * match: `MEMEX_PUBLIC_BEARER` and `FOO_TOKEN` hit, `MEMEX_MAX_TOKENS`-style
 * budget knobs deliberately do NOT (TOKENS ≠ TOKEN).
 */
export function isSensitiveConfigKey(key: string): boolean {
  return /(?:^|[._-])(?:key|secret|token|password|pwd|passwd|auth|bearer|credential)(?:[._-]|$)/i.test(
    key,
  );
}

export function redactConfigValue(key: string, value: string): string {
  if (/postgres(?:ql)?:\/\//i.test(value)) {
    return value.replace(/(postgres(?:ql)?:\/\/[^:@/]+:)([^@]+)(@)/gi, "$1***$3");
  }
  if (isSensitiveConfigKey(key)) return "***";
  return value;
}

export interface RuntimeConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

export async function getRuntimeConfig(
  engine: Engine,
  key: string,
): Promise<string | null> {
  const r = await engine.query<{ value: string }>(
    `SELECT value FROM runtime_config WHERE key = $1`,
    [key],
  );
  return r.rows[0]?.value ?? null;
}

export async function setRuntimeConfig(
  engine: Engine,
  key: string,
  value: string,
): Promise<void> {
  await engine.query(
    `INSERT INTO runtime_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

/** Delete one key. Returns the number of rows removed (0 or 1). */
export async function unsetRuntimeConfig(
  engine: Engine,
  key: string,
): Promise<number> {
  const r = await engine.query<{ key: string }>(
    `DELETE FROM runtime_config WHERE key = $1 RETURNING key`,
    [key],
  );
  return r.rows.length;
}

/** List rows, optionally filtered to a key prefix, key-ordered. */
export async function listRuntimeConfig(
  engine: Engine,
  prefix?: string,
): Promise<RuntimeConfigRow[]> {
  if (prefix !== undefined && prefix.length > 0) {
    // Escape LIKE metacharacters so a literal '_' in the prefix stays literal.
    const escaped = prefix.replace(/([\\%_])/g, "\\$1");
    const r = await engine.query<RuntimeConfigRow>(
      `SELECT key, value, updated_at::text AS updated_at
         FROM runtime_config WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`,
      [escaped + "%"],
    );
    return r.rows;
  }
  const r = await engine.query<RuntimeConfigRow>(
    `SELECT key, value, updated_at::text AS updated_at
       FROM runtime_config ORDER BY key`,
  );
  return r.rows;
}

/**
 * Project stored MEMEX_* keys onto `process.env` — only where the real
 * environment left the var unset, so a container-level env always wins.
 * Returns the keys applied. Fail-open (missing table mid-migration, transient
 * DB error → no overlay): DB config is an overlay, never a boot dependency.
 * Kill switch: MEMEX_NO_DB_CONFIG=1 skips entirely.
 */
export async function applyRuntimeEnvOverlay(engine: Engine): Promise<string[]> {
  if (process.env["MEMEX_NO_DB_CONFIG"] === "1") return [];
  try {
    const rows = await listRuntimeConfig(engine, "MEMEX_");
    const applied: string[] = [];
    for (const row of rows) {
      if (!isRuntimeConfigKey(row.key)) continue;
      if (process.env[row.key] !== undefined) continue;
      process.env[row.key] = row.value;
      applied.push(row.key);
    }
    return applied;
  } catch {
    return [];
  }
}
