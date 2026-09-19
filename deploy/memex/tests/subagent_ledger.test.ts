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
  findToolExecution,
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

describe("tool executions bound to a tool-use id (migration 114)", () => {
  it("a second begin for the same tool_use_id returns the existing row", async () => {
    const job = await newJob();
    const first = await beginToolExecution(storage, {
      job_id: job,
      turn_num: 1,
      tool_name: "search",
      input: { q: "x" },
      tool_use_id: "tooluse_a",
      run_generation: 1,
    });
    expect(first.inserted).toBe(true);
    const again = await beginToolExecution(storage, {
      job_id: job,
      turn_num: 1,
      tool_name: "page_get",
      input: { slug: "forged" },
      tool_use_id: "tooluse_a",
      run_generation: 2,
    });
    expect(again.inserted).toBe(false);
    expect(again.id).toBe(first.id);
    // The replay never overwrites what the first begin recorded.
    expect(again.existing!.tool_name).toBe("search");
    expect(again.existing!.run_generation).toBe(1);
    expect((await listToolExecutions(storage, job)).length).toBe(1);
  });

  it("run_generation and tool_use_id round-trip; findToolExecution looks a call up", async () => {
    const job = await newJob();
    await beginToolExecution(storage, {
      job_id: job,
      turn_num: 3,
      tool_name: "get_links",
      input: { slug: "a" },
      tool_use_id: "tooluse_b",
      run_generation: 7,
    });
    const row = await findToolExecution(storage, job, "tooluse_b");
    expect(row).not.toBeNull();
    expect(row!.run_generation).toBe(7);
    expect(row!.tool_use_id).toBe("tooluse_b");
    expect(row!.status).toBe("pending");
    expect(await findToolExecution(storage, job, "tooluse_missing")).toBeNull();
  });

  it("the same tool_use_id under another job is a separate row", async () => {
    const a = await newJob();
    const b = await newJob();
    const ra = await beginToolExecution(storage, {
      job_id: a, turn_num: 1, tool_name: "x", input: {}, tool_use_id: "tooluse_c",
    });
    const rb = await beginToolExecution(storage, {
      job_id: b, turn_num: 1, tool_name: "x", input: {}, tool_use_id: "tooluse_c",
    });
    expect(ra.inserted).toBe(true);
    expect(rb.inserted).toBe(true);
    expect(ra.id).not.toBe(rb.id);
  });

  it("rows without a tool_use_id never conflict", async () => {
    const job = await newJob();
    await beginToolExecution(storage, { job_id: job, turn_num: 0, tool_name: "x", input: {} });
    await beginToolExecution(storage, { job_id: job, turn_num: 0, tool_name: "x", input: {} });
    const rows = await listToolExecutions(storage, job);
    expect(rows.length).toBe(2);
    expect(rows[0]!.tool_use_id).toBeNull();
    expect(rows[0]!.run_generation).toBeNull();
  });
});

describe("ids from a driver that returns int8 as a string", () => {
  // The Postgres driver hands BIGSERIAL ids back as strings; PGLite does not.
  // Simulate that so begin -> finish works on both engines.
  it("begin, find and finish accept a stringified id", async () => {
    const jobId = await newJob();
    const engine = storage.engine();
    const real = engine.query.bind(engine);
    (engine as any).query = async (sql: string, params?: unknown[]) => {
      const r = await real(sql, params as any);
      return { ...r, rows: r.rows.map((row: any) => ("id" in row ? { ...row, id: String(row.id) } : row)) };
    };
    try {
      const begun = await beginToolExecution(storage, {
        job_id: jobId,
        turn_num: 1,
        tool_name: "search",
        input: { q: "x" },
        tool_use_id: "tu-1",
      });
      expect(typeof begun.id).toBe("number");
      const fin = await finishToolExecution(storage, { id: begun.id, status: "succeeded", output: { text: "ok" } });
      expect(fin.updated).toBe(true);
      const found = await findToolExecution(storage, jobId, "tu-1");
      expect(typeof found!.id).toBe("number");
      const again = await beginToolExecution(storage, {
        job_id: jobId,
        turn_num: 1,
        tool_name: "search",
        input: { q: "x" },
        tool_use_id: "tu-1",
      });
      expect(again.inserted).toBe(false);
      expect(typeof again.id).toBe("number");
      expect((await listToolExecutions(storage, jobId)).every((r) => typeof r.id === "number")).toBe(true);
    } finally {
      (engine as any).query = real;
    }
  });
});
