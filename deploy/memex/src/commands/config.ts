/**
 * `memex config <show|get|set|unset>` — DB-plane runtime config (migration
 * 088). Mutates MEMEX_* knobs without a redeploy: rows overlay onto
 * process.env at every Storage.init for vars the container did not set (env
 * always wins). The write substrate behind `memex search tune --apply`.
 *
 *   show                       list all stored keys (values redacted)
 *   get <key>                  print the raw value (exit 1 when missing)
 *   set <key> <value> [--force]
 *                              upsert; keys must match ^MEMEX_[A-Z0-9_]+$
 *                              unless --force (forward-compat escape hatch)
 *   unset <key>                delete one key
 *   unset --pattern <prefix>   delete every key with this prefix
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  getRuntimeConfig,
  setRuntimeConfig,
  unsetRuntimeConfig,
  listRuntimeConfig,
  isRuntimeConfigKey,
  redactConfigValue,
} from "../core/runtime-config.ts";

export type ConfigSub = "show" | "get" | "set" | "unset";

export interface ConfigCmdOptions {
  sub: ConfigSub;
  key?: string;
  value?: string;
  /** `unset --pattern <prefix>` bulk delete. */
  pattern?: string;
  /** Allow a key outside the MEMEX_* alphabet on `set`. */
  force?: boolean;
  /** Test seam — config file path (same idiom as runCall). */
  configPath?: string;
}

export async function runConfig(opts: ConfigCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  await storage.init();
  const engine = storage.engine();
  try {
    switch (opts.sub) {
      case "show": {
        const rows = await listRuntimeConfig(engine);
        console.log(
          JSON.stringify(
            {
              ok: true,
              count: rows.length,
              entries: rows.map((r) => ({
                key: r.key,
                value: redactConfigValue(r.key, r.value),
                updated_at: r.updated_at,
              })),
              note: "container env always wins over these; serve picks changes up on restart",
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "get": {
        if (!opts.key) {
          console.error("memex config get: <key> is required");
          return 1;
        }
        const v = await getRuntimeConfig(engine, opts.key);
        if (v === null) {
          console.error(`memex config: key not found: ${opts.key}`);
          return 1;
        }
        console.log(v);
        return 0;
      }
      case "set": {
        if (!opts.key || opts.value === undefined) {
          console.error("memex config set: <key> <value> are required");
          return 1;
        }
        if (!isRuntimeConfigKey(opts.key)) {
          if (!opts.force) {
            console.error(
              `memex config: key '${opts.key}' is outside the MEMEX_[A-Z0-9_]+ knob alphabet.\n` +
                `Nothing in memex reads a non-MEMEX_* key from the DB plane. ` +
                `Re-run with --force if this is deliberate (downstream tooling).`,
            );
            return 1;
          }
          console.error(
            `memex config: WARN — writing non-standard key '${opts.key}' with --force; ` +
              `it will NOT be overlaid onto the environment.`,
          );
        }
        await setRuntimeConfig(engine, opts.key, opts.value);
        console.log(`Set ${opts.key} = ${redactConfigValue(opts.key, opts.value)}`);
        return 0;
      }
      case "unset": {
        if (opts.pattern !== undefined) {
          if (opts.pattern.length === 0) {
            console.error("memex config unset: --pattern needs a non-empty prefix");
            return 1;
          }
          const rows = await listRuntimeConfig(engine, opts.pattern);
          let deleted = 0;
          for (const r of rows) deleted += await unsetRuntimeConfig(engine, r.key);
          console.log(
            JSON.stringify(
              { ok: true, deleted, keys: rows.map((r) => r.key) },
              null,
              2,
            ),
          );
          return 0;
        }
        if (!opts.key) {
          console.error("memex config unset: <key> or --pattern <prefix> is required");
          return 1;
        }
        const n = await unsetRuntimeConfig(engine, opts.key);
        if (n === 0) {
          console.error(`memex config: key not found: ${opts.key}`);
          return 1;
        }
        console.log(`Unset ${opts.key}`);
        return 0;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memex config: unknown subcommand '${_exhaustive}'`);
      }
    }
  } finally {
    await storage.close();
  }
}
