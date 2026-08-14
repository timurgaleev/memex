/**
 * `memex call <tool> [--args '<json>']` — invoke any MCP tool from the shell.
 *
 * A convenience for operators + smoke tests: exercise a tool exactly as the
 * MCP transport would, without standing up an MCP client. Dispatch runs on the
 * INTERNAL ingress (`isPublic: false`) — same trust level as the other local
 * commands (`reindex`, `apply-migrations`) — so write tools and full,
 * unredacted read output are available. The public-bearer surface is a
 * separate path and is unaffected by this command.
 *
 * Returns the process exit code (1 when the tool returns an error result,
 * else 0) so the caller can `process.exit` on it — composes in scripts.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { dispatchTool } from "../mcp/dispatch.ts";

export interface CallCmdOptions {
  /** The MCP tool name (e.g. `search`, `stats`, `page_get`). */
  tool: string;
  /** Optional JSON object of arguments, as a raw string (parsed here). */
  argsJson?: string;
  /** Override the config path (tests point this at a temp dir). */
  configPath?: string;
}

export async function runCall(opts: CallCmdOptions): Promise<number> {
  let args: Record<string, unknown> = {};
  if (opts.argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opts.argsJson);
    } catch (e) {
      throw new Error(
        `memex call: --args must be valid JSON (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("memex call: --args must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  }

  const config = loadConfig(opts.configPath);
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const result = await dispatchTool(
      storage,
      { name: opts.tool, arguments: args },
      { isPublic: false },
    );
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
    console.log(text);
    return result.isError ? 1 : 0;
  });
}
