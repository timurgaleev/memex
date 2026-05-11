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
  /** Currently the only supported backend; non-pglite is rejected explicitly. */
  pglite: boolean;
  /** Optional override of the config dir (testing). */
  configDir?: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  if (!opts.pglite) {
    throw new Error(
      "memex init: supports --pglite only. (Postgres backend not yet supported via init.)",
    );
  }

  const configDir = opts.configDir ?? join(homedir(), ".memex");
  const configPath = join(configDir, "config.json");
  const dbPath = join(configDir, "brain.pglite");

  if (existsSync(configPath)) {
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
    database: { type: "pglite", path: dbPath },
    embedding: {
      provider: "bedrock-titan",
      model: "amazon.titan-embed-text-v2:0",
      region: process.env.AWS_REGION ?? "eu-west-1",
    },
    storage: {},
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Open the PGLite db once to apply migrations, then close.
  const storage = new Storage({ dbPath });
  const result = await storage.init();
  await storage.close();

  const seeded = seedTemplates(configDir);

  console.log(`[memex] initialized:`);
  console.log(`  config:     ${configPath}`);
  console.log(`  db:         ${dbPath}`);
  console.log(
    `  migrations: ${result.applied.length} applied, ${result.skipped} skipped`,
  );
  for (const m of result.applied) {
    console.log(`              + ${String(m.id).padStart(3, "0")}_${m.name}`);
  }
  if (seeded.length > 0) {
    console.log(`  templates:  ${seeded.length} seeded`);
    for (const t of seeded) console.log(`              + ${t}`);
  }
}
