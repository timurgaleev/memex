/**
 * Ops-facing brain-health probes for `memex doctor`: stale cycle locks, job
 * queue depth/wedge, applied-vs-available schema version, and embedding-width
 * consistency. Each returns {ok, detail}; the caller swallows a probe error
 * into a WARN. All read-only, config-free, no LLM — the substrate already
 * exists (cycle_locks mig 050, jobs mig 006, migrations table, vector(N)).
 */
import type { Engine } from "./engine/interface.ts";
import { discoverMigrations } from "./migrate.ts";
import { EMBED_DIMENSIONS } from "./embedding.ts";

export interface OpsCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * Cycle locks whose TTL has elapsed but whose row is still present — an
 * orphaned holder (a crashed cycle). Reclaimed on the next acquire via the TTL
 * fallback, so this is informational (ok:true) unless one persists run to run.
 */
export async function checkStaleLocks(engine: Engine): Promise<OpsCheckResult> {
  const r = await engine.query<{ n: number; oldest: string | null }>(
    `SELECT count(*)::int AS n,
            to_char(MIN(ttl_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest
       FROM cycle_locks WHERE ttl_expires_at < NOW()`,
  );
  const n = r.rows[0]?.n ?? 0;
  return {
    ok: true,
    detail:
      n === 0
        ? "no stale cycle locks"
        : `${n} cycle lock(s) past TTL (oldest expired ${r.rows[0]?.oldest}) — reclaimed on next acquire`,
  };
}

function jobWedgeSeconds(): number {
  const n = Number.parseInt(process.env.MEMEX_DOCTOR_JOB_WEDGE_SEC ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/**
 * Job queue depth + wedged-job count (a `running` job older than the wedge
 * threshold, default 1h via MEMEX_DOCTOR_JOB_WEDGE_SEC). A deep pending queue is
 * normal mid-backfill (informational); a wedged job is the signal to look. Only
 * a wedged job flips ok:false.
 */
export async function checkQueueHealth(engine: Engine): Promise<OpsCheckResult> {
  const wedgeSec = jobWedgeSeconds();
  const r = await engine.query<{
    pending: number;
    running: number;
    wedged: number;
  }>(
    `SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'running'
                         AND started_at IS NOT NULL
                         AND started_at < NOW() - $1 * INTERVAL '1 second')::int AS wedged
       FROM jobs`,
    [wedgeSec],
  );
  const pending = r.rows[0]?.pending ?? 0;
  const running = r.rows[0]?.running ?? 0;
  const wedged = r.rows[0]?.wedged ?? 0;
  return {
    ok: wedged === 0,
    detail:
      `pending=${pending} running=${running}` +
      (wedged > 0 ? ` — ${wedged} wedged (running > ${wedgeSec}s)` : ""),
  };
}

/**
 * Applied vs available schema version: the highest migration id recorded in the
 * `migrations` table against the highest migration file on disk. Unapplied
 * migrations flip ok:false — a real, actionable drift (run `memex migrate`).
 */
export async function checkSchemaVersion(
  engine: Engine,
): Promise<OpsCheckResult> {
  const r = await engine.query<{ hi: number | null; n: number }>(
    `SELECT MAX(id)::int AS hi, count(*)::int AS n FROM migrations`,
  );
  const applied = r.rows[0]?.hi ?? 0;
  const appliedCount = r.rows[0]?.n ?? 0;
  let available = applied;
  try {
    const ids = discoverMigrations().map((m) => m.id);
    if (ids.length > 0) available = Math.max(...ids);
  } catch {
    // Can't read the migrations dir (packaged oddly) — report applied only.
  }
  const pending = available > applied;
  return {
    ok: !pending,
    detail: pending
      ? `schema at migration ${applied} (${appliedCount} applied) — ${available - applied} unapplied through ${available}; run \`memex migrate\``
      : `schema at migration ${applied} (${appliedCount} applied), up to date`,
  };
}

/**
 * Invalid indexes: any index left `indisvalid = false` — the fingerprint of a
 * failed or interrupted build (a killed `CREATE INDEX CONCURRENTLY`, or an OOM
 * mid-build, which memex has a live history of). Postgres keeps such an index
 * present but NEVER uses it for query planning, so the HNSW vector arm (or any
 * indexed lookup) silently falls back to a sequential scan with no error — a
 * quiet retrieval-quality regression. Flips ok:false so it surfaces in `doctor`
 * instead of hiding as slow searches. Recover by rebuilding the index (a manual
 * `CREATE INDEX CONCURRENTLY` + drop of the invalid one). Read-only.
 */
export async function checkInvalidIndexes(
  engine: Engine,
): Promise<OpsCheckResult> {
  const r = await engine.query<{ indexname: string; tablename: string }>(
    `SELECT c.relname AS indexname, t.relname AS tablename
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisvalid = false
        AND n.nspname = 'public'
      ORDER BY c.relname`,
  );
  const bad = r.rows;
  if (bad.length === 0) {
    return { ok: true, detail: "all indexes valid" };
  }
  const names = bad.map((b) => `${b.indexname} (on ${b.tablename})`).join(", ");
  return {
    ok: false,
    detail: `${bad.length} invalid index(es) — Postgres ignores these, so lookups silently seq-scan: ${names}. Recover with \`REINDEX INDEX CONCURRENTLY <name>\` (online, no write lock)`,
  };
}

/**
 * Embedding-width consistency: the stored vector width vs the configured
 * EMBED_DIMENSIONS (MEMEX_EMBED_DIM). The `vector(N)` column is fixed-width, so
 * a mismatch means the config was changed without migrating the column — new
 * embeds would break. Flips ok:false so the drift is visible before it bites.
 */
export async function checkEmbeddingWidth(
  engine: Engine,
): Promise<OpsCheckResult> {
  // DISTINCT across all rows (not a single unordered sample) so the result is
  // deterministic: mid dimension-migration, old- and new-width rows coexist and
  // an unordered LIMIT 1 would flicker the health signal. Surfacing >1 distinct
  // width IS the drift signal.
  const r = await engine.query<{ dims: number }>(
    `SELECT DISTINCT vector_dims(vector) AS dims
       FROM embeddings WHERE vector IS NOT NULL ORDER BY dims`,
  );
  const widths = r.rows.map((x) => x.dims);
  if (widths.length === 0) {
    return { ok: true, detail: "no embeddings yet" };
  }
  if (widths.length > 1) {
    return {
      ok: false,
      detail: `mixed embedding widths present (${widths.join(", ")}; expected ${EMBED_DIMENSIONS}) — a dimension migration is incomplete; finish the re-embed`,
    };
  }
  const stored = widths[0]!;
  const ok = stored === EMBED_DIMENSIONS;
  return {
    ok,
    detail: ok
      ? `embeddings are ${stored}-dim (matches configured ${EMBED_DIMENSIONS})`
      : `stored embeddings are ${stored}-dim but config expects ${EMBED_DIMENSIONS} — reindex or align MEMEX_EMBED_DIM`,
  };
}
