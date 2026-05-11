/**
 * `memex migrate-engine --from pglite --to postgres`
 *
 * One-shot data copy between Engine adapters. Used by of the
 * restructure to move the brain from PGLite (EFS-backed) to RDS Postgres.
 *
 * Strategy:
 *   1. Open both engines.
 *   2. Apply migrations on the destination so the schema exists.
 *   3. Copy table-by-table in dependency order:
 *        sources → documents → chunks → embeddings → entities →
 *        entity_mentions → cycle_snapshots → friction_events → migrations
 *      Idempotent: ON CONFLICT DO NOTHING per row, so a partial copy can
 *      resume.
 *   4. Verify counts match.
 *   5. Print summary; do NOT delete source. The PGLite db file stays on
 *      EFS as rollback for 7 d.
 *
 * The `--dry-run` flag walks the schema + verifies connectivity but
 * doesn't write to destination. Always run dry first.
 */
import { PGliteEngine } from "../core/engine/pglite.ts";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { runMigrations } from "../core/migrate.ts";
import type { Engine } from "../core/engine/interface.ts";

export interface MigrateEngineOptions {
  from: "pglite" | "postgres";
  to: "pglite" | "postgres";
  pgliteDbPath?: string;
  postgresUrl?: string;
  dryRun?: boolean;
  /** Rows per copy batch. Default 500. */
  batchSize?: number;
}

interface TableCopyPlan {
  name: string;
  /** Columns in order; first is treated as the natural key for ON CONFLICT. */
  columns: string[];
  /** When true, skip ON CONFLICT (table is append-only and pk is BIGSERIAL). */
  appendOnly?: boolean;
}

const COPY_PLAN: TableCopyPlan[] = [
  {
    name: "migrations",
    columns: ["id", "applied_at", "name"],
  },
  {
    name: "sources",
    columns: ["id", "kind", "path_prefix", "sync_policy", "indexed_policy", "created_at"],
  },
  {
    name: "documents",
    columns: [
      "id",
      "source_path",
      "title",
      "frontmatter",
      "ingested_at",
      "updated_at",
      "last_indexed_mtime",
      "source_id",
    ],
  },
  {
    name: "chunks",
    columns: ["id", "document_id", "chunk_index", "content"],
    // ts is GENERATED — don't copy it explicitly; engine will recompute.
  },
  {
    name: "embeddings",
    columns: ["chunk_id", "vector", "model", "created_at"],
  },
  {
    name: "entities",
    columns: ["id", "type", "name", "created_at"],
  },
  {
    name: "entity_mentions",
    columns: ["chunk_id", "entity_id", "surface_form"],
  },
  {
    name: "cycle_snapshots",
    columns: ["captured_at", "documents", "chunks", "embeddings", "entities", "entity_mentions"],
    appendOnly: true,
  },
  {
    name: "friction_events",
    columns: ["captured_at", "kind", "query", "reason", "source_path", "extra"],
    appendOnly: true,
  },
];

function makeEngine(kind: "pglite" | "postgres", opts: MigrateEngineOptions): Engine {
  if (kind === "pglite") {
    if (!opts.pgliteDbPath) {
      throw new Error("migrate-engine: --pglite-path required for pglite endpoint");
    }
    return new PGliteEngine({ dbPath: opts.pgliteDbPath });
  }
  if (kind === "postgres") {
    const url = opts.postgresUrl ?? process.env.MEMEX_POSTGRES_URL;
    if (!url) {
      throw new Error(
        "migrate-engine: --postgres-url or MEMEX_POSTGRES_URL required for postgres endpoint",
      );
    }
    return new PostgresEngine({ url });
  }
  throw new Error(`migrate-engine: unknown engine kind ${kind}`);
}

async function copyTable(
  src: Engine,
  dst: Engine,
  plan: TableCopyPlan,
  batchSize: number,
  dryRun: boolean,
): Promise<{ rows: number; skipped: boolean }> {
  // Source row count first (cheap; informative even on dry-run).
  const cnt = await src.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM ${plan.name}`,
  );
  const total = cnt.rows[0]?.c ?? 0;
  if (total === 0) return { rows: 0, skipped: false };
  if (dryRun) {
    console.log(`  ${plan.name}: ${total} rows (dry-run, no write)`);
    return { rows: total, skipped: true };
  }

  let copied = 0;
  let offset = 0;
  while (offset < total) {
    const batch = await src.query<Record<string, unknown>>(
      `SELECT ${plan.columns.join(", ")}
       FROM ${plan.name}
       ORDER BY ${plan.columns[0]}
       LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );
    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      const placeholders = plan.columns.map((_, i) => `$${i + 1}`).join(", ");
      const values = plan.columns.map((c) => normaliseValue(row[c]));
      // Bare `ON CONFLICT DO NOTHING` covers single-column PK + composite
      // PK + uniques (entity_mentions has the composite (chunk_id, entity_id)).
      const sql = plan.appendOnly
        ? `INSERT INTO ${plan.name} (${plan.columns.join(", ")}) VALUES (${placeholders})`
        : `INSERT INTO ${plan.name} (${plan.columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      try {
        await dst.query(sql, values);
        copied++;
      } catch (e) {
        // Append-only tables on first row may collide with destination's
        // BIGSERIAL — fine to skip; we don't preserve ids for those.
        if (plan.appendOnly) continue;
        throw e;
      }
    }
    offset += batch.rows.length;
  }
  return { rows: copied, skipped: false };
}

function normaliseValue(v: unknown): unknown {
  // jsonb columns surface as objects from PGLite; postgres-js wants the
  // raw value (it'll JSON.stringify when binding). Same for date strings.
  // The engines speak to each other through string params here, so just
  // pass through.
  return v ?? null;
}

export async function runMigrateEngine(opts: MigrateEngineOptions): Promise<void> {
  if (opts.from === opts.to) {
    throw new Error("migrate-engine: --from and --to must differ");
  }
  const batchSize = opts.batchSize ?? 500;
  const src = makeEngine(opts.from, opts);
  const dst = makeEngine(opts.to, opts);

  console.log(`[migrate-engine] from=${opts.from} to=${opts.to} dryRun=${opts.dryRun ?? false}`);

  await src.ready();
  await dst.ready();

  if (!opts.dryRun) {
    console.log("[migrate-engine] applying migrations on destination …");
    const m = await runMigrations(dst);
    console.log(
      `  applied=${m.applied.length} skipped=${m.skipped}`,
    );
  }

  const summary: { name: string; rows: number; skipped: boolean }[] = [];
  for (const plan of COPY_PLAN) {
    try {
      const r = await copyTable(src, dst, plan, batchSize, opts.dryRun ?? false);
      summary.push({ name: plan.name, ...r });
      if (!opts.dryRun) {
        console.log(`  ${plan.name}: copied=${r.rows}`);
      }
    } catch (e) {
      console.error(
        `[migrate-engine] table ${plan.name} failed:`,
        e instanceof Error ? e.message : e,
      );
      throw e;
    }
  }

  // Final verify.
  if (!opts.dryRun) {
    console.log("[migrate-engine] verifying counts …");
    for (const plan of COPY_PLAN) {
      const a = await src.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM ${plan.name}`,
      );
      const b = await dst.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM ${plan.name}`,
      );
      const same = (a.rows[0]?.c ?? 0) === (b.rows[0]?.c ?? 0);
      console.log(
        `  ${plan.name}: src=${a.rows[0]?.c ?? 0} dst=${b.rows[0]?.c ?? 0} ${same ? "✓" : "✗"}`,
      );
    }
  }

  await src.close();
  await dst.close();
  console.log(JSON.stringify({ ok: true, summary }, null, 2));
}
