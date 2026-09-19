/**
 * `memex agent run|logs` and the env gate: run refuses unless the loop is
 * enabled and otherwise queues a `subagent` job with its timeout and no
 * retries; logs renders a transcript from the ledger; serve registers the
 * handler only when MEMEX_AGENT_ENABLED=1.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import {
  _resetHandlersForTesting,
  isKnownJobKind,
  listHandlers,
} from "../src/core/jobs/handlers.ts";
import {
  AGENT_JOB_TIMEOUT_MS,
  SUBAGENT_JOB_KIND,
  registerSubagentHandlerIfEnabled,
} from "../src/core/agent/handler.ts";
import { runAgentCli } from "../src/commands/agent.ts";
import {
  appendMessage,
  beginToolExecution,
  finishToolExecution,
} from "../src/core/subagent_ledger.ts";

let tmp: string;
let storage: Storage;
let out: string[];
let err: string[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-agent-cli-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  out = [];
  err = [];
});

afterEach(async () => {
  _resetHandlersForTesting();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const io = () => ({ storage, out: (l: string) => out.push(l), err: (l: string) => err.push(l) });

async function jobCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs`);
  return r.rows[0]!.n;
}

describe("agent run", () => {
  it("refuses unless MEMEX_AGENT_ENABLED=1, queuing nothing", async () => {
    for (const enabled of [undefined, "", "0", "true"]) {
      const code = await runAgentCli({ sub: "run", task: "summarize", enabled, ...io() });
      expect(code).toBe(1);
    }
    expect(err.join("\n")).toContain("MEMEX_AGENT_ENABLED=1");
    expect(await jobCount()).toBe(0);
  });

  it("queues a subagent job with the agent timeout and no retries", async () => {
    const code = await runAgentCli({ sub: "run", task: "summarize memex", maxUsd: 0.1, enabled: "1", ...io() });
    expect(code).toBe(0);
    const job = (await new Queue(storage.engine()).get(out[0]!))!;
    expect(job.kind).toBe(SUBAGENT_JOB_KIND);
    expect(job.payload).toEqual({ task: "summarize memex", max_usd: 0.1 });
    expect(job.timeoutMs).toBe(AGENT_JOB_TIMEOUT_MS);
    expect(job.maxRetries).toBe(0);
  });

  it("refuses an empty task before queuing", async () => {
    expect(await runAgentCli({ sub: "run", task: "", enabled: "1", ...io() })).toBe(1);
    expect(await jobCount()).toBe(0);
  });
});

describe("agent logs", () => {
  it("renders a seeded transcript", async () => {
    const queue = new Queue(storage.engine());
    const job = await queue.enqueue({ kind: SUBAGENT_JOB_KIND, payload: { task: "t" }, maxRetries: 0 });
    await appendMessage(storage, {
      job_id: job.id, turn_num: 0, role: "user", content: { role: "user", content: [{ text: "what links to memex?" }] },
    });
    await appendMessage(storage, {
      job_id: job.id,
      turn_num: 1,
      role: "assistant",
      content: {
        role: "assistant",
        content: [{ text: "checking" }, { toolUse: { toolUseId: "u1", name: "backlinks", input: { slug: "memex" } } }],
        stop_reason: "tool_use",
      },
    });
    const { id } = await beginToolExecution(storage, {
      job_id: job.id, turn_num: 1, tool_name: "backlinks", input: { slug: "memex" }, tool_use_id: "u1", run_generation: 1,
    });
    await finishToolExecution(storage, { id, status: "succeeded", output: { text: "projects/brain" } });
    await appendMessage(storage, {
      job_id: job.id,
      turn_num: 2,
      role: "tool_result",
      content: {
        role: "user",
        content: [{ toolResult: { toolUseId: "u1", status: "success", content: [{ text: "projects/brain" }] } }],
      },
    });
    await appendMessage(storage, {
      job_id: job.id,
      turn_num: 3,
      role: "assistant",
      content: { role: "assistant", content: [{ text: "projects/brain links to it" }], stop_reason: "end_turn" },
    });

    expect(await runAgentCli({ sub: "logs", jobId: job.id, ...io() })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`job ${job.id}`);
    expect(text).toContain("[0] user");
    expect(text).toContain("what links to memex?");
    expect(text).toContain("[1] assistant (tool_use)");
    expect(text).toContain('-> backlinks {"slug":"memex"} [succeeded]');
    expect(text).toContain("<- backlinks (success): projects/brain");
    expect(text).toContain("[3] assistant (end_turn)");
    expect(text).toContain("projects/brain links to it");
  });

  it("refuses a job that is not an agent run, and a missing id", async () => {
    const job = await new Queue(storage.engine()).enqueue({ kind: "page_mirror", payload: {} });
    expect(await runAgentCli({ sub: "logs", jobId: job.id, ...io() })).toBe(1);
    expect(await runAgentCli({ sub: "logs", jobId: "nope", ...io() })).toBe(1);
    expect(await runAgentCli({ sub: "logs", ...io() })).toBe(1);
    expect(out).toHaveLength(0);
  });
});

describe("the env gate on the handler", () => {
  it("registers the subagent handler only when MEMEX_AGENT_ENABLED=1", () => {
    for (const raw of [undefined, "", "0", "yes"]) {
      _resetHandlersForTesting();
      expect(registerSubagentHandlerIfEnabled(storage, raw)).toBe(false);
      expect(listHandlers()).not.toContain(SUBAGENT_JOB_KIND);
      // Not a built-in kind either, so a submit is refused while it is off.
      expect(isKnownJobKind(SUBAGENT_JOB_KIND)).toBe(false);
    }
    _resetHandlersForTesting();
    expect(registerSubagentHandlerIfEnabled(storage, "1")).toBe(true);
    expect(listHandlers()).toContain(SUBAGENT_JOB_KIND);
    expect(isKnownJobKind(SUBAGENT_JOB_KIND)).toBe(true);
  });
});
