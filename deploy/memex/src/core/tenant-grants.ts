/**
 * Tenant source-grant operations — server-side write entitlements keyed by
 * JWT subject. The grant is provisioned out-of-band here; the IdP only proves
 * identity. See migrations/048_source_grants.sql.
 */
import type { Engine } from "./engine/interface.ts";
import { getSource } from "./sources.ts";

export interface GrantRow {
  sub: string;
  source_id: string | null;
  federated_read: string[];
  created_at: string;
}

export async function getGrant(engine: Engine, sub: string): Promise<GrantRow | null> {
  const r = await engine.query<GrantRow>(
    `SELECT sub, source_id, federated_read, created_at::text AS created_at
     FROM source_grants WHERE sub = $1`,
    [sub],
  );
  return r.rows[0] ?? null;
}

export async function listGrants(engine: Engine): Promise<GrantRow[]> {
  const r = await engine.query<GrantRow>(
    `SELECT sub, source_id, federated_read, created_at::text AS created_at
     FROM source_grants ORDER BY sub`,
  );
  return r.rows;
}

export interface UpsertGrantOptions {
  sub: string;
  sourceId: string;
  federatedRead: string[];
}

/**
 * Validate that source_id and every federated_read id exist in sources.
 * Returns a list of missing ids (empty = all valid).
 */
export async function validateGrantSourceIds(
  engine: Engine,
  sourceId: string,
  federatedRead: string[],
): Promise<string[]> {
  const toCheck = Array.from(new Set([sourceId, ...federatedRead]));
  const missing: string[] = [];
  for (const id of toCheck) {
    const row = await getSource(engine, id);
    if (!row) missing.push(id);
  }
  return missing;
}

/**
 * Upsert a source_grant row. Callers MUST validate source ids first via
 * `validateGrantSourceIds`.
 */
export async function upsertGrant(
  engine: Engine,
  opts: UpsertGrantOptions,
): Promise<GrantRow> {
  await engine.query(
    `INSERT INTO source_grants (sub, source_id, federated_read)
     VALUES ($1, $2, $3)
     ON CONFLICT (sub) DO UPDATE SET
       source_id = EXCLUDED.source_id,
       federated_read = EXCLUDED.federated_read`,
    [opts.sub, opts.sourceId, opts.federatedRead],
  );
  const row = await getGrant(engine, opts.sub);
  if (!row) throw new Error(`upsertGrant: no row found for sub=${opts.sub}`);
  return row;
}

/**
 * Delete the grant for a subject. Returns true if a row was removed.
 */
export async function revokeGrant(engine: Engine, sub: string): Promise<boolean> {
  const before = await getGrant(engine, sub);
  if (!before) return false;
  await engine.query(`DELETE FROM source_grants WHERE sub = $1`, [sub]);
  return true;
}
