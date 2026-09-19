/**
 * `memex migrate-engine --from pglite|postgres --to pglite|postgres`
 *
 * Copies a whole brain between engines and proves the copy:
 *   1. Open both engines; apply migrations on the destination.
 *   2. Read both catalogs and copy every public table in FK order (column
 *      intersection, generated columns skipped), keyset-batched, with
 *      triggers and FK checks off so no insert rewrites a copied row.
 *      Keyed tables upsert, so a re-run resumes and converges.
 *   3. Verify each table by row count and content hash; any mismatch,
 *      missing table or failed table makes the run fail (exit 1).
 *
 * The source is only read. pglite→pglite (two paths) is allowed, which makes
 * Postgres→PGLite→Postgres a checkable rollback rehearsal.
 *
 * `--dry-run` reads catalogs and counts and writes nothing. `--verify-only`
 * runs step 3 alone against two existing databases.
 */
import { resolve } from "node:path";
import { PGliteEngine } from "../core/engine/pglite.ts";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { runMigrations } from "../core/migrate.ts";
import { copyEngine, type CopySummary } from "../core/engine-copy.ts";
import type { Engine } from "../core/engine/interface.ts";

export interface MigrateEngineOptions {
  from: "pglite" | "postgres";
  to: "pglite" | "postgres";
  /** Source PGLite path; also the destination when only one pglite endpoint is used. */
  pgliteDbPath?: string;
  /** Destination PGLite path — required for pglite→pglite. */
  toPgliteDbPath?: string;
  postgresUrl?: string;
  dryRun?: boolean;
  verifyOnly?: boolean;
  tables?: string[];
  /** Rows per copy batch. Default 500. */
  batchSize?: number;
}

export type Endpoint =
  | { kind: "pglite"; path: string }
  | { kind: "postgres"; url: string };

export function resolveEndpoints(
  opts: MigrateEngineOptions,
  env: Record<string, string | undefined> = process.env,
): { src: Endpoint; dst: Endpoint } {
  if (opts.from === opts.to && opts.from !== "pglite") {
    throw new Error("migrate-engine: --from and --to must differ (only pglite→pglite may repeat)");
  }
  const pglite = (p: string | undefined, flag: string): Endpoint => {
    if (!p) throw new Error(`migrate-engine: ${flag} required for pglite endpoint`);
    return { kind: "pglite", path: resolve(p) };
  };
  const postgresEp = (): Endpoint => {
    const url = opts.postgresUrl ?? env.MEMEX_POSTGRES_URL;
    if (!url) {
      throw new Error(
        "migrate-engine: --postgres-url or MEMEX_POSTGRES_URL required for postgres endpoint",
      );
    }
    return { kind: "postgres", url };
  };
  const src = opts.from === "pglite" ? pglite(opts.pgliteDbPath, "--pglite-path") : postgresEp();
  const dst = opts.to === "postgres"
    ? postgresEp()
    : opts.from === "pglite"
      ? pglite(opts.toPgliteDbPath, "--to-pglite-path")
      : pglite(opts.toPgliteDbPath ?? opts.pgliteDbPath, "--pglite-path");
  const same = src.kind === "pglite" && dst.kind === "pglite"
    ? src.path === dst.path
    : src.kind === "postgres" && dst.kind === "postgres" && src.url === dst.url;
  if (same) {
    throw new Error("migrate-engine: source and destination are the same database");
  }
  return { src, dst };
}

function openEngine(ep: Endpoint): Engine {
  return ep.kind === "pglite"
    ? new PGliteEngine({ dbPath: ep.path })
    : new PostgresEngine({ url: ep.url });
}

export async function runMigrateEngine(opts: MigrateEngineOptions): Promise<CopySummary> {
  const { src: srcEp, dst: dstEp } = resolveEndpoints(opts);
  const src = openEngine(srcEp);
  let dst: Engine | undefined;
  try {
    dst = openEngine(dstEp);
    const mode = opts.dryRun ? "dry-run" : opts.verifyOnly ? "verify-only" : "copy";
    console.error(`[migrate-engine] from=${opts.from} to=${opts.to} mode=${mode}`);
    await src.ready();
    await dst.ready();

    if (!opts.dryRun && !opts.verifyOnly) {
      console.error("[migrate-engine] applying migrations on destination …");
      const m = await runMigrations(dst);
      console.error(`  applied=${m.applied.length} skipped=${m.skipped}`);
    }

    const summary = await copyEngine(src, dst, {
      tables: opts.tables,
      batchSize: opts.batchSize,
      dryRun: opts.dryRun,
      verifyOnly: opts.verifyOnly,
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await src.close();
    await dst?.close();
  }
}
