/**
 * Unknown MCP arguments are refused end to end. The motivating failure:
 * `page_put {slug, body}` used to pass validation (`body` is not a declared
 * key), and the page was written without the body the caller meant to send.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

const call = (name: string, args: Record<string, unknown>): Promise<ToolCallResult> =>
  dispatchTool(storage, { name, arguments: args }, {});

const envelope = (r: ToolCallResult): any => JSON.parse(r.content[0]!.text);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-unknown-args-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("unknown MCP arguments", () => {
  it("page_put with a misspelled body key is refused and writes nothing", async () => {
    const res = await call("page_put", { slug: "notes/x", body: "hello" });
    expect(res.isError).toBe(true);
    const env = envelope(res);
    expect(env.error).toBe("invalid_params");
    expect(env.message).toContain("`body`");
    expect(env.suggestion).toContain("markdown_body");

    const get = await call("page_get", { slug: "notes/x" });
    expect(get.isError).toBe(true);
    expect(get.content[0]!.text).toMatch(/not found/i);
  });

  it("the ingest re-dispatch shape {slug, markdown_body, written_by} still writes", async () => {
    const res = await call("page_put", {
      slug: "notes/ingested",
      markdown_body: "# Ingested\n\nbody text",
      written_by: "ingest",
    });
    expect(res.isError).toBeFalsy();
    const get = envelope(await call("page_get", { slug: "notes/ingested" }));
    expect(get.ok).toBe(true);
  });
});
