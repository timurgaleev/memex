/**
 * raw_data sidecar (migrations 023 + 078) — per-page raw payload store
 * (API responses, headers) keyed UNIQUE(slug, source), reference parity for
 * put_raw_data / get_raw_data.
 *
 * Newest-wins upsert: re-putting the same (slug, source) REPLACES the payload
 * (the sidecar is a cache of the latest fetch, not a history — the reference's
 * semantics). `source` here is the DATA source label ('crustdata', an importer
 * name), NOT the tenant axis; tenancy rides the owning page's source_id via an
 * ownership guard on write and a pages join on read.
 */
import type { Storage } from "./storage.ts";
import { validateSlug } from "./pages.ts";
import { wellFormJsonbValue } from "./well-form.ts";

/** Upper bound on one payload's serialized size (defence vs unbounded writes). */
const MAX_RAW_DATA_BYTES = 1_000_000;

export interface RawDataRow {
  id: number;
  slug: string;
  source: string;
  data: Record<string, unknown>;
  created_at: string;
}

function normaliseSource(source: string): string {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("raw_data source must be a non-empty string");
  }
  return source.trim();
}

/**
 * Upsert one raw payload for (slug, source). A scoped caller (`sourceId` set)
 * may only attach data to a page its own source owns — same ownership guard
 * as addTimelineEvent. Returns whether the row was created (vs replaced).
 */
export async function putRawData(
  storage: Storage,
  slug: string,
  source: string,
  data: Record<string, unknown>,
  sourceId?: string,
): Promise<{ slug: string; source: string; created: boolean }> {
  validateSlug(slug);
  const src = normaliseSource(source);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("raw_data data must be a plain object");
  }
  const safe = wellFormJsonbValue(data) as Record<string, unknown>;
  const json = JSON.stringify(safe);
  if (json.length > MAX_RAW_DATA_BYTES) {
    throw new Error(`raw_data payload exceeds ${MAX_RAW_DATA_BYTES} bytes`);
  }
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
  if (scope !== null) {
    const owns = await storage
      .engine()
      .query(`SELECT 1 FROM pages WHERE slug = $1 AND source_id = $2`, [
        slug,
        scope,
      ]);
    if (owns.rows.length === 0) {
      throw new Error(`page not found: ${slug}`);
    }
  }
  const r = await storage.engine().query<{ inserted: boolean }>(
    `INSERT INTO raw_data (slug, source, data)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (slug, source) DO UPDATE
       SET data = EXCLUDED.data,
           created_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [slug, src, json],
  );
  return { slug, source: src, created: r.rows[0]?.inserted ?? false };
}

export interface GetRawDataOptions {
  /** Filter to one data-source label. */
  source?: string;
  limit?: number;
  /** Tenant scope (mig047, via the owning page). Omitted/empty -> unscoped. */
  sourceIds?: string[];
}

/** Read the raw payload rows for a page, newest first. */
export async function getRawData(
  storage: Storage,
  slug: string,
  opts: GetRawDataOptions = {},
): Promise<RawDataRow[]> {
  validateSlug(slug);
  const params: unknown[] = [slug];
  const where: string[] = ["r.slug = $1"];
  if (typeof opts.source === "string" && opts.source.length > 0) {
    params.push(opts.source.trim());
    where.push(`r.source = $${params.length}`);
  }
  let join = "";
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    params.push(opts.sourceIds);
    join = ` JOIN pages p ON p.slug = r.slug AND p.source_id = ANY($${params.length}::text[])`;
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 200
      ? Math.floor(opts.limit)
      : 50;
  params.push(limit);
  const r = await storage.engine().query<RawDataRow>(
    `SELECT r.id, r.slug, r.source, r.data, r.created_at::text AS created_at
       FROM raw_data r${join}
      WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}
