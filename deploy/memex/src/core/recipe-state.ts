/**
 * Generic per-recipe KV. Backed by migration 013's `recipe_state` table.
 * One row per (recipe_id, key); value is JSONB.
 *
 * Used so polling recipes (gmail, gcal, …) can persist cursor state
 * and a bounded dedup set across container restarts without one
 * bespoke table per recipe.
 */
import type { Engine } from "./engine/interface.ts";

const PROCESSED_KEY = "processed";

export async function getRecipeState<T>(
  engine: Engine,
  recipeId: string,
  key: string,
): Promise<T | null> {
  const r = await engine.query<{ value: T | string }>(
    `SELECT value FROM recipe_state WHERE recipe_id = $1 AND key = $2`,
    [recipeId, key],
  );
  const raw = r.rows[0]?.value;
  if (raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function setRecipeState<T>(
  engine: Engine,
  recipeId: string,
  key: string,
  value: T,
): Promise<void> {
  await engine.query(
    `INSERT INTO recipe_state (recipe_id, key, value, updated_at)
     VALUES ($1, $2, $3::text::jsonb, NOW())
     ON CONFLICT (recipe_id, key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [recipeId, key, JSON.stringify(value)],
  );
}

interface ProcessedSet {
  ids: string[];
  updatedAt: string;
}

export async function appendDedupIds(
  engine: Engine,
  recipeId: string,
  newIds: readonly string[],
  maxIds: number,
): Promise<void> {
  if (newIds.length === 0) return;
  const cur = (await getRecipeState<ProcessedSet>(engine, recipeId, PROCESSED_KEY)) ?? {
    ids: [],
    updatedAt: new Date().toISOString(),
  };
  const seen = new Set(cur.ids);
  for (const id of newIds) seen.add(id);
  const merged = [...seen];
  const trimmed = merged.length > maxIds ? merged.slice(merged.length - maxIds) : merged;
  await setRecipeState<ProcessedSet>(engine, recipeId, PROCESSED_KEY, {
    ids: trimmed,
    updatedAt: new Date().toISOString(),
  });
}

export async function filterUnseenIds(
  engine: Engine,
  recipeId: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  const cur = await getRecipeState<ProcessedSet>(engine, recipeId, PROCESSED_KEY);
  if (!cur) return [...candidateIds];
  const seen = new Set(cur.ids);
  return candidateIds.filter((id) => !seen.has(id));
}
