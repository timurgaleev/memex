/**
 * `memex eval-export` — dump captured eval rows as JSONL to stdout
 * (or `--out PATH`) for offline analysis. Reads from `eval_candidates`
 * (auto-capture firehose) by default; pass `--source curated` to dump
 * `eval_queries` (the curated regression set) instead.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";

export interface EvalExportCmdOptions {
  /** 'firehose' (default) reads eval_candidates; 'curated' reads eval_queries. */
  source?: "firehose" | "curated";
  /** Window in hours back from now. Default 168 (one week). */
  sinceHours?: number;
  /** Cap on rows. Default 10_000. */
  limit?: number;
  /** Output path; stdout if omitted. */
  out?: string;
}

export async function runEvalExport(
  opts: EvalExportCmdOptions = {},
): Promise<void> {
  const source = opts.source ?? "firehose";
  const sinceHours = opts.sinceHours ?? 168;
  const limit = Math.min(Math.max(opts.limit ?? 10_000, 1), 1_000_000);

  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const engine = storage.engine();
    const lines: string[] = [];
    if (source === "firehose") {
      const r = await engine.query<Record<string, unknown>>(
        `SELECT id, captured_at::text, tool_name, query, scrubbed, k,
                search_mode, result_doc_ids, result_count, latency_ms,
                meta, remote, expand_enabled, detail, job_id, subagent_id
           FROM eval_candidates
          WHERE captured_at > NOW() - ($1 || ' hours')::interval
          ORDER BY captured_at DESC, id DESC
          LIMIT $2`,
        [String(sinceHours), limit],
      );
      for (const row of r.rows) lines.push(JSON.stringify(row));
    } else {
      const r = await engine.query<Record<string, unknown>>(
        `SELECT id, captured_at::text, query, k, expected_doc_id, tag,
                source, notes, search_mode, baseline_doc_ids,
                baseline_rank, baseline_hit, baseline_rr,
                baseline_ran_at::text
           FROM eval_queries
          ORDER BY captured_at DESC, id COLLATE "C" DESC
          LIMIT $1`,
        [limit],
      );
      for (const row of r.rows) lines.push(JSON.stringify(row));
    }
    const payload = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    if (opts.out) {
      const target = resolve(opts.out);
      writeFileSync(target, payload, { mode: 0o644 });
      console.log(
        JSON.stringify(
          { ok: true, path: target, lines: lines.length, source },
          null,
          2,
        ),
      );
    } else {
      process.stdout.write(payload);
    }
  });
}
