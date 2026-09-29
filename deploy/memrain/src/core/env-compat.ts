/**
 * Legacy env names: every `MEMEX_X` in the process environment is also made
 * available as `MEMRAIN_X`, once, before any other module reads the env.
 *
 * This module has no imports on purpose. It is the first import of every
 * entry point (`src/cli.ts` and the standalone scripts), so ESM evaluates it
 * before anything else, including `version.ts`, the one module that reads the
 * env at import time.
 *
 * Rules, per legacy key `MEMEX_X` with new name `MEMRAIN_X`:
 *   - `MEMRAIN_X` non-empty: it wins; a different non-empty legacy value is
 *     recorded as a conflict.
 *   - otherwise a non-empty legacy value is copied.
 *   - an EMPTY legacy value is copied only when `MEMRAIN_X` is absent, so
 *     "present but empty" keeps its meaning for readers that test `!== undefined`.
 *
 * Only names are recorded, never values.
 */

export const LEGACY_ENV_PREFIX = "MEMEX_";
export const ENV_PREFIX = "MEMRAIN_";

const LEGACY_KEY_RE = /^MEMEX_([A-Z0-9_]+)$/;

export interface LegacyEnvReport {
  /** New names whose value came from the legacy name. */
  readonly mapped: readonly string[];
  /** New names whose legacy twin held a different non-empty value. */
  readonly conflicts: readonly string[];
}

/** Apply the mapping to `env` in place and report what it did. */
export function mapLegacyEnv(env: Record<string, string | undefined>): LegacyEnvReport {
  const mapped: string[] = [];
  const conflicts: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const m = LEGACY_KEY_RE.exec(key);
    if (!m) continue;
    const name = ENV_PREFIX + m[1];
    const legacy = env[key];
    const cur = env[name];
    if (cur !== undefined && cur !== "") {
      if (legacy !== undefined && legacy !== "" && legacy !== cur) conflicts.push(name);
    } else if (legacy !== undefined && legacy !== "") {
      env[name] = legacy;
      mapped.push(name);
    } else if (cur === undefined && legacy === "") {
      env[name] = "";
      mapped.push(name);
    }
  }
  return Object.freeze({
    mapped: Object.freeze(mapped),
    conflicts: Object.freeze(conflicts),
  });
}

/** What the mapping did to this process's environment at startup. */
export const legacyEnv: LegacyEnvReport = mapLegacyEnv(process.env);

/** The serve boot line (names only), or null when no legacy name is in use. */
export function legacyEnvBootLine(report: LegacyEnvReport): string | null {
  if (report.mapped.length === 0 && report.conflicts.length === 0) return null;
  const names = report.conflicts.length > 0 ? `: ${report.conflicts.join(", ")}` : "";
  return (
    `[memrain] ${report.mapped.length} legacy MEMEX_* env vars mapped; ` +
    `${report.conflicts.length} conflicts (MEMRAIN_ wins)${names}`
  );
}
