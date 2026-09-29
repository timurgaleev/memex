/**
 * Stores a runtime_config row under exactly the given key, the way a
 * pre-rename release stored its `MEMEX_` rows. `setRuntimeConfig` cannot seed
 * one: it stores every knob under its `MEMRAIN_` spelling.
 */
import type { Engine } from "../../src/core/engine/interface.ts";

export async function putRuntimeConfigRow(engine: Engine, key: string, value: string): Promise<void> {
  await engine.query(
    `INSERT INTO runtime_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}
