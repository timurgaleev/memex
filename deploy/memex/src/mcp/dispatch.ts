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
  isWithinAllowedRoot,
  PathGuardConfigError,
} from "../core/path_guard.ts";
import {
  logFriction,
  VALID_FRICTION_KINDS,
  type FrictionKind,
} from "../core/friction.ts";
import type { EntityType } from "../core/entities.ts";
import { makeCaptureCallback } from "../core/eval-capture.ts";
import {
  putPage,
  appendPage,
  deletePage,
  getPage,
  listPages,
  pageVersions,
  type PageInput,
} from "../core/pages.ts";
import {
  addLink,
  removeLink,
  graphNeighbors,
  graphQuery,
  syncWikilinksForPage,
  type GraphNeighborsOptions,
  type GraphQueryOptions,
} from "../core/links.ts";

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
      case "page_put":
        return await callPagePut(storage, args);
      case "page_append":
        return await callPageAppend(storage, args);
      case "page_delete":
        return await callPageDelete(storage, args);
      case "page_get":
        return await callPageGet(storage, args);
      case "page_list":
        return await callPageList(storage, args);
      case "page_versions":
        return await callPageVersions(storage, args);
      case "link":
        return await callLink(storage, args);
      case "unlink":
        return await callUnlink(storage, args);
      case "graph_neighbors":
        return await callGraphNeighbors(storage, args);
      case "graph_query":
        return await callGraphQuery(storage, args);
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
    let allowed: boolean;
    try {
      allowed = isWithinAllowedRoot(path);
    } catch (e) {
      if (e instanceof PathGuardConfigError) return errResult(e.message);
      throw e;
    }
    if (!allowed) {
      return errResult(
        "index: path is outside the configured MEMEX_VAULT_PATHS / " +
          "MEMEX_CODE_PATHS roots — refusing to index",
      );
    }
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

const VALID_FRICTION = VALID_FRICTION_KINDS;

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

// ---------------------------------------------------------------------------
// Page tools — DB-canonical page store. Writes (page_put, page_append,
// page_delete) are listed in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC so the
// public bearer cannot reach them; the HTTP routes additionally require
// the internal-token. MCP dispatch trusts the transport layer to have
// already enforced those gates.
// ---------------------------------------------------------------------------

function asPageInput(args: Record<string, unknown>): PageInput | string {
  if (typeof args["slug"] !== "string") return "page_put: `slug` is required";
  if (typeof args["type"] !== "string") return "page_put: `type` is required";
  const input: PageInput = { slug: args["slug"], type: args["type"] };
  if (typeof args["title"] === "string") input.title = args["title"];
  if (
    typeof args["compiled_truth"] === "object" &&
    args["compiled_truth"] !== null
  ) {
    input.compiled_truth = args["compiled_truth"] as Record<string, unknown>;
  }
  if (typeof args["markdown_body"] === "string") {
    input.markdown_body = args["markdown_body"];
  }
  if (typeof args["written_by"] === "string") {
    input.written_by = args["written_by"];
  }
  if (typeof args["allowAdHocType"] === "boolean") {
    input.allowAdHocType = args["allowAdHocType"];
  }
  return input;
}

async function callPagePut(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const input = asPageInput(args);
  if (typeof input === "string") return errResult(input);
  const r = await putPage(storage, input);
  if (r.changed) {
    await syncWikilinksForPage(storage, r.slug, input.markdown_body ?? "");
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageAppend(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_append: `slug` is required");
  }
  if (typeof args["content"] !== "string" || args["content"].length === 0) {
    return errResult("page_append: `content` is required");
  }
  const r = await appendPage(storage, {
    slug: args["slug"],
    content: args["content"],
    ...(typeof args["written_by"] === "string"
      ? { written_by: args["written_by"] }
      : {}),
  });
  if (r.changed) {
    const fresh = await getPage(storage, r.slug);
    await syncWikilinksForPage(storage, r.slug, fresh?.markdown_body ?? "");
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageDelete(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_delete: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await deletePage(storage, args["slug"], writtenBy);
  return jsonResult({ ok: true, ...r });
}

async function callPageGet(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_get: `slug` is required");
  }
  const page = await getPage(storage, args["slug"]);
  if (!page) return errResult(`page not found: ${args["slug"]}`);
  return jsonResult({ ok: true, page });
}

async function callPageList(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listPages>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const pages = await listPages(storage, opts);
  return jsonResult({ ok: true, pages });
}

async function callPageVersions(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_versions: `slug` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
  const versions = await pageVersions(storage, args["slug"], limit);
  return jsonResult({ ok: true, versions });
}

// ---------------------------------------------------------------------------
// Graph tools — typed page-to-page links. Writes (link, unlink) are
// in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads (graph_neighbors,
// graph_query) are open under the public-bearer.
// ---------------------------------------------------------------------------

async function callLink(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["source_slug"] !== "string")
    return errResult("link: `source_slug` is required");
  if (typeof args["target_slug"] !== "string")
    return errResult("link: `target_slug` is required");
  if (typeof args["type"] !== "string")
    return errResult("link: `type` is required");
  const input: Parameters<typeof addLink>[1] = {
    source_slug: args["source_slug"],
    target_slug: args["target_slug"],
    type: args["type"],
  };
  if (typeof args["confidence"] === "number")
    input.confidence = args["confidence"];
  if (typeof args["source_chunk_id"] === "string")
    input.source_chunk_id = args["source_chunk_id"];
  if (typeof args["allowAdHocType"] === "boolean")
    input.allowAdHocType = args["allowAdHocType"];
  const r = await addLink(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callUnlink(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["source_slug"] !== "string")
    return errResult("unlink: `source_slug` is required");
  if (typeof args["target_slug"] !== "string")
    return errResult("unlink: `target_slug` is required");
  if (typeof args["type"] !== "string")
    return errResult("unlink: `type` is required");
  const r = await removeLink(storage, {
    source_slug: args["source_slug"],
    target_slug: args["target_slug"],
    type: args["type"],
  });
  return jsonResult({ ok: true, ...r });
}

async function callGraphNeighbors(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("graph_neighbors: `slug` is required");
  const opts: GraphNeighborsOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (
    args["direction"] === "outbound" ||
    args["direction"] === "inbound" ||
    args["direction"] === "both"
  )
    opts.direction = args["direction"] as GraphNeighborsOptions["direction"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const links = await graphNeighbors(storage, args["slug"], opts);
  return jsonResult({ ok: true, slug: args["slug"], links });
}

async function callGraphQuery(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["type"] !== "string")
    return errResult("graph_query: `type` is required");
  const opts: GraphQueryOptions = { type: args["type"] };
  if (typeof args["source_slug"] === "string")
    opts.source_slug = args["source_slug"];
  if (typeof args["target_slug"] === "string")
    opts.target_slug = args["target_slug"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (!opts.source_slug && !opts.target_slug) {
    return errResult(
      "graph_query: at least one of `source_slug` or `target_slug` is required",
    );
  }
  const links = await graphQuery(storage, opts);
  return jsonResult({ ok: true, links });
}
