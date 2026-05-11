/**
 * `memex eval-prune` — delete old rows from eval_candidates so the
 * firehose table doesn't bloat. Default keep window is 90 days.
 *
 * Read-only by default (`--dry-run` is the default). Pass `--apply`
 * to actually DELETE.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";

export interface EvalPruneCmdOptions {
  /** Keep rows newer than this many days. Default 90. */
  keepDays?: number;
  /** When true, run DELETE; otherwise count only. Default false. */
  apply?: boolean;
  /** Optional kind/tool filter. */
  toolName?: string;
}

export async function runEvalPrune(
  opts: EvalPruneCmdOptions = {},
): Promise<void> {
  const keepDays = Math.max(1, Math.floor(opts.keepDays ?? 90));
  const apply = opts.apply ?? false;

  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const engine = storage.engine();
    const params: unknown[] = [String(keepDays)];
    let where = `captured_at < NOW() - ($1 || ' days')::interval`;
    if (opts.toolName) {
      params.push(opts.toolName);
      where += ` AND tool_name = $${params.length}`;
    }
    const c = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM eval_candidates WHERE ${where}`,
      params,
    );
    const candidates = c.rows[0]?.n ?? 0;
    if (apply && candidates > 0) {
      await engine.query(
        `DELETE FROM eval_candidates WHERE ${where}`,
        params,
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: apply ? "apply" : "dry-run",
          keepDays,
          ...(opts.toolName ? { toolName: opts.toolName } : {}),
          deleted: apply ? candidates : 0,
          wouldDelete: apply ? 0 : candidates,
        },
        null,
        2,
      ),
    );
  } finally {
    await storage.close();
  }
}
