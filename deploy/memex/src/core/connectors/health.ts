/**
 * Doctor check for connectors: a credential the provider stopped honouring,
 * and a connector whose last clean run is too old.
 *
 * Warn, never fail: a connector is optional capture, and a stale mirror is not
 * a broken brain. The detail names the connector and what to do.
 */
import type { Engine } from "../engine/interface.ts";
import type { OpsCheckResult } from "../doctor-ops.ts";
import { needsReauth } from "./types.ts";
import { CONNECTOR_RECIPE_PREFIX, listConnectorStates } from "./watermark.ts";

const DEFAULT_STALL_DAYS = 7;
const DAY_MS = 86_400_000;

/** MEMEX_CONNECTOR_STALL_DAYS, a positive integer (default 7). */
export function connectorStallDays(): number {
  const n = Number((process.env.MEMEX_CONNECTOR_STALL_DAYS ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STALL_DAYS;
}

export async function checkConnectorHealth(engine: Engine, now: number = Date.now()): Promise<OpsCheckResult> {
  const states = await listConnectorStates(engine);
  const runs = states.filter((s) => s.last_run !== null);
  if (runs.length === 0) return { ok: true, status: "ok", detail: "no connector has run" };

  const stallDays = connectorStallDays();
  const problems: string[] = [];
  for (const s of runs) {
    const run = s.last_run!;
    const name = s.recipe_id.slice(CONNECTOR_RECIPE_PREFIX.length);
    if (needsReauth(run.status)) {
      problems.push(`${name}: re-auth needed (last run ${run.status}${run.http_status ? ` HTTP ${run.http_status}` : ""} at ${run.at})`);
      continue;
    }
    const lastSuccess = run.last_success_at === null ? Number.NaN : Date.parse(run.last_success_at);
    if (!Number.isFinite(lastSuccess)) {
      problems.push(`${name}: no clean run yet (last run ${run.status} at ${run.at})`);
    } else if (now - lastSuccess > stallDays * DAY_MS) {
      problems.push(`${name}: stalled, last clean run ${run.last_success_at} is over ${stallDays} day(s) old (last run ${run.status})`);
    }
  }
  if (problems.length === 0) {
    return { ok: true, status: "ok", detail: `${runs.length} connector(s), all current` };
  }
  return { ok: true, status: "warn", detail: problems.join("; ") };
}
