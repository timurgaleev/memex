/**
 * `memex init [--pglite]` — bootstraps a fresh memex instance.
 *
 * Creates ~/.memex/ (mode 0700), writes config.json, opens the PGLite
 * database, and applies initial migrations. Idempotent: if config.json
 * already exists, prints a notice and exits 0 without touching anything.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../core/storage.ts";
import type { Config } from "../core/config.ts";
import { awsRegion } from "../core/llm/gateway.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "..", "templates");

/**
 * Copy each `<name>.md.template` from templates/ into the config dir
 * as `<name>.md`, substituting {{NOW}} with the current ISO timestamp.
 * Idempotent — files that already exist are left untouched.
 */
function seedTemplates(configDir: string): string[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const now = new Date().toISOString();
  const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".md.template"));
  const written: string[] = [];
  for (const f of files) {
    const target = join(configDir, f.replace(".md.template", ".md"));
    if (existsSync(target)) continue;
    const tpl = readFileSync(join(TEMPLATES_DIR, f), "utf8").replaceAll(
      "{{NOW}}",
      now,
    );
    writeFileSync(target, tpl);
    chmodSync(target, 0o600);
    written.push(target);
  }
  return written;
}

export interface InitOptions {
  /** Local PGLite backend (the default for laptop installs). */
  pglite: boolean;
  /**
   * Postgres backend: writes `database.type=postgres` and lets the URL come
   * from `MEMEX_POSTGRES_URL` env at serve time (migrations run at server
   * boot). Without this, a fresh volume gets a pglite config and the env URL
   * is silently ignored — the engine factory only consults it when the
   * config already says postgres.
   */
  postgres?: boolean;
  /** Optional override of the config dir (testing). */
  configDir?: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  if (opts.pglite === Boolean(opts.postgres)) {
    throw new Error("memex init: pass exactly one of --pglite or --postgres");
  }

  const configDir = opts.configDir ?? join(homedir(), ".memex");
  const configPath = join(configDir, "config.json");
  const dbPath = join(configDir, "brain.pglite");

  if (existsSync(configPath)) {
    // Postgres mode heals a pglite config left by an earlier init: the
    // operator's intent (MEMEX_POSTGRES_URL / --postgres) must win, or the
    // brain keeps writing to the local dev database while RDS sits empty —
    // the silent-wrong-engine trap this flag exists to close.
    if (opts.postgres) {
      const existing = JSON.parse(readFileSync(configPath, "utf8")) as {
        database?: { type?: string };
      };
      const priorType = existing.database?.type ?? "unset";
      if (priorType !== "postgres") {
        existing.database = { type: "postgres" };
        writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
        console.log(
          `[memex] switched database.type to postgres at ${configPath} ` +
            `(was ${priorType} — --postgres/MEMEX_POSTGRES_URL wins)`,
        );
      }
    }
    // Idempotent: still seed any new templates that didn't exist before
    // (so adding a new template ships its instance on next container
    // start without needing a full re-init).
    const seeded = seedTemplates(configDir);
    console.log(`[memex] already initialized at ${configPath}`);
    if (seeded.length > 0) {
      console.log(`  templates seeded: ${seeded.length}`);
      for (const t of seeded) console.log(`              + ${t}`);
    }
    return;
  }

  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // mkdirSync may not apply mode on existing dirs; force it.
  chmodSync(configDir, 0o700);

  const config: Config = {
    database: opts.postgres
      ? // URL deliberately omitted: MEMEX_POSTGRES_URL env is the canonical
        // source on a server (populated by fetch-secrets.sh) and the engine
        // factory prefers it. Migrations run at serve boot.
        { type: "postgres" }
      : { type: "pglite", path: dbPath },
    embedding: {
      provider: "bedrock-titan",
      model: "amazon.titan-embed-text-v2:0",
      region: awsRegion(),
    },
    storage: {},
  } as Config;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  let migrationsLine = "deferred to serve boot (postgres)";
  if (!opts.postgres) {
    // Open the PGLite db once to apply migrations, then close.
    const storage = new Storage({ dbPath });
    const result = await storage.init();
    await storage.close();
    migrationsLine = `${result.applied.length} applied, ${result.skipped} skipped`;
    for (const m of result.applied) {
      migrationsLine += `\n              + ${String(m.id).padStart(3, "0")}_${m.name}`;
    }
  }

  const seeded = seedTemplates(configDir);

  console.log(`[memex] initialized:`);
  console.log(`  config:     ${configPath}`);
  console.log(`  db:         ${opts.postgres ? "postgres (URL from MEMEX_POSTGRES_URL env)" : dbPath}`);
  console.log(`  migrations: ${migrationsLine}`);
  if (seeded.length > 0) {
    console.log(`  templates:  ${seeded.length} seeded`);
    for (const t of seeded) console.log(`              + ${t}`);
  }
}
