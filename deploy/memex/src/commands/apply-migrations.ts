/**
 * `memex apply-migrations` — manual runner for pending migrations.
 *
 * Storage init already runs migrations on every boot, so this command
 * is mostly an ops/diagnostic tool: confirm the schema matches the
 * shipped migration set without restarting the daemon, or apply a
 * just-pulled migration without bouncing the container.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { runMigrations, discoverMigrations } from "../core/migrate.ts";

export interface ApplyMigrationsCmdOptions {
  /** Print the migration set without applying. Default false. */
  dryRun?: boolean;
}

export async function runApplyMigrations(
  opts: ApplyMigrationsCmdOptions = {},
): Promise<void> {
  if (opts.dryRun) {
    const files = discoverMigrations();
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          migrations: files.map((f) => ({ id: f.id, name: f.name })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const r = await runMigrations(storage.engine());
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  } finally {
    await storage.close();
  }
}
