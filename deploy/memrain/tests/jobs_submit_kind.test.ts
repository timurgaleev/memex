/**
 * jobs_submit refuses a kind no handler exists for, instead of queueing a row
 * that burns its whole retry budget before dead-lettering.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import {
  _resetHandlersForTesting,
  registerHandler,
} from "../src/core/jobs/handlers.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-jobkind-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  _resetHandlersForTesting();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function jobCount(): Promise<number> {
  const r = await storage
    .engine()
    .query<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs");
  return r.rows[0]?.n ?? 0;
}

function submit(args: Record<string, unknown>) {
  return dispatchTool(storage, { name: "jobs_submit", arguments: args });
}

function text(r: Awaited<ReturnType<typeof submit>>): string {
  return r.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("jobs_submit kind validation", () => {
  it("refuses an unknown kind and inserts nothing", async () => {
    const before = await jobCount();
    const r = await submit({ kind: "no_such_kind" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("unknown kind");
    expect(text(r)).toContain("page_mirror");
    expect(await jobCount()).toBe(before);
  });

  it("accepts a built-in kind with an empty registry (the `memex call` process)", async () => {
    const r = await submit({ kind: "page_mirror", payload: { slug: "a" } });
    expect(r.isError).toBeFalsy();
    expect(await jobCount()).toBe(1);
  });

  it("accepts a kind registered only at runtime", async () => {
    registerHandler("custom.kind", async () => ({}));
    const r = await submit({ kind: "custom.kind" });
    expect(r.isError).toBeFalsy();
    expect(await jobCount()).toBe(1);
  });

  it("caps the echoed kind at 64 characters", async () => {
    const huge = "z".repeat(5 * 1024);
    const r = await submit({ kind: huge });
    expect(r.isError).toBe(true);
    const msg = text(r);
    expect(msg).toContain(`"${"z".repeat(64)}"`);
    expect(msg).not.toContain("z".repeat(65));
    expect(await jobCount()).toBe(0);
  });
});
