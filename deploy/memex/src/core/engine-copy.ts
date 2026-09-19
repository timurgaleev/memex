/**
 * Full-fidelity table copy and verification between two engines.
 *
 * The table list comes from the destination's and source's Postgres catalog,
 * not from a hand-kept list: a hardcoded plan silently fell behind the schema
 * (pages, versions, facts, links, timeline, synthesis and OAuth rows were never
 * copied). Kept apart from the command so tests can drive it with two engines.
 *
 * Transport is text on both sides: every column is read as `col::text` and
 * written back through `$n::text::<type>`, so no value ever passes through a
 * driver's native codec (driver round trips are what double-encoded jsonb
 * once). The bind is typed `text` because PGLite serializes a parameter by its
 * inferred type and refuses 't' for a boolean.
 */
import type { Engine } from "./engine/interface.ts";

export interface ColumnInfo {
  name: string;
  /** `format_type(atttypid, atttypmod)`, used as the bind cast. */
  type: string;
  /** STORED generated — the destination recomputes it. */
  generated: boolean;
  /** GENERATED ALWAYS AS IDENTITY — an explicit insert needs OVERRIDING SYSTEM VALUE. */
  identityAlways: boolean;
  /** Backed by a sequence (serial or identity) that must advance after a copy. */
  hasSequence: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** Primary key, else the first unique constraint whose columns are all NOT NULL. */
  key: string[] | null;
  /** Other public tables this one references (self-references dropped). */
  references: string[];
}

export type Catalog = Map<string, TableInfo>;

export interface TablePlan {
  name: string;
  /** Columns present on both sides, generated columns excluded, source order. */
  columns: ColumnInfo[];
  key: string[] | null;
  /** Columns the source has and the destination lacks (their data is not copied). */
  sourceOnlyColumns: string[];
}

export interface CopyPlan {
  tables: TablePlan[];
  missing: { name: string; side: "source" | "destination" }[];
}

export interface TableReport {
  name: string;
  src: number;
  dst: number;
  srcHash: string;
  dstHash: string;
  match: boolean;
  copied?: number;
  sourceOnlyColumns?: string[];
}

export interface CopySummary {
  ok: boolean;
  dryRun?: boolean;
  verifyOnly?: boolean;
  tables: TableReport[];
  missing: { name: string; side: "source" | "destination" }[];
  failures: { table: string; error: string }[];
}

export interface CopyOptions {
  /** Restrict the run to these tables. Tables outside it are neither copied nor required. */
  tables?: string[];
  /** Rows per INSERT. Default 500; capped so a batch stays under the bind limit. */
  batchSize?: number;
  dryRun?: boolean;
  verifyOnly?: boolean;
  log?: (line: string) => void;
}

const MAX_BIND_PARAMS = 60_000;
const HASH_PAGE = 2_000;
const HASH_MODULUS = 1n << 256n;

export function quoteIdent(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

/** Drivers hand json aggregates back either parsed or as text. */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return (JSON.parse(v) as unknown[]).map(String);
  return [];
}

export async function readCatalog(engine: Engine): Promise<Catalog> {
  const tables = await engine.query<{ name: string }>(
    `SELECT c.relname::text AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      ORDER BY 1`,
  );
  const catalog: Catalog = new Map();
  for (const t of tables.rows) {
    catalog.set(t.name, { name: t.name, columns: [], key: null, references: [] });
  }

  const cols = await engine.query<{
    table_name: string;
    name: string;
    type: string;
    generated: string;
    identity: string;
    has_seq: boolean;
  }>(
    `SELECT c.relname::text AS table_name, a.attname::text AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attgenerated::text AS generated, a.attidentity::text AS identity,
            pg_get_serial_sequence(quote_ident(c.relname), a.attname) IS NOT NULL AS has_seq
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  const notNull = new Map<string, Set<string>>();
  const nn = await engine.query<{ table_name: string; name: string }>(
    `SELECT c.relname::text AS table_name, a.attname::text AS name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull`,
  );
  for (const r of nn.rows) {
    if (!notNull.has(r.table_name)) notNull.set(r.table_name, new Set());
    notNull.get(r.table_name)!.add(r.name);
  }
  for (const c of cols.rows) {
    const t = catalog.get(c.table_name);
    if (!t) continue;
    t.columns.push({
      name: c.name,
      type: c.type,
      generated: c.generated === "s",
      identityAlways: c.identity === "a",
      hasSequence: c.has_seq === true,
    });
  }

  const cons = await engine.query<{
    table_name: string;
    kind: string;
    cols: unknown;
    ref: string | null;
  }>(
    `SELECT c.relname::text AS table_name, con.contype::text AS kind,
            (SELECT json_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols,
            fc.relname::text AS ref
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class fc ON fc.oid = con.confrelid
      WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f')
      ORDER BY c.relname, con.contype, con.conname`,
  );
  const uniques = new Map<string, string[][]>();
  for (const r of cons.rows) {
    const t = catalog.get(r.table_name);
    if (!t) continue;
    const keyCols = asStringArray(r.cols);
    if (r.kind === "p") {
      t.key = keyCols;
    } else if (r.kind === "u") {
      if (!uniques.has(t.name)) uniques.set(t.name, []);
      uniques.get(t.name)!.push(keyCols);
    } else if (r.ref && r.ref !== t.name && catalog.has(r.ref) && !t.references.includes(r.ref)) {
      t.references.push(r.ref);
    }
  }
  // A unique key with a nullable column can hold duplicate NULL rows: it is
  // neither a keyset order nor a conflict target.
  for (const t of catalog.values()) {
    if (t.key) continue;
    const required = notNull.get(t.name) ?? new Set<string>();
    t.key = (uniques.get(t.name) ?? []).find((u) => u.every((c) => required.has(c))) ?? null;
  }
  for (const t of catalog.values()) t.references.sort();
  return catalog;
}

/**
 * Kahn's order over FK edges, ties by name. Inserts run with FK checks off, so
 * the order is for determinism and readable progress, not correctness; a cycle
 * is appended by name rather than refused.
 */
export function topoOrder(names: string[], edges: Map<string, string[]>): string[] {
  const set = new Set(names);
  const indegree = new Map<string, number>(names.map((n) => [n, 0]));
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const n of names) {
    for (const dep of new Set(edges.get(n) ?? [])) {
      if (dep === n || !set.has(dep)) continue;
      indegree.set(n, indegree.get(n)! + 1);
      dependents.get(dep)!.push(n);
    }
  }
  const ready = names.filter((n) => indegree.get(n) === 0).sort();
  const out: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    out.push(n);
    for (const d of dependents.get(n)!) {
      const left = indegree.get(d)! - 1;
      indegree.set(d, left);
      if (left === 0) {
        ready.push(d);
        ready.sort();
      }
    }
  }
  const placed = new Set(out);
  return [...out, ...names.filter((n) => !placed.has(n)).sort()];
}

export function planCopy(src: Catalog, dst: Catalog, only?: string[]): CopyPlan {
  const wanted = only ? new Set(only) : null;
  if (wanted) {
    const unknown = [...wanted].filter((n) => !src.has(n) && !dst.has(n));
    if (unknown.length > 0) {
      throw new Error(`migrate-engine: unknown table(s) in --tables: ${unknown.sort().join(", ")}`);
    }
  }
  const inScope = (n: string) => wanted === null || wanted.has(n);
  const missing: CopyPlan["missing"] = [];
  for (const n of [...src.keys()].sort()) {
    if (!dst.has(n) && inScope(n)) missing.push({ name: n, side: "destination" });
  }
  for (const n of [...dst.keys()].sort()) {
    if (!src.has(n) && inScope(n)) missing.push({ name: n, side: "source" });
  }

  const both = [...src.keys()].filter((n) => dst.has(n) && inScope(n));
  const edges = new Map(both.map((n) => [n, dst.get(n)!.references]));
  const tables = topoOrder(both, edges).map((name): TablePlan => {
    const s = src.get(name)!;
    const d = dst.get(name)!;
    const dstCols = new Map(d.columns.map((c) => [c.name, c]));
    const columns: ColumnInfo[] = [];
    const sourceOnlyColumns: string[] = [];
    for (const c of s.columns) {
      const dc = dstCols.get(c.name);
      if (!dc) {
        if (!c.generated) sourceOnlyColumns.push(c.name);
        continue;
      }
      if (c.generated || dc.generated) continue;
      // The destination's type is the one the value is bound into.
      columns.push({ ...dc });
    }
    const names = new Set(columns.map((c) => c.name));
    const key = d.key && d.key.every((k) => names.has(k)) ? d.key : null;
    return { name, columns, key, sourceOnlyColumns };
  });
  return { tables, missing };
}

/**
 * Session settings that make the text form of a value identical on every
 * engine: timestamptz renders in UTC, floats in shortest exact form.
 */
async function pinTextFormat(tx: Engine): Promise<void> {
  await tx.query("SET LOCAL TimeZone = 'UTC'");
  await tx.query("SET LOCAL DateStyle = 'ISO, MDY'");
  await tx.query("SET LOCAL IntervalStyle = 'postgres'");
  await tx.query("SET LOCAL extra_float_digits = 1");
  await tx.query("SET LOCAL bytea_output = 'hex'");
}

interface Cursor {
  /** Key column values (text) of the last row read, or the last ctid for a keyless table. */
  after: string[] | null;
}

/**
 * One keyset page. Keyed tables page on the key (index order); a keyless table
 * pages on ctid, which is stable while nothing else writes to it.
 */
function pageQuery(
  t: TablePlan,
  types: Map<string, string>,
  projection: string,
  cursor: Cursor,
  limit: number,
): { sql: string; params: unknown[] } {
  const table = quoteIdent(t.name);
  if (t.key) {
    const keyList = t.key.map(quoteIdent).join(", ");
    const keyText = t.key.map((k, i) => `${quoteIdent(k)}::text AS "k${i}"`).join(", ");
    if (cursor.after === null) {
      return {
        sql: `SELECT ${keyText}, ${projection} FROM ${table} ORDER BY ${keyList} LIMIT ${limit}`,
        params: [],
      };
    }
    const bound = t.key.map((k, i) => `$${i + 1}::text::${types.get(k)}`).join(", ");
    return {
      sql: `SELECT ${keyText}, ${projection} FROM ${table}
             WHERE (${keyList}) > (${bound}) ORDER BY ${keyList} LIMIT ${limit}`,
      params: cursor.after,
    };
  }
  if (cursor.after === null) {
    return {
      sql: `SELECT ctid::text AS "k0", ${projection} FROM ${table} ORDER BY ctid LIMIT ${limit}`,
      params: [],
    };
  }
  return {
    sql: `SELECT ctid::text AS "k0", ${projection} FROM ${table}
           WHERE ctid > $1::text::tid ORDER BY ctid LIMIT ${limit}`,
    params: cursor.after,
  };
}

function advance(t: TablePlan, row: Record<string, unknown>): string[] {
  const n = t.key ? t.key.length : 1;
  return Array.from({ length: n }, (_, i) => row[`k${i}`] as string);
}

async function countRows(engine: Engine, table: string): Promise<number> {
  const r = await engine.query<{ c: number | string }>(
    `SELECT COUNT(*)::bigint AS c FROM ${quoteIdent(table)}`,
  );
  return Number(r.rows[0]?.c ?? 0);
}

/**
 * Refuse up front when the destination role cannot switch triggers off.
 * Falling back to a copy with triggers on is not an option: the withdrawal
 * trigger (migration 112) would flip `forgotten_at` on copied live facts.
 */
export async function assertReplicaRole(dst: Engine): Promise<void> {
  try {
    await dst.transaction(async (tx) => {
      await tx.query("SET LOCAL session_replication_role = replica");
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `migrate-engine: the destination role cannot SET session_replication_role (${msg}). ` +
        "The copy runs with triggers and FK checks off so no insert rewrites a copied row; " +
        "connect to the destination as a superuser (rds_superuser on RDS).",
    );
  }
}

async function copyTable(
  src: Engine,
  dst: Engine,
  t: TablePlan,
  batchSize: number,
): Promise<number | "skipped_nonempty"> {
  if (t.columns.length === 0) return 0;
  if (!t.key && (await countRows(dst, t.name)) > 0) return "skipped_nonempty";

  const types = new Map(t.columns.map((c) => [c.name, c.type]));
  const rowsPerBatch = Math.max(1, Math.min(batchSize, Math.floor(MAX_BIND_PARAMS / t.columns.length)));
  const projection = t.columns.map((c, i) => `${quoteIdent(c.name)}::text AS "c${i}"`).join(", ");
  const colList = t.columns.map((c) => quoteIdent(c.name)).join(", ");
  const overriding = t.columns.some((c) => c.identityAlways) ? " OVERRIDING SYSTEM VALUE" : "";
  let conflict = "";
  if (t.key) {
    const keySet = new Set(t.key);
    const rest = t.columns.filter((c) => !keySet.has(c.name));
    const target = t.key.map(quoteIdent).join(", ");
    conflict = rest.length === 0
      ? ` ON CONFLICT (${target}) DO NOTHING`
      : ` ON CONFLICT (${target}) DO UPDATE SET ${rest
        .map((c) => `${quoteIdent(c.name)} = EXCLUDED.${quoteIdent(c.name)}`)
        .join(", ")}`;
  }

  const cursor: Cursor = { after: null };
  let copied = 0;
  for (;;) {
    const page = pageQuery(t, types, projection, cursor, rowsPerBatch);
    const rows = await src.transaction(async (tx) => {
      await pinTextFormat(tx);
      return (await tx.query<Record<string, unknown>>(page.sql, page.params)).rows;
    });
    if (rows.length === 0) break;

    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of rows) {
      const slots: string[] = [];
      t.columns.forEach((c, i) => {
        params.push(row[`c${i}`] ?? null);
        slots.push(`$${params.length}::text::${c.type}`);
      });
      tuples.push(`(${slots.join(", ")})`);
    }
    await dst.transaction(async (tx) => {
      await tx.query("SET LOCAL session_replication_role = replica");
      await tx.query(
        `INSERT INTO ${quoteIdent(t.name)} (${colList})${overriding} VALUES ${tuples.join(", ")}${conflict}`,
        params,
      );
    });
    copied += rows.length;
    cursor.after = advance(t, rows[rows.length - 1]!);
    if (rows.length < rowsPerBatch) break;
  }

  for (const c of t.columns) {
    if (!c.hasSequence) continue;
    await dst.query(
      `SELECT setval(pg_get_serial_sequence($1, $2), m)
         FROM (SELECT max(${quoteIdent(c.name)}) AS m FROM ${quoteIdent(t.name)}) x
        WHERE m IS NOT NULL`,
      [quoteIdent(t.name), c.name],
    );
  }
  return copied;
}

/**
 * `{count, sha256}` over the copied columns. Each row's text projection is
 * hashed in SQL and the digests are summed mod 2^256, so the result does not
 * depend on row order: a text key sorts differently under PGLite's collation
 * and RDS's, and an ordered stream would report a mismatch for equal data.
 */
export async function hashTable(
  engine: Engine,
  t: TablePlan,
): Promise<{ count: number; sha256: string }> {
  const types = new Map(t.columns.map((c) => [c.name, c.type]));
  const rowText = t.columns.length === 0
    ? "''"
    : `ROW(${t.columns.map((c) => `${quoteIdent(c.name)}::text`).join(", ")})::text`;
  const projection = `encode(sha256(convert_to(${rowText}, 'UTF8')), 'hex') AS h`;
  const cursor: Cursor = { after: null };
  let sum = 0n;
  let count = 0;
  for (;;) {
    const page = pageQuery(t, types, projection, cursor, HASH_PAGE);
    const rows = await engine.transaction(async (tx) => {
      await pinTextFormat(tx);
      return (await tx.query<Record<string, unknown>>(page.sql, page.params)).rows;
    });
    for (const r of rows) sum = (sum + BigInt(`0x${r.h as string}`)) % HASH_MODULUS;
    count += rows.length;
    if (rows.length < HASH_PAGE) break;
    cursor.after = advance(t, rows[rows.length - 1]!);
  }
  return { count, sha256: sum.toString(16).padStart(64, "0") };
}

export async function verifyTables(
  src: Engine,
  dst: Engine,
  plan: CopyPlan,
): Promise<TableReport[]> {
  const out: TableReport[] = [];
  for (const t of plan.tables) {
    const a = await hashTable(src, t);
    const b = await hashTable(dst, t);
    const report: TableReport = {
      name: t.name,
      src: a.count,
      dst: b.count,
      srcHash: a.sha256,
      dstHash: b.sha256,
      match: a.count === b.count && a.sha256 === b.sha256,
    };
    if (t.sourceOnlyColumns.length > 0) report.sourceOnlyColumns = t.sourceOnlyColumns;
    out.push(report);
  }
  return out;
}

/**
 * Copy every planned table, then verify each by count and content hash.
 * The destination schema must already exist (the command runs migrations).
 */
export async function copyEngine(
  src: Engine,
  dst: Engine,
  opts: CopyOptions = {},
): Promise<CopySummary> {
  const log = opts.log ?? (() => {});
  const plan = planCopy(await readCatalog(src), await readCatalog(dst), opts.tables);
  const failures: CopySummary["failures"] = plan.missing.map((m) => ({
    table: m.name,
    error: `table missing on ${m.side}`,
  }));

  if (opts.dryRun) {
    const tables: TableReport[] = [];
    for (const t of plan.tables) {
      const s = await countRows(src, t.name);
      const d = await countRows(dst, t.name);
      log(`  ${t.name}: src=${s} dst=${d} (dry-run, no write)`);
      tables.push({ name: t.name, src: s, dst: d, srcHash: "", dstHash: "", match: s === d });
    }
    return { ok: true, dryRun: true, tables, missing: plan.missing, failures };
  }

  const copied = new Map<string, number>();
  if (!opts.verifyOnly) {
    await assertReplicaRole(dst);
    const batchSize = opts.batchSize ?? 500;
    for (const t of plan.tables) {
      try {
        const r = await copyTable(src, dst, t, batchSize);
        if (r === "skipped_nonempty") {
          failures.push({
            table: t.name,
            error: "skipped_nonempty: no primary or unique key, and the destination already has rows",
          });
          log(`  ${t.name}: skipped (no key, destination not empty)`);
        } else {
          copied.set(t.name, r);
          log(`  ${t.name}: copied=${r}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ table: t.name, error: msg });
        log(`  ${t.name}: FAILED ${msg}`);
      }
    }
  }

  const tables = await verifyTables(src, dst, plan);
  for (const r of tables) {
    const n = copied.get(r.name);
    if (n !== undefined) r.copied = n;
    if (!r.match && !failures.some((f) => f.table === r.name)) {
      failures.push({
        table: r.name,
        error: `mismatch: src=${r.src} dst=${r.dst}${r.src === r.dst ? " (content differs)" : ""}`,
      });
    }
  }
  const summary: CopySummary = {
    ok: failures.length === 0,
    tables,
    missing: plan.missing,
    failures,
  };
  if (opts.verifyOnly) summary.verifyOnly = true;
  return summary;
}
