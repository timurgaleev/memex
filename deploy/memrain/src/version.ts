/**
 * Build version. Sourced from the `MEMEX_VERSION` env stamp baked into the
 * image at build time (a `git describe --tags --always` from the deploy host) —
 * NOT package.json, which is intentionally pinned at 0.1.0. Falls back to
 * `dev` when unstamped (a plain local `bun run`).
 */
export function resolveVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.MEMEX_VERSION?.trim();
  return v && v.length > 0 ? v : "dev";
}

export const VERSION = resolveVersion();
