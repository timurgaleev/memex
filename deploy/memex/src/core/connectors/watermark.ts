/**
 * Connector cursor state in `recipe_state`, one recipe id per connector target:
 * `connector:<provider>:<target>`.
 *
 *   watermark — the newest provider `updated_at` a clean run has seen;
 *   last_run  — how the latest run ended (see ConnectorRunRecord).
 *
 * The watermark moves only on a clean run. A partial run leaves it where it
 * was, so the next run fetches the same delta again; putPage's content-hash
 * no-op makes that re-fetch cost reads, not writes.
 *
 * The next run asks for everything updated since the watermark minus a
 * gap-heal window, because a provider's `since` index can lag its writes and
 * clocks drift: an item updated just before the last run may only have become
 * visible after it.
 */
import type { Engine } from "../engine/interface.ts";
import { getRecipeState, setRecipeState } from "../recipe-state.ts";
import { isCleanRun, type ConnectorRunRecord } from "./types.ts";

export const CONNECTOR_RECIPE_PREFIX = "connector:";
const WATERMARK_KEY = "watermark";
const LAST_RUN_KEY = "last_run";
const DEFAULT_GAP_HEAL_MINUTES = 15;

interface WatermarkRow {
  watermark: string;
}

export function connectorRecipeId(provider: string, target: string): string {
  return `${CONNECTOR_RECIPE_PREFIX}${provider}:${target}`;
}

/** MEMEX_CONNECTOR_GAP_HEAL_MINUTES, a non-negative integer (default 15). */
export function gapHealMinutes(): number {
  const raw = (process.env.MEMEX_CONNECTOR_GAP_HEAL_MINUTES ?? "").trim();
  if (raw === "") return DEFAULT_GAP_HEAL_MINUTES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_GAP_HEAL_MINUTES;
}

export async function readWatermark(engine: Engine, recipeId: string): Promise<string | null> {
  const row = await getRecipeState<WatermarkRow>(engine, recipeId, WATERMARK_KEY);
  const w = row?.watermark;
  return typeof w === "string" && Number.isFinite(Date.parse(w)) ? w : null;
}

export async function readLastRun(engine: Engine, recipeId: string): Promise<ConnectorRunRecord | null> {
  return getRecipeState<ConnectorRunRecord>(engine, recipeId, LAST_RUN_KEY);
}

/** The `since` for the next fetch: the watermark minus the gap-heal window. */
export function sinceFor(watermark: string | null, gapMinutes: number): string | null {
  if (watermark === null) return null;
  return new Date(Date.parse(watermark) - gapMinutes * 60_000).toISOString();
}

/** The later of two ISO times; null loses. */
export function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Record how a run ended. The watermark is written only for a clean run, and
 * never moves backwards; `last_success_at` carries across failed runs so the
 * doctor can tell a stalled connector from a fresh one.
 */
export async function recordRun(
  engine: Engine,
  recipeId: string,
  run: Omit<ConnectorRunRecord, "last_success_at">,
  newWatermark: string | null,
): Promise<ConnectorRunRecord> {
  const previous = await readLastRun(engine, recipeId);
  const clean = isCleanRun(run.status);
  const record: ConnectorRunRecord = {
    ...run,
    last_success_at: clean ? run.at : (previous?.last_success_at ?? null),
  };
  if (clean && newWatermark !== null) {
    const current = await readWatermark(engine, recipeId);
    const next = laterOf(current, newWatermark);
    if (next !== current) await setRecipeState<WatermarkRow>(engine, recipeId, WATERMARK_KEY, { watermark: next! });
  }
  await setRecipeState(engine, recipeId, LAST_RUN_KEY, record);
  return record;
}

export interface ConnectorStateRow {
  recipe_id: string;
  watermark: string | null;
  last_run: ConnectorRunRecord | null;
}

/** Every connector's state, for `connectors status` and the doctor. */
export async function listConnectorStates(engine: Engine): Promise<ConnectorStateRow[]> {
  const r = await engine.query<{ recipe_id: string; key: string; value: unknown }>(
    `SELECT recipe_id, key, value FROM recipe_state
      WHERE recipe_id LIKE $1 AND key IN ($2, $3)
      ORDER BY recipe_id`,
    [`${CONNECTOR_RECIPE_PREFIX}%`, WATERMARK_KEY, LAST_RUN_KEY],
  );
  const byId = new Map<string, ConnectorStateRow>();
  for (const row of r.rows) {
    const value = typeof row.value === "string" ? safeParse(row.value) : row.value;
    const entry = byId.get(row.recipe_id) ?? { recipe_id: row.recipe_id, watermark: null, last_run: null };
    if (row.key === WATERMARK_KEY) {
      const w = (value as WatermarkRow | null)?.watermark;
      entry.watermark = typeof w === "string" ? w : null;
    } else {
      entry.last_run = (value as ConnectorRunRecord | null) ?? null;
    }
    byId.set(row.recipe_id, entry);
  }
  return [...byId.values()];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
