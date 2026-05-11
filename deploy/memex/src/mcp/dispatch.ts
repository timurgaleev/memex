/**
 * MCP tool dispatcher — turns a `tools/call` request body into a call
 * against existing core functions. Returns MCP-shaped content blocks
 * (`{ type: "text", text: "..." }`).
 *
 * Error handling: any thrown error becomes an `isError: true` result
 * (per MCP spec) instead of a JSON-RPC error envelope. JSON-RPC errors
 * are reserved for protocol-level failures (malformed request etc.).
 */
import type { Storage } from "../core/storage.ts";
import { hybridSearch } from "../core/search/index.ts";
import { indexDocument, indexFile } from "../core/indexer.ts";
import { findBacklinks } from "../core/backlinks.ts";
import {
  logFriction,
  type FrictionKind,
} from "../core/friction.ts";
import type { EntityType } from "../core/entities.ts";
import { makeCaptureCallback } from "../core/eval-capture.ts";

export interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolContentBlock[];
  isError?: boolean;
}

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  "wikilink",
  "tag",
  "date",
]);

export async function dispatchTool(
  storage: Storage,
  req: ToolCallRequest,
): Promise<ToolCallResult> {
  const args = req.arguments ?? {};
  try {
    switch (req.name) {
      case "search":
        return await callSearch(storage, args);
      case "index":
        return await callIndex(storage, args);
      case "backlinks":
        return await callBacklinks(storage, args);
      case "stats":
        return await callStats(storage);
      case "log_friction":
        return await callLogFriction(storage, args);
      default:
        return errResult(`unknown tool: ${req.name}`);
    }
  } catch (e) {
    return errResult(e instanceof Error ? e.message : String(e));
  }
}

function errResult(msg: string): ToolCallResult {
  return {
    content: [{ type: "text", text: msg }],
    isError: true,
  };
}

function jsonResult(payload: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function callSearch(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const q = args["q"];
  if (typeof q !== "string" || q.length === 0) {
    return errResult("search: `q` is required");
  }
  const kArg = args["k"];
  let k = 5;
  if (kArg !== undefined) {
    if (!Number.isInteger(kArg) || (kArg as number) < 1 || (kArg as number) > 100) {
      return errResult("search: `k` must be an integer in [1, 100]");
    }
    k = kArg as number;
  }
  const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
    toolName: "mcp.search",
    remote: true,
  });
  const hits = await hybridSearch(
    storage,
    q,
    onCapture ? { k, onCapture } : { k },
  );
  return jsonResult({ ok: true, hits });
}

async function callIndex(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const path = args["path"];
  if (typeof path === "string" && path.length > 0) {
    const r = await indexFile(storage, path);
    return jsonResult({ ok: true, ...r });
  }
  const sourcePath = args["sourcePath"];
  const text = args["text"];
  if (typeof sourcePath === "string" && typeof text === "string") {
    const r = await indexDocument(storage, { sourcePath, text });
    return jsonResult({ ok: true, ...r });
  }
  return errResult("index: pass either `path` or both `sourcePath` and `text`");
}

async function callBacklinks(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const name = args["name"];
  if (typeof name !== "string" || name.length === 0) {
    return errResult("backlinks: `name` is required");
  }
  const opts: Parameters<typeof findBacklinks>[2] = {};
  const type = args["type"];
  if (type !== undefined) {
    if (typeof type !== "string" || !VALID_ENTITY_TYPES.has(type as EntityType)) {
      return errResult(`backlinks: invalid type ${String(type)}`);
    }
    opts.type = type as EntityType;
  }
  const limit = args["limit"];
  if (limit !== undefined) {
    if (
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 1000
    ) {
      return errResult("backlinks: `limit` must be in [1, 1000]");
    }
    opts.limit = limit as number;
  }
  const hits = await findBacklinks(storage, name, opts);
  return jsonResult({ ok: true, name, hits });
}

async function callStats(storage: Storage): Promise<ToolCallResult> {
  const stats = await storage.stats();
  return jsonResult({ ok: true, ...stats });
}

const VALID_FRICTION: ReadonlySet<FrictionKind> = new Set([
  "search-miss",
  "wrong-answer",
  "tool-error",
  "low-confidence",
  "other",
  "delight",
  "phase-marker",
  "interrupted",
]);

const VALID_SEVERITY: ReadonlySet<string> = new Set([
  "confused",
  "error",
  "blocker",
  "nit",
]);

async function callLogFriction(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const kind = args["kind"];
  if (typeof kind !== "string" || !VALID_FRICTION.has(kind as FrictionKind)) {
    return errResult(
      `log_friction: kind must be one of ${[...VALID_FRICTION].join("|")}`,
    );
  }
  const input: Parameters<typeof logFriction>[1] = {
    kind: kind as FrictionKind,
  };
  if (typeof args["query"] === "string") input.query = args["query"];
  if (typeof args["reason"] === "string") input.reason = args["reason"];
  if (typeof args["sourcePath"] === "string") input.sourcePath = args["sourcePath"];
  if (typeof args["severity"] === "string") {
    if (!VALID_SEVERITY.has(args["severity"])) {
      return errResult(
        `log_friction: severity must be one of ${[...VALID_SEVERITY].join("|")}`,
      );
    }
    input.severity = args["severity"] as
      | "confused"
      | "error"
      | "blocker"
      | "nit";
  }
  if (
    args["extra"] !== undefined &&
    typeof args["extra"] === "object" &&
    args["extra"] !== null
  ) {
    input.extra = args["extra"] as Record<string, unknown>;
  }
  await logFriction(storage.engine(), input);
  return jsonResult({ ok: true });
}
