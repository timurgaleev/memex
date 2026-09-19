/**
 * Sources — first-class metadata layer above the documents table.
 *
 * A source declares:
 *   - kind: what *type* of thing it is (vault / memory / webhook / …).
 *   - path_prefix: the longest filesystem path prefix shared by docs
 *     belonging to it. Used to backfill and to pick the source for a
 *     freshly indexed document.
 *   - sync_policy: how the underlying content moves between disks
 *     (`synced` round-trips through an external file sync, `local-only`
 *     never does, `mirror` is one-way push to a remote).
 *   - indexed_policy: how much of the content to keep in our index
 *     (`verbatim` chunk text in DB, `hashed-only` privacy mode,
 *     `tombstoned` retains metadata only).
 *
 * wires this in. Phases 5+ honour it (search source-boost,
 * cycle skips tombstoned sources, etc.).
 */
import type { Engine } from "./engine/interface.ts";
import { bumpDocumentClock } from "./generation.ts";
import { NO_SOURCE_SENTINEL } from "./auth-info.ts";

export type SourceKind =
  | "vault"
  | "memory"
  | "webhook"
  | "mailbox"
  | "calendar"
  | "transcript"
  | "code"
  | "github"
  | "other";

export const SOURCE_KINDS: readonly SourceKind[] = [
  "vault",
  "memory",
  "webhook",
  "mailbox",
  "calendar",
  "transcript",
  "code",
  "github",
  "other",
];

export type SyncPolicy = "synced" | "local-only" | "mirror";
export type IndexedPolicy = "verbatim" | "hashed-only" | "tombstoned";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  path_prefix: string;
  sync_policy: SyncPolicy;
  indexed_policy: IndexedPolicy;
  rate_limit_per_minute: number;
  respect_quiet_hours: boolean;
  boost_weight: number;
  description: string | null;
}

export interface RegisterSourceOptions {
  id: string;
  kind: SourceKind;
  pathPrefix: string;
  syncPolicy?: SyncPolicy;
  indexedPolicy?: IndexedPolicy;
  rateLimitPerMinute?: number;
  respectQuietHours?: boolean;
  boostWeight?: number;
  description?: string | null;
}

const SELECT_COLS =
  "id, kind, path_prefix, sync_policy, indexed_policy, " +
  "rate_limit_per_minute, respect_quiet_hours, boost_weight, description";

interface RawSourceRow extends Omit<SourceRow, "boost_weight"> {
  boost_weight: number | string;
}

function rowToSource(r: RawSourceRow): SourceRow {
  return {
    ...r,
    boost_weight: Number(r.boost_weight),
  };
}

/**
 * An empty prefix prefixes every path, so that source would claim every
 * document the next sweep classifies.
 */
function assertPathPrefix(pathPrefix: string): void {
  if (pathPrefix.trim() === "") {
    throw new Error("source: pathPrefix must not be empty");
  }
}

export async function registerSource(
  engine: Engine,
  opts: RegisterSourceOptions,
): Promise<SourceRow> {
  // The no-grant sentinel must never name a real source, or a caller denied
  // every source would read that one.
  if (opts.id === NO_SOURCE_SENTINEL) {
    throw new Error(`registerSource: "${NO_SOURCE_SENTINEL}" is reserved`);
  }
  assertPathPrefix(opts.pathPrefix);
  const r = await engine.query<RawSourceRow>(
    `INSERT INTO sources (
       id, kind, path_prefix, sync_policy, indexed_policy,
       rate_limit_per_minute, respect_quiet_hours, boost_weight, description
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       path_prefix = EXCLUDED.path_prefix,
       sync_policy = EXCLUDED.sync_policy,
       indexed_policy = EXCLUDED.indexed_policy,
       rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
       respect_quiet_hours = EXCLUDED.respect_quiet_hours,
       boost_weight = EXCLUDED.boost_weight,
       description = EXCLUDED.description
     RETURNING ${SELECT_COLS}`,
    [
      opts.id,
      opts.kind,
      opts.pathPrefix,
      opts.syncPolicy ?? "synced",
      opts.indexedPolicy ?? "verbatim",
      opts.rateLimitPerMinute ?? 60,
      opts.respectQuietHours ?? false,
      opts.boostWeight ?? 1.0,
      opts.description ?? null,
    ],
  );
  if (!r.rows[0]) throw new Error(`registerSource: insert returned no row for ${opts.id}`);
  return rowToSource(r.rows[0]);
}

export interface ListSourcesOptions {
  kind?: SourceKind;
}

export async function listSources(
  engine: Engine,
  opts: ListSourcesOptions = {},
): Promise<SourceRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (opts.kind) {
    params.push(opts.kind);
    where = `WHERE kind = $${params.length}`;
  }
  const r = await engine.query<RawSourceRow>(
    `SELECT ${SELECT_COLS} FROM sources ${where} ORDER BY path_prefix`,
    params,
  );
  return r.rows.map(rowToSource);
}

export async function getSource(
  engine: Engine,
  id: string,
): Promise<SourceRow | null> {
  const r = await engine.query<RawSourceRow>(
    `SELECT ${SELECT_COLS} FROM sources WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? rowToSource(r.rows[0]) : null;
}

export interface UpdateSourceOptions {
  id: string;
  kind?: SourceKind;
  pathPrefix?: string;
  syncPolicy?: SyncPolicy;
  indexedPolicy?: IndexedPolicy;
  rateLimitPerMinute?: number;
  respectQuietHours?: boolean;
  boostWeight?: number;
  description?: string | null;
}

export async function updateSource(
  engine: Engine,
  opts: UpdateSourceOptions,
): Promise<SourceRow | null> {
  // Build a partial SET clause from defined fields only — keeps the
  // call site narrow ("only the boost weight changed") and avoids
  // round-tripping unset values that would erase prior state.
  const sets: string[] = [];
  const params: unknown[] = [opts.id];
  function add(col: string, value: unknown): void {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (opts.kind !== undefined) add("kind", opts.kind);
  if (opts.pathPrefix !== undefined) {
    assertPathPrefix(opts.pathPrefix);
    add("path_prefix", opts.pathPrefix);
  }
  if (opts.syncPolicy !== undefined) add("sync_policy", opts.syncPolicy);
  if (opts.indexedPolicy !== undefined) add("indexed_policy", opts.indexedPolicy);
  if (opts.rateLimitPerMinute !== undefined)
    add("rate_limit_per_minute", opts.rateLimitPerMinute);
  if (opts.respectQuietHours !== undefined)
    add("respect_quiet_hours", opts.respectQuietHours);
  if (opts.boostWeight !== undefined) add("boost_weight", opts.boostWeight);
  if (opts.description !== undefined) add("description", opts.description);
  if (sets.length === 0) return getSource(engine, opts.id);
  const r = await engine.query<RawSourceRow>(
    `UPDATE sources SET ${sets.join(", ")} WHERE id = $1 RETURNING ${SELECT_COLS}`,
    params,
  );
  return r.rows[0] ? rowToSource(r.rows[0]) : null;
}

/** The fallback tenant: legacy credentials with no grant resolve to it. */
const FALLBACK_SOURCE = "default";

/**
 * Everything that still points at a source, by kind. Content rows and client
 * rows would block a DELETE through their foreign keys; grants would not —
 * oauth codes, tokens, enrollments and PAT permissions name the source without
 * a foreign key, so deleting it would leave a live credential scoped to a
 * missing tenant. `default` is never deletable: credentials with no grant fall
 * back to it.
 */
export async function sourceReferences(engine: Engine, id: string): Promise<Record<string, number>> {
  const r = await engine.query<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE source_id = $1)::int AS documents,
       (SELECT COUNT(*) FROM pages WHERE source_id = $1)::int AS pages,
       (SELECT COUNT(*) FROM page_versions WHERE source_id = $1)::int AS page_versions,
       (SELECT COUNT(*) FROM entity_facts WHERE source_id = $1)::int AS facts,
       (SELECT COUNT(*) FROM links WHERE source_id = $1)::int AS links,
       (SELECT COUNT(*) FROM tags WHERE source_id = $1)::int AS tags,
       (SELECT COUNT(*) FROM timeline_events WHERE source_id = $1)::int AS timeline_events,
       (SELECT COUNT(*) FROM synth_calibration_profile WHERE source_id = $1)::int AS calibration_profiles,
       -- Revoked clients count too: their row keeps a RESTRICT foreign key.
       (SELECT COUNT(*) FROM oauth_clients
         WHERE source_id = $1 OR $1 = ANY(federated_read))::int AS oauth_clients,
       (SELECT COUNT(*) FROM oauth_tokens
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > EXTRACT(EPOCH FROM NOW()))
           AND (source_id = $1 OR $1 = ANY(COALESCE(federated_read, '{}'))))::int AS oauth_tokens,
       (SELECT COUNT(*) FROM oauth_codes
         WHERE expires_at > EXTRACT(EPOCH FROM NOW())
           AND (source_id = $1 OR $1 = ANY(COALESCE(federated_read, '{}'))))::int AS oauth_codes,
       (SELECT COUNT(*) FROM oauth_enrollments
         WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
           AND (source_id = $1 OR $1 = ANY(federated_read)))::int AS enrollments,
       -- Some rows hold permissions double-encoded as a JSON string; the token
       -- verifier accepts that shape, so the count must see through it too.
       (SELECT COUNT(*) FROM access_tokens
         WHERE revoked_at IS NULL
           AND (CASE WHEN jsonb_typeof(permissions) = 'string'
                     THEN (permissions #>> '{}')::jsonb
                     ELSE permissions END) -> 'source_id' @> to_jsonb($1::text))::int AS personal_tokens`,
    [id],
  );
  const row = r.rows[0] ?? {};
  const refs = Object.fromEntries(Object.entries(row).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, Number(n)]));
  return id === FALLBACK_SOURCE ? { fallback_source: 1, ...refs } : refs;
}

const FOREIGN_KEY_VIOLATION = "23503";

export async function deleteSource(
  engine: Engine,
  id: string,
): Promise<boolean> {
  // Refuse while anything still references the source; the caller reassigns,
  // revokes or unsets first (`sourceReferences` says what). The grant tables are
  // locked for the check-and-delete so a token minted mid-way cannot slip past.
  try {
    return await engine.transaction(async (tx) => {
      await tx.query(
        `LOCK TABLE oauth_clients, oauth_tokens, oauth_codes, oauth_enrollments, access_tokens IN SHARE ROW EXCLUSIVE MODE`,
      );
      if (Object.keys(await sourceReferences(tx, id)).length > 0) return false;
      const r = await tx.query<{ id: string }>(`DELETE FROM sources WHERE id = $1 RETURNING id`, [id]);
      return r.rows.length > 0;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === FOREIGN_KEY_VIOLATION) return false;
    throw err;
  }
}

/**
 * A path belongs to a prefix when the prefix covers it up to a separator:
 * an exact prefix compare (`_` and `%` in a prefix are LIKE wildcards, and the
 * `__default__` sentinel carries four), and the prefix must end at a path
 * boundary, so `/vault/a` does not own `/vault/a-shared/x.md`.
 */
const PATH_PREFIX_MATCH = `left($1, length(path_prefix)) = path_prefix
        AND (
          right(path_prefix, 1) = '/'
          OR length($1) = length(path_prefix)
          OR substr($1, length(path_prefix) + 1, 1) = '/'
        )`;

/**
 * Pick the most specific source for a given source_path: longest matching
 * path_prefix wins. Returns null if no source matches.
 */
export async function resolveSourceForPath(
  engine: Engine,
  sourcePath: string,
): Promise<string | null> {
  const r = await engine.query<{ id: string }>(
    `SELECT id FROM sources
      WHERE ${PATH_PREFIX_MATCH}
      ORDER BY length(path_prefix) DESC
      LIMIT 1`,
    [sourcePath],
  );
  return r.rows[0]?.id ?? null;
}


/**
 * Classify documents that carry no source yet, picking the most specific
 * `path_prefix` that owns their path, and hand the source down to their chunks
 * and code edges. Idempotent, and set-based because the sweeps run it after
 * every pass while documents no prefix matches stay NULL for good.
 *
 * `paths` is the provenance fence, and every caller passes one: only paths a
 * local indexer just wrote, or that a sweep confirmed already hold its own
 * newer index, are classified. Remote ingest (`index` with `sourcePath` +
 * `text`) labels a document in the CALLER's namespace — an unfenced backfill
 * would let that label pick a tenant's prefix and drop attacker-authored text
 * into that tenant's scoped reads. Pass a path only after the local write for
 * it succeeded; a path a walk merely saw says nothing about who wrote the row
 * sitting at it.
 */
export async function backfillDocumentSources(
  engine: Engine,
  paths: readonly string[],
): Promise<{ updated: number; unmatched: number }> {
  if (paths.length === 0) return { updated: 0, unmatched: 0 };
  return engine.transaction(async (tx) => {
    // `source_id` is a ranking-relevant field (source-boost weighting + the
    // scope filter on the keyword/vector arms), so changing it must invalidate
    // the two-layer query cache for the touched document: bump its `generation`
    // (Layer 2), and the global clock once (Layer 1).
    const moved = await tx.query<{ id: string }>(
      `UPDATE documents d
          SET source_id = m.source_id, generation = d.generation + 1
         FROM (
           SELECT DISTINCT ON (doc.id) doc.id AS doc_id, s.id AS source_id
             FROM documents doc
             JOIN sources s ON left(doc.source_path, length(s.path_prefix)) = s.path_prefix
              AND (
                right(s.path_prefix, 1) = '/'
                OR length(doc.source_path) = length(s.path_prefix)
                OR substr(doc.source_path, length(s.path_prefix) + 1, 1) = '/'
              )
            WHERE doc.source_id IS NULL
              AND doc.source_path = ANY($1::text[])
            ORDER BY doc.id, length(s.path_prefix) DESC
         ) m
        WHERE d.id = m.doc_id
      RETURNING d.id`,
      [paths as string[]],
    );
    // Chunks and code edges mirror their document's source; left NULL they
    // would stay invisible to the document's own scoped readers. Driven off the
    // rows' own state, not this pass's id list, so a document classified by an
    // earlier run that died before propagating is repaired here.
    const chunks = await tx.query<{ id: string }>(
      `UPDATE chunks c SET source_id = d.source_id
         FROM documents d
        WHERE c.document_id = d.id
          AND c.source_id IS NULL AND d.source_id IS NOT NULL
          AND d.source_path = ANY($1::text[])
      RETURNING c.id`,
      [paths as string[]],
    );
    const edges = await tx.query<{ id: number }>(
      `UPDATE code_edges_symbol e SET source_id = d.source_id
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE e.from_chunk_id = c.id
          AND e.source_id IS NULL AND d.source_id IS NOT NULL
          AND d.source_path = ANY($1::text[])
      RETURNING e.id`,
      [paths as string[]],
    );
    if (moved.rows.length > 0 || chunks.rows.length > 0 || edges.rows.length > 0) {
      await bumpDocumentClock(tx);
    }
    const left = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents
        WHERE source_id IS NULL AND source_path = ANY($1::text[])`,
      [paths as string[]],
    );
    return { updated: moved.rows.length, unmatched: left.rows[0]?.n ?? 0 };
  });
}
