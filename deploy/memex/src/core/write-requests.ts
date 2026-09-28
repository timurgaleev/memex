/**
 * Idempotent writes (migration 119) — the `request_id` a caller may attach to a
 * write so a retry after a timeout returns the first call's outcome instead of
 * writing twice (a second `page_append` of the same text, a second fact).
 *
 * A key is (principal, tool, request_id). The principal is the caller's grant
 * identity, so one tenant's ids never collide with — or reveal — another's.
 * The row is claimed BEFORE the write runs (result NULL), so two concurrent
 * calls with one key cannot both write: the loser sees the claim and is told to
 * retry. The write stamps a receipt on the claim INSIDE its own transaction
 * (`recordWriteRequest`), so the key reads as done exactly when the write
 * committed — a failure in the derived work after the commit, or a crash, can
 * never leave a committed write re-runnable. Only a claim with no receipt is
 * released on failure, and only such a claim older than STALE_CLAIM_MINUTES is
 * taken over as belonging to a call that died before committing.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { OperationError } from "./operation-error.ts";
import { wellFormJsonbValue } from "./well-form.ts";

/** How long a completed request's result is kept for replay. */
export const WRITE_REQUEST_TTL_DAYS = 7;
const STALE_CLAIM_MINUTES = 15;

export interface WriteRequestKey {
  principal: string;
  tool: string;
  requestId: string;
}

export type WriteRequestClaim =
  | { kind: "claimed" }
  | { kind: "replay"; result: Record<string, unknown> };

/** JSON with every object's keys sorted, so argument order never matters. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Fingerprint of a write's arguments, `request_id` itself excluded. */
export function writeRequestArgsHash(args: Record<string, unknown>): string {
  const { request_id: _ignored, ...rest } = args;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/**
 * Claim the key for this call, or hand back the stored result of the call that
 * already completed under it. Throws `invalid_params` when the key was used
 * with different arguments, `request_in_progress` while another call holds it.
 */
export async function claimWriteRequest(
  engine: Engine,
  key: WriteRequestKey,
  argsHash: string,
): Promise<WriteRequestClaim> {
  const params = [key.principal, key.tool, key.requestId];
  // Two passes: a row released or pruned between the insert and the read is
  // simply claimed again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ins = await engine.query(
      `INSERT INTO write_requests (principal, tool, request_id, args_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principal, tool, request_id) DO NOTHING
       RETURNING 1`,
      [...params, argsHash],
    );
    if (ins.rows.length > 0) return { kind: "claimed" };
    const cur = await engine.query<{ args_hash: string; result: Record<string, unknown> | null; stale: boolean }>(
      `SELECT args_hash, result,
              (created_at < NOW() - make_interval(mins => ${STALE_CLAIM_MINUTES})) AS stale
         FROM write_requests
        WHERE principal = $1 AND tool = $2 AND request_id = $3`,
      params,
    );
    const row = cur.rows[0];
    if (row === undefined) continue;
    if (row.args_hash !== argsHash) {
      throw new OperationError(
        "invalid_params",
        `request_id '${key.requestId}' was already used for a different ${key.tool} call`,
        "Reuse a request_id only to retry the identical call; use a new one for a different write.",
      );
    }
    if (row.result !== null) return { kind: "replay", result: row.result };
    if (row.stale) {
      const took = await engine.query(
        `UPDATE write_requests SET created_at = NOW()
          WHERE principal = $1 AND tool = $2 AND request_id = $3
            AND result IS NULL
            AND created_at < NOW() - make_interval(mins => ${STALE_CLAIM_MINUTES})
          RETURNING 1`,
        params,
      );
      if (took.rows.length > 0) return { kind: "claimed" };
    }
    break;
  }
  throw new OperationError(
    "request_in_progress",
    `a ${key.tool} call with request_id '${key.requestId}' is still running`,
    "Retry shortly with the same request_id and arguments to receive its result.",
  );
}

/**
 * Stamp the receipt of a claimed write, inside the write's own transaction, so
 * the receipt commits or rolls back with it. Refuses — rolling the write back —
 * when the claim already holds a receipt or is gone: a second call that took
 * over a slow claim must not commit the same write twice.
 */
export async function recordWriteRequest(
  tx: Engine,
  key: WriteRequestKey,
  result: Record<string, unknown>,
): Promise<void> {
  const r = await tx.query(
    `UPDATE write_requests SET result = $4::text::jsonb
      WHERE principal = $1 AND tool = $2 AND request_id = $3 AND result IS NULL
      RETURNING 1`,
    [key.principal, key.tool, key.requestId, JSON.stringify(wellFormJsonbValue(result))],
  );
  if (r.rows.length === 0) {
    throw new OperationError(
      "request_in_progress",
      `a ${key.tool} call with request_id '${key.requestId}' already completed or lost its claim`,
      "Retry shortly with the same request_id and arguments to receive its result.",
    );
  }
}

/** Replace a committed write's receipt with the full response, for replay. */
export async function completeWriteRequest(
  engine: Engine,
  key: WriteRequestKey,
  result: Record<string, unknown>,
): Promise<void> {
  await engine.query(
    `UPDATE write_requests SET result = $4::text::jsonb
      WHERE principal = $1 AND tool = $2 AND request_id = $3`,
    [key.principal, key.tool, key.requestId, JSON.stringify(wellFormJsonbValue(result))],
  );
}

/** Drop a claim whose write never committed, so a retry runs it again. */
export async function releaseWriteRequest(engine: Engine, key: WriteRequestKey): Promise<void> {
  await engine.query(
    `DELETE FROM write_requests
      WHERE principal = $1 AND tool = $2 AND request_id = $3 AND result IS NULL`,
    [key.principal, key.tool, key.requestId],
  );
}

/** Prune request records past the replay window. Best-effort, like the other purge helpers. */
export async function purgeExpiredWriteRequests(
  engine: Engine,
  ttlDays = WRITE_REQUEST_TTL_DAYS,
): Promise<number> {
  try {
    const r = await engine.query<{ count: string | number }>(
      `WITH deleted AS (
         DELETE FROM write_requests
         WHERE created_at < NOW() - make_interval(days => $1::int)
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
      [ttlDays],
    );
    return Number(r.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}
