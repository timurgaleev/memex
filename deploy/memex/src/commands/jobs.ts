/**
 * `memex jobs <subcommand>` — inspect / retry / cancel queued jobs.
 *
 * Subcommands:
 *   list       — print rows (filterable by --status / --kind, capped by --limit)
 *   stats      — print counts grouped by status
 *   retry <id> — flip failed/cancelled → pending, ready for the next claim
 *   cancel <id>— flip pending/running → cancelled
 *   show <id>  — full row for a single job
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { Queue } from "../core/jobs/queue.ts";
import type { JobStatus } from "../core/jobs/types.ts";

export type JobsSubcommand = "list" | "stats" | "retry" | "cancel" | "show";

export interface JobsCmdOptions {
  sub: JobsSubcommand;
  status?: JobStatus | JobStatus[];
  kind?: string;
  limit?: number;
  id?: string;
}

export async function runJobs(opts: JobsCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  await storage.init();
  try {
    const queue = new Queue(storage.engine());
    switch (opts.sub) {
      case "list": {
        const listOpts: Parameters<typeof queue.list>[0] = {};
        if (opts.status) listOpts.status = opts.status;
        if (opts.kind) listOpts.kind = opts.kind;
        if (opts.limit !== undefined) listOpts.limit = opts.limit;
        const rows = await queue.list(listOpts);
        console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
        return;
      }
      case "stats": {
        const stats = await queue.stats();
        console.log(JSON.stringify({ ok: true, stats }, null, 2));
        return;
      }
      case "show": {
        if (!opts.id) throw new Error("memex jobs show: <id> is required");
        const row = await queue.get(opts.id);
        if (!row) {
          console.log(JSON.stringify({ ok: false, error: "not-found", id: opts.id }, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, job: row }, null, 2));
        return;
      }
      case "retry": {
        if (!opts.id) throw new Error("memex jobs retry: <id> is required");
        const row = await queue.retry(opts.id);
        if (!row) {
          console.log(
            JSON.stringify(
              { ok: false, error: "not-retryable", id: opts.id },
              null,
              2,
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, job: row }, null, 2));
        return;
      }
      case "cancel": {
        if (!opts.id) throw new Error("memex jobs cancel: <id> is required");
        const row = await queue.cancel(opts.id);
        if (!row) {
          console.log(
            JSON.stringify(
              { ok: false, error: "not-cancellable", id: opts.id },
              null,
              2,
            ),
          );
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, job: row }, null, 2));
        return;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memex jobs: unknown subcommand '${_exhaustive}'`);
      }
    }
  } finally {
    await storage.close();
  }
}
