/**
 * subagent_ledger tests (Phase A.5) -- schema + thin CRUD wrapper.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { submitJob } from "../src/core/jobs/dag.ts";
import {
  appendMessage,
  beginToolExecution,
  finishToolExecution,
  listMessages,
  listToolExecutions,
} from "../src/core/subagent_ledger.ts";

let tmp: string;
let storage: Storage;

async function newJob(): Promise<string> {
  const r = await submitJob(storage.engine(), {
    kind: "subagent.test",
    payload: {},
  });
  return r.id;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ledger-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("appendMessage", () => {
  it("validates job_id, turn_num, role", async () => {
    await expect(
      appendMessage(storage, {
        job_id: "",
        turn_num: 0,
        role: "user",
        content: {},
      }),
    ).rejects.toThrow(/job_id/);
    const job = await newJob();
    await expect(
      appendMessage(storage, {
        job_id: job,
        turn_num: -1,
        role: "user",
        content: {},
      }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      appendMessage(storage, {
        job_id: job,
        turn_num: 0,
        role: "bogus" as never,
        content: {},
      }),
    ).rejects.toThrow(/role must be/);
  });

  it("inserts and is idempotent on (job_id, turn_num)", async () => {
    const job = await newJob();
    const first = await appendMessage(storage, {
      job_id: job,
      turn_num: 0,
      role: "user",
      content: { text: "hello" },
    });
    expect(first.inserted).toBe(true);
    const second = await appendMessage(storage, {
      job_id: job,
      turn_num: 0,
      role: "user",
      content: { text: "hello" },
    });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("listMessages orders by turn_num ASC", async () => {
    const job = await newJob();
    await appendMessage(storage, {
      job_id: job,
      turn_num: 2,
      role: "assistant",
      content: { text: "2" },
    });
    await appendMessage(storage, {
      job_id: job,
      turn_num: 0,
      role: "user",
      content: { text: "0" },
    });
    await appendMessage(storage, {
      job_id: job,
      turn_num: 1,
      role: "tool_result",
      content: { text: "1" },
    });
    const r = await listMessages(storage, job);
    expect(r.map((x) => x.turn_num)).toEqual([0, 1, 2]);
  });

  it("CASCADE deletes messages when the job row is removed", async () => {
    const job = await newJob();
    await appendMessage(storage, {
      job_id: job,
      turn_num: 0,
      role: "user",
      content: {},
    });
    await storage.engine().exec(`DELETE FROM jobs WHERE id = '${job}'`);
    const r = await listMessages(storage, job);
    expect(r.length).toBe(0);
  });
});

describe("tool executions", () => {
  it("beginToolExecution writes a pending row", async () => {
    const job = await newJob();
    const r = await beginToolExecution(storage, {
      job_id: job,
      turn_num: 0,
      tool_name: "search",
      input: { q: "x" },
    });
    expect(r.id).toBeGreaterThan(0);
    const all = await listToolExecutions(storage, job);
    expect(all.length).toBe(1);
    expect(all[0]!.status).toBe("pending");
    expect(all[0]!.finished_at).toBeNull();
  });

  it("finishToolExecution moves pending -> succeeded with output", async () => {
    const job = await newJob();
    const { id } = await beginToolExecution(storage, {
      job_id: job,
      turn_num: 0,
      tool_name: "search",
      input: { q: "x" },
    });
    const r = await finishToolExecution(storage, {
      id,
      status: "succeeded",
      output: { hits: 3 },
    });
    expect(r.updated).toBe(true);
    const all = await listToolExecutions(storage, job);
    expect(all[0]!.status).toBe("succeeded");
    expect(all[0]!.finished_at).not.toBeNull();
  });

  it("finishToolExecution refuses non-pending rows and reports current status", async () => {
    const job = await newJob();
    const { id } = await beginToolExecution(storage, {
      job_id: job,
      turn_num: 0,
      tool_name: "x",
      input: {},
    });
    const ok = await finishToolExecution(storage, { id, status: "succeeded" });
    expect(ok.updated).toBe(true);
    expect(ok.current_status).toBe("succeeded");
    const r = await finishToolExecution(storage, { id, status: "failed" });
    expect(r.updated).toBe(false);
    expect(r.current_status).toBe("succeeded");
  });

  it("rejects 'pending' as a finish status", async () => {
    const job = await newJob();
    const { id } = await beginToolExecution(storage, {
      job_id: job,
      turn_num: 0,
      tool_name: "x",
      input: {},
    });
    await expect(
      finishToolExecution(storage, { id, status: "pending" as never }),
    ).rejects.toThrow(/succeeded\|failed\|skipped/);
  });

  it("CASCADE deletes tool executions when the job is removed", async () => {
    const job = await newJob();
    await beginToolExecution(storage, {
      job_id: job,
      turn_num: 0,
      tool_name: "x",
      input: {},
    });
    await storage.engine().exec(`DELETE FROM jobs WHERE id = '${job}'`);
    const r = await listToolExecutions(storage, job);
    expect(r.length).toBe(0);
  });
});
