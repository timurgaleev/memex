/**
 * `memex agent run <task> [--max-usd X] [--wait]` — queue a `subagent` job for
 * the worker and print its id (with --wait, poll until it ends and print the
 * result).
 * `memex agent logs <job-id>` — render a job's transcript from the ledger.
 *
 * `run` enqueues through the Queue directly rather than `jobs submit`: the
 * submit check accepts only kinds this process has a handler for, and a CLI
 * process never registers serve's handlers. The env gate is checked here
 * instead, so a disabled install refuses before anything is queued.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { Queue } from "../core/jobs/queue.ts";
import type { JobRow } from "../core/jobs/types.ts";
import {
  AGENT_JOB_TIMEOUT_MS,
  SUBAGENT_JOB_KIND,
  agentEnabled,
  parseSubagentPayload,
  agentMaxUsd,
} from "../core/agent/handler.ts";
import {
  listMessages,
  listToolExecutions,
  type MessageRow,
  type ToolExecutionRow,
} from "../core/subagent_ledger.ts";
import { withStorage } from "./with-storage.ts";

export interface AgentCliOptions {
  sub: string | undefined;
  task?: string;
  jobId?: string;
  maxUsd?: number;
  wait?: boolean;
  /** Test seams. */
  storage?: Storage;
  enabled?: string | undefined;
  out?: (line: string) => void;
  err?: (line: string) => void;
  pollMs?: number;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_INPUT_CHARS = 200;
const MAX_RESULT_CHARS = 300;

function clip(text: string, max: number): string {
  const flat = text.replaceAll("\n", " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

interface Block {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  toolResult?: { toolUseId?: string; status?: string; content?: Array<{ text?: string }> };
}

function blocksOf(row: MessageRow): Block[] {
  const content = (row.content as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** A job's transcript as plain text: turns in order, tool calls with their status. */
export function renderTranscript(
  job: JobRow,
  messages: readonly MessageRow[],
  execs: readonly ToolExecutionRow[],
): string {
  const byUseId = new Map(execs.filter((e) => e.tool_use_id).map((e) => [e.tool_use_id!, e]));
  const lines: string[] = [
    `job ${job.id}  kind ${job.kind}  status ${job.status}`,
    `cost $${job.costUsd.toFixed(4)}  tokens in ${job.tokensInput} / out ${job.tokensOutput}`,
    "",
  ];
  for (const row of messages) {
    const blocks = blocksOf(row);
    if (row.role === "assistant") {
      const stop = (row.content as { stop_reason?: string }).stop_reason ?? "?";
      lines.push(`[${row.turn_num}] assistant (${stop})`);
    } else {
      lines.push(`[${row.turn_num}] ${row.role}`);
    }
    for (const b of blocks) {
      if (b.text) lines.push(`    ${b.text.split("\n").join("\n    ")}`);
      if (b.toolUse) {
        const exec = b.toolUse.toolUseId ? byUseId.get(b.toolUse.toolUseId) : undefined;
        const input = clip(JSON.stringify(b.toolUse.input ?? {}), MAX_INPUT_CHARS);
        lines.push(`    -> ${b.toolUse.name ?? "?"} ${input} [${exec?.status ?? "not run"}]`);
      }
      if (b.toolResult) {
        const exec = b.toolResult.toolUseId ? byUseId.get(b.toolResult.toolUseId) : undefined;
        const text = (b.toolResult.content ?? []).map((c) => c.text ?? "").join(" ");
        lines.push(
          `    <- ${exec?.tool_name ?? "?"} (${b.toolResult.status ?? "?"}): ${clip(text, MAX_RESULT_CHARS)}`,
        );
      }
    }
  }
  if (job.result) {
    lines.push("", `result: ${JSON.stringify(job.result)}`);
  } else if (job.lastError) {
    lines.push("", `error: ${job.lastError}`);
  }
  return lines.join("\n");
}

async function waitForEnd(
  queue: Queue,
  id: string,
  pollMs: number,
  deadlineMs: number,
): Promise<JobRow | null> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const job = await queue.get(id);
    if (!job || TERMINAL.has(job.status)) return job;
    if (Date.now() > until) return job;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function runAgentCli(opts: AgentCliOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  const enabled = "enabled" in opts ? opts.enabled : process.env.MEMEX_AGENT_ENABLED;

  if (opts.sub === "run") {
    if (!agentEnabled(enabled)) {
      err("memex agent run: the agent loop is off; set MEMEX_AGENT_ENABLED=1 on the server first");
      return 1;
    }
    // Validate here too, so a bad task fails at the prompt, not in the worker.
    const payload: Record<string, unknown> = { task: opts.task ?? "" };
    if (opts.maxUsd !== undefined) payload.max_usd = opts.maxUsd;
    try {
      parseSubagentPayload(payload, agentMaxUsd());
    } catch (e) {
      err(`memex agent run: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    const storage = opts.storage ?? new Storage(loadConfig());
    return withStorage(
      storage,
      async () => {
        const queue = new Queue(storage.engine());
        const job = await queue.enqueue({
          kind: SUBAGENT_JOB_KIND,
          payload,
          timeoutMs: AGENT_JOB_TIMEOUT_MS,
          maxRetries: 0,
        });
        out(job.id);
        if (!opts.wait) return 0;
        const end = await waitForEnd(queue, job.id, opts.pollMs ?? 2000, AGENT_JOB_TIMEOUT_MS * 2);
        if (!end) {
          err(`memex agent run: job ${job.id} disappeared`);
          return 1;
        }
        out(JSON.stringify({ status: end.status, result: end.result, error: end.lastError }, null, 2));
        return end.status === "succeeded" ? 0 : 1;
      },
      { owned: opts.storage === undefined },
    );
  }

  if (opts.sub === "logs") {
    if (!opts.jobId) {
      err("memex agent logs: <job-id> is required");
      return 1;
    }
    const jobId = opts.jobId;
    const storage = opts.storage ?? new Storage(loadConfig());
    return withStorage(
      storage,
      async () => {
        const job = await new Queue(storage.engine()).get(jobId);
        if (!job) {
          err(`memex agent logs: no job ${jobId}`);
          return 1;
        }
        if (job.kind !== SUBAGENT_JOB_KIND) {
          err(`memex agent logs: job ${jobId} is a '${job.kind}' job, not an agent run`);
          return 1;
        }
        const [messages, execs] = await Promise.all([
          listMessages(storage, jobId),
          listToolExecutions(storage, jobId),
        ]);
        out(renderTranscript(job, messages, execs));
        return 0;
      },
      { owned: opts.storage === undefined },
    );
  }

  err("memex agent: subcommand required (run|logs)");
  return 1;
}
