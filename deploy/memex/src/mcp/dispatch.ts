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
import { hybridSearch, type SearchOptions } from "../core/search/index.ts";
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
  restorePage,
  revertPage,
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
  traverseGraph,
  syncWikilinksForPage,
  type GraphNeighborsOptions,
  type GraphQueryOptions,
  type TraverseGraphOptions,
} from "../core/links.ts";
import { syncMentionsForPage } from "../core/gazetteer.ts";
import { syncTypedLinksForPage, typedLinksEnabled } from "../core/typed-links.ts";
import {
  indexPageIntoSearch,
  removePageFromSearch,
  isPageSourcePath,
} from "../core/page-index.ts";
import { getChunksForPage, getChunksForSource } from "../core/chunks-read.ts";
import { resolveSlugs } from "../core/slug-resolve.ts";
import { addTag, removeTag, getTags } from "../core/tags.ts";
import { relationalRecall } from "../core/search/relational-recall.ts";
import { getLinks, listLinkSources } from "../core/links-read.ts";
import {
  findOrphans,
  findExperts,
  findContradictions,
  findTrajectory,
  type FindOrphansOptions,
  type FindExpertsOptions,
  type FindContradictionsOptions,
  type FindTrajectoryOptions,
} from "../core/insights.ts";
import { getRecentSalience, findAnomalies } from "../core/usage-insights.ts";
import { recallFact, forgetFact } from "../core/facts-recall.ts";
import { brainIdentity } from "../core/identity.ts";
import { purgeDeletedPages } from "../core/pages-purge.ts";
import { queryRefine } from "../core/search/query-refine.ts";
import {
  reconcileFactsForPage,
  purgeFenceFactsForPage,
} from "../core/facts-reconcile.ts";
import {
  addTimelineEvent,
  getEntityTimeline,
  type ListTimelineOptions,
} from "../core/timeline.ts";
import {
  addFact,
  listFacts,
  entityRecall,
  type ListFactsOptions,
  type EntityRecallOptions,
} from "../core/facts.ts";
import {
  cancelJob,
  getJob,
  listJobs,
  submitJob,
  type ListJobsOptions,
  type SubmitJobInput,
} from "../core/jobs/dag.ts";
// Public-ingress body redaction is shared with the REST routes via a
// neutral core module so neither ingress layer imports the other (an
// http/ import here created a module cycle).
import {
  redactBodies,
  redactBody,
  redactFacts,
  redactTimeline,
  redactBacklinks,
  redactJob,
  redactGraphLinks,
  publicReadBodiesAllowed,
  publicSafeErrorMessage,
} from "../core/public_redaction.ts";
import { OperationError, isOperationError } from "../core/operation-error.ts";
import { OPERATIONS, validateParams } from "./operations.ts";

// Operation lookup by tool name, built once (the contract is static).
const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

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

/** Per-call options the transport supplies. */
export interface DispatchOptions {
  /** True when the request arrived over the public ingress
   *  (`brain.<domain>/mcp` via Cloudflare). Read tools then redact note
   *  bodies unless `MEMEX_PUBLIC_READ_BODIES` is opted-in — identical to
   *  the REST routes so the two ingress paths cannot diverge. */
  isPublic?: boolean;
}

export async function dispatchTool(
  storage: Storage,
  req: ToolCallRequest,
  opts: DispatchOptions = {},
): Promise<ToolCallResult> {
  const args = req.arguments ?? {};
  // Mirror the REST layer's public-read policy exactly: redact bodies on
  // public ingress unless the operator opted into MEMEX_PUBLIC_READ_BODIES.
  const redact =
    (opts.isPublic ?? false) && !publicReadBodiesAllowed();
  // Graph-edge provenance (source_chunk_id, written_at, confidence, row id)
  // is structural metadata — NOT a note body — so it is stripped on ANY
  // public ingress, independent of MEMEX_PUBLIC_READ_BODIES (that flag only
  // governs free-text bodies). The public graph projection keeps slugs + the
  // edge type regardless; provenance is never returned publicly.
  const redactGraph = opts.isPublic ?? false;
  try {
    // Enforce the declared param contract (type / enum / min-max of present
    // params) before dispatch. Known tools only — an unknown name falls through
    // to the switch default. Throws OperationError('invalid_params'), rendered
    // by the catch below.
    const op = OP_BY_NAME.get(req.name);
    if (op) validateParams(op, args);
    switch (req.name) {
      case "search":
        return await callSearch(storage, args, redact);
      case "index":
        return await callIndex(storage, args);
      case "backlinks":
        return await callBacklinks(storage, args, redact);
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
      case "page_restore":
        return await callPageRestore(storage, args);
      case "page_revert":
        return await callPageRevert(storage, args);
      case "page_get":
        return await callPageGet(storage, args, redact);
      case "page_list":
        return await callPageList(storage, args, redact);
      case "page_versions":
        return await callPageVersions(storage, args, redact);
      case "link":
        return await callLink(storage, args);
      case "unlink":
        return await callUnlink(storage, args);
      case "graph_neighbors":
        return await callGraphNeighbors(storage, args, redactGraph);
      case "graph_query":
        return await callGraphQuery(storage, args, redactGraph);
      case "traverse_graph":
        return await callTraverseGraph(storage, args);
      case "get_chunks":
        return await callGetChunks(storage, args);
      case "resolve_slugs":
        return await callResolveSlugs(storage, args);
      case "add_tag":
        return await callAddTag(storage, args);
      case "remove_tag":
        return await callRemoveTag(storage, args);
      case "get_tags":
        return await callGetTags(storage, args);
      case "relational_recall":
        return await callRelationalRecall(storage, args);
      case "add_fact":
        return await callAddFact(storage, args);
      case "add_timeline_event":
        return await callAddTimelineEvent(storage, args);
      case "entity_facts":
        return await callEntityFacts(storage, args, redact);
      case "entity_timeline":
        return await callEntityTimeline(storage, args, redact);
      case "entity_recall":
        return await callEntityRecall(storage, args, redact);
      case "jobs_submit":
        return await callJobsSubmit(storage, args);
      case "jobs_list":
        return await callJobsList(storage, args, redact);
      case "jobs_get":
        return await callJobsGet(storage, args, redact);
      case "jobs_cancel":
        return await callJobsCancel(storage, args);
      case "jobs_logs":
        return await callJobsLogs(storage, args, redact);
      case "get_links":
        return await callGetLinks(storage, args);
      case "list_link_sources":
        return await callListLinkSources(storage);
      case "find_orphans":
        return await callFindOrphans(storage, args);
      case "find_experts":
        return await callFindExperts(storage, args);
      case "find_contradictions":
        return await callFindContradictions(storage, args);
      case "find_trajectory":
        return await callFindTrajectory(storage, args);
      case "get_recent_salience":
        return await callGetRecentSalience(storage, args);
      case "find_anomalies":
        return await callFindAnomalies(storage, args);
      case "recall":
        return await callRecall(storage, args);
      case "forget_fact":
        return await callForgetFact(storage, args);
      case "get_brain_identity":
        return await callGetBrainIdentity(storage);
      case "purge_deleted_pages":
        return await callPurgeDeletedPages(storage, args);
      case "query":
        return await callQuery(storage, args);
      default:
        throw new OperationError(
          "not_found",
          `unknown tool: ${req.name}`,
          "Call tools/list for the available tools.",
        );
    }
  } catch (e) {
    // A KNOWN, validated failure carries a structured envelope: the agent gets
    // a machine code + recovery hint instead of a bare string. On public
    // ingress `toEnvelope` withholds the free-text `message` (see
    // operation-error.ts), so only the constrained code + static suggestion/
    // docs cross the boundary.
    if (isOperationError(e)) {
      return errResult(JSON.stringify(e.toEnvelope(opts.isPublic ?? false)));
    }
    // A raw exception (Postgres schema, DSN host, stack internals) must NOT
    // leak across the public boundary; fully redact it there, log server-side.
    return errResult(publicSafeErrorMessage(e, opts.isPublic ?? false));
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
  redact = false,
): Promise<ToolCallResult> {
  const q = args["q"];
  if (typeof q !== "string" || q.length === 0) {
    throw new OperationError(
      "invalid_params",
      "search: `q` is required",
      "Pass a non-empty `q` string.",
    );
  }
  const kArg = args["k"];
  let k = 5;
  if (kArg !== undefined) {
    if (!Number.isInteger(kArg) || (kArg as number) < 1 || (kArg as number) > 100) {
      throw new OperationError(
        "invalid_params",
        "search: `k` must be an integer in [1, 100]",
        "Pass `k` as an integer between 1 and 100.",
      );
    }
    k = kArg as number;
  }
  const tbArg = args["token_budget"];
  let tokenBudget: number | undefined;
  if (tbArg !== undefined) {
    if (
      !Number.isInteger(tbArg) ||
      (tbArg as number) < 1 ||
      (tbArg as number) > 200000
    ) {
      throw new OperationError(
        "invalid_params",
        "search: `token_budget` must be an integer in [1, 200000]",
        "Pass `token_budget` as an integer between 1 and 200000.",
      );
    }
    tokenBudget = tbArg as number;
  }
  const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
    toolName: "mcp.search",
    remote: true,
  });
  const searchOpts: SearchOptions = { k };
  if (onCapture) searchOpts.onCapture = onCapture;
  if (tokenBudget !== undefined) searchOpts.tokenBudget = tokenBudget;
  const hits = await hybridSearch(storage, q, searchOpts);
  // Public ingress: drop page-derived mirror hits entirely. A page slug
  // (`page://people/<name>`) and title are author-written identifiers — the
  // exact PII the redaction layer suppresses — and search is a free-text
  // enumeration surface. page_put is internal-only; its content stays
  // internal-only in search too. Internal callers (no redaction) still get
  // page hits. Flip this if public page discovery is ever wanted.
  const visible = redact
    ? (hits as unknown as Record<string, unknown>[]).filter(
        (h) =>
          !(
            typeof h["sourcePath"] === "string" &&
            isPageSourcePath(h["sourcePath"])
          ),
      )
    : hits;
  const out = redact
    ? redactBodies(visible as unknown as Record<string, unknown>[])
    : visible;
  return jsonResult({ ok: true, hits: out });
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
  redact = false,
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
  // Public ingress: `surfaceForm` is note-authored free text — strip it,
  // mirroring the search/page/fact body redaction policy.
  const out = redact
    ? redactBacklinks(hits as unknown as Record<string, unknown>[])
    : hits;
  return jsonResult({ ok: true, name, hits: out });
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
  // `type` is OPTIONAL: when omitted, putPage infers it from the slug's first
  // segment (people/… → person), defaulting to `note`.
  const input: PageInput = { slug: args["slug"] };
  if (typeof args["type"] === "string") input.type = args["type"];
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
  let searchIndexed: boolean | undefined;
  if (r.changed) {
    // Fetch the canonical row once: an omitted-title/-body re-put preserves
    // the stored values, so `input` alone may not reflect what's searchable.
    const page = await getPage(storage, r.slug);
    const body = page?.markdown_body ?? input.markdown_body ?? "";
    await syncWikilinksForPage(storage, r.slug, body);
    // Gazetteer auto-link (opt-in, MEMEX_GAZETTEER=1) — derives `mentions`
    // edges from plain-text references to known entity pages.
    await syncMentionsForPage(storage, r.slug, body);
    // Typed-link inference (opt-in, MEMEX_TYPED_LINKS=1) — derive works_at /
    // founded / attended / … edges from frontmatter fields.
    if (typedLinksEnabled() && page) {
      await syncTypedLinksForPage(storage, r.slug, page.type, page.compiled_truth);
    }
    // Mirror the page body into the search store so a page written via
    // page_put is findable. Best-effort: the canonical page write already
    // committed and is the source of truth — an embed failure must not fail
    // the write. The cycle backstop reconciles unindexed pages later.
    if (page) {
      searchIndexed = await mirrorPageToSearch(storage, page);
    }
  }
  // Facts-fence reconcile on EVERY put (a no-op re-put is the repair path) —
  // it re-reads the current body and guards on content_hash itself.
  await reconcileFactsForPage(storage, r.slug, r.content_hash);
  return jsonResult({ ok: true, ...r, ...(searchIndexed !== undefined ? { search_indexed: searchIndexed } : {}) });
}

/**
 * Best-effort mirror of a page into the search store. Returns whether the
 * mirror succeeded. Never throws — the DB-canonical page is the source of
 * truth; search is a derived projection the cycle can rebuild.
 */
async function mirrorPageToSearch(
  storage: Storage,
  page: {
    slug: string;
    title: string | null;
    markdown_body: string;
    content_hash?: string;
  },
): Promise<boolean> {
  try {
    await indexPageIntoSearch(storage, {
      slug: page.slug,
      title: page.title,
      markdown_body: page.markdown_body,
      ...(page.content_hash ? { content_hash: page.content_hash } : {}),
    });
    return true;
  } catch (e) {
    console.error(
      `[page-index] failed to mirror page ${page.slug} into search:`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
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
  let searchIndexed: boolean | undefined;
  if (r.changed) {
    const fresh = await getPage(storage, r.slug);
    const body = fresh?.markdown_body ?? "";
    await syncWikilinksForPage(storage, r.slug, body);
    await syncMentionsForPage(storage, r.slug, body);
    if (typedLinksEnabled() && fresh) {
      await syncTypedLinksForPage(storage, r.slug, fresh.type, fresh.compiled_truth);
    }
    if (fresh) searchIndexed = await mirrorPageToSearch(storage, fresh);
  }
  await reconcileFactsForPage(storage, r.slug, r.content_hash);
  return jsonResult({ ok: true, ...r, ...(searchIndexed !== undefined ? { search_indexed: searchIndexed } : {}) });
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
  // A soft-deleted page must stop serving its fence-derived facts; explicit
  // (NULL source_markdown_slug) facts are left intact.
  if (!r.already_deleted) {
    await purgeFenceFactsForPage(storage, args["slug"]);
    // Drop the page's search mirror so a deleted page stops appearing in
    // search hits. Best-effort — the soft-delete already succeeded.
    try {
      await removePageFromSearch(storage, args["slug"]);
    } catch (e) {
      console.error(
        `[page-index] failed to drop search mirror for ${args["slug"]}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageRestore(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_restore: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await restorePage(storage, args["slug"], writtenBy);
  if (r.restored) {
    // Re-derive ONLY what delete tore down: facts (purged on delete) and the
    // search mirror (dropped on delete). Links/mentions/typed-links are NOT
    // touched by a soft-delete, so they're already intact — no re-sync needed
    // (this is why restore is narrower than revert, which changes the body).
    const page = await getPage(storage, r.slug);
    if (page) {
      await reconcileFactsForPage(storage, r.slug, page.content_hash);
      await mirrorPageToSearch(storage, page);
    }
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageRevert(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_revert: `slug` is required");
  }
  const v = args["version"];
  if (!Number.isInteger(v) || (v as number) < 1) {
    return errResult("page_revert: `version` must be a positive integer");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await revertPage(storage, args["slug"], v as number, writtenBy);
  if (r.reverted) {
    // The body changed — refresh links, mentions, facts, and the search mirror,
    // exactly as a normal page_put would.
    const page = await getPage(storage, r.slug);
    if (page) {
      await syncWikilinksForPage(storage, r.slug, page.markdown_body);
      await syncMentionsForPage(storage, r.slug, page.markdown_body);
      if (typedLinksEnabled()) {
        await syncTypedLinksForPage(storage, r.slug, page.type, page.compiled_truth);
      }
      await reconcileFactsForPage(storage, r.slug, page.content_hash);
      await mirrorPageToSearch(storage, page);
    }
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageGet(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_get: `slug` is required");
  }
  const page = await getPage(storage, args["slug"]);
  if (!page) return errResult(`page not found: ${args["slug"]}`);
  return jsonResult({
    ok: true,
    page: redact ? redactBody(page as unknown as Record<string, unknown>) : page,
  });
}

async function callPageList(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listPages>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const pages = await listPages(storage, opts);
  const out = redact
    ? pages.map((p) => redactBody(p as unknown as Record<string, unknown>))
    : pages;
  return jsonResult({ ok: true, pages: out });
}

async function callPageVersions(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_versions: `slug` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
  const versions = await pageVersions(storage, args["slug"], limit);
  // Version rows carry body snapshots; redact each through the same
  // page allowlist so public callers see metadata only.
  const out = redact
    ? versions.map((v) => redactBody(v as unknown as Record<string, unknown>))
    : versions;
  return jsonResult({ ok: true, versions: out });
}

// ---------------------------------------------------------------------------
// Graph tools — typed page-to-page links. Writes (link, unlink) are
// in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads (graph_neighbors,
// graph_query) are allowed under the public-bearer but redacted: the
// public projection keeps slugs + the edge type and drops provenance
// (source_chunk_id / written_at), the confidence signal, and the row id.
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
  redact: boolean,
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
  return jsonResult({
    ok: true,
    slug: args["slug"],
    links: redact
      ? redactGraphLinks(links as unknown as Record<string, unknown>[])
      : links,
  });
}

async function callGraphQuery(
  storage: Storage,
  args: Record<string, unknown>,
  redact: boolean,
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
  return jsonResult({
    ok: true,
    links: redact
      ? redactGraphLinks(links as unknown as Record<string, unknown>[])
      : links,
  });
}

async function callTraverseGraph(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["start_slug"] !== "string" || args["start_slug"].length === 0) {
    return errResult("traverse_graph: `start_slug` is required");
  }
  const opts: TraverseGraphOptions = {};
  if (typeof args["direction"] === "string")
    opts.direction = args["direction"] as TraverseGraphOptions["direction"];
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (Number.isInteger(args["max_depth"])) opts.maxDepth = args["max_depth"] as number;
  if (Number.isInteger(args["limit"])) opts.limit = args["limit"] as number;
  try {
    // Returns only {slug, depth} — slugs are already public for the graph read
    // surface (graph_neighbors/graph_query expose them), so no extra redaction.
    const hits = await traverseGraph(storage, args["start_slug"], opts);
    return jsonResult({ ok: true, start: args["start_slug"], hits });
  } catch (e) {
    return errResult(
      `traverse_graph: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function callGetChunks(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const hasSlug = typeof args["slug"] === "string" && args["slug"].length > 0;
  const hasSrc =
    typeof args["source_path"] === "string" && args["source_path"].length > 0;
  if (!hasSlug && !hasSrc) {
    return errResult("get_chunks: provide `slug` or `source_path`");
  }
  const chunks = hasSlug
    ? await getChunksForPage(storage, args["slug"] as string)
    : await getChunksForSource(storage, args["source_path"] as string);
  return jsonResult({ ok: true, chunks });
}

async function callResolveSlugs(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("resolve_slugs: `query` is required");
  }
  const opts: Parameters<typeof resolveSlugs>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  // Only slugs/titles/scores returned — already public via page_get/search.
  const hits = await resolveSlugs(storage, args["query"], opts);
  return jsonResult({ ok: true, query: args["query"], hits });
}

async function callAddTag(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("add_tag: `slug` is required");
  if (typeof args["tag"] !== "string") return errResult("add_tag: `tag` is required");
  try {
    await addTag(storage, args["slug"], args["tag"]);
    return jsonResult({ ok: true, slug: args["slug"], tag: args["tag"] });
  } catch (e) {
    return errResult(`add_tag: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function callRemoveTag(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("remove_tag: `slug` is required");
  if (typeof args["tag"] !== "string") return errResult("remove_tag: `tag` is required");
  await removeTag(storage, args["slug"], args["tag"]);
  return jsonResult({ ok: true, slug: args["slug"], tag: args["tag"] });
}

async function callGetTags(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("get_tags: `slug` is required");
  const tags = await getTags(storage, args["slug"]);
  return jsonResult({ ok: true, slug: args["slug"], tags });
}

async function callRelationalRecall(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("relational_recall: `query` is required");
  }
  const opts: Parameters<typeof relationalRecall>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (typeof args["depth"] === "number") opts.depth = args["depth"];
  const hits = await relationalRecall(storage, args["query"], opts);
  return jsonResult({ ok: true, query: args["query"], hits });
}

// ---------------------------------------------------------------------------
// Entity-facts + timeline tools (Phase A.3). Writes (add_fact,
// add_timeline_event) are in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads
// (entity_facts, entity_timeline, entity_recall) are open.
// ---------------------------------------------------------------------------

async function callAddFact(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["entity_slug"] !== "string")
    return errResult("add_fact: `entity_slug` is required");
  if (typeof args["fact"] !== "string" || args["fact"].length === 0)
    return errResult("add_fact: `fact` is required");
  const input: Parameters<typeof addFact>[1] = {
    entity_slug: args["entity_slug"],
    fact: args["fact"],
  };
  if (typeof args["confidence"] === "number")
    input.confidence = args["confidence"];
  if (typeof args["source_slug"] === "string")
    input.source_slug = args["source_slug"];
  if (typeof args["source_chunk_id"] === "string")
    input.source_chunk_id = args["source_chunk_id"];
  if (typeof args["written_by"] === "string")
    input.written_by = args["written_by"];
  const r = await addFact(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callAddTimelineEvent(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("add_timeline_event: `slug` is required");
  if (typeof args["occurred_at"] !== "string")
    return errResult(
      "add_timeline_event: `occurred_at` is required (ISO-8601 string)",
    );
  if (typeof args["event"] !== "string" || args["event"].length === 0)
    return errResult("add_timeline_event: `event` is required");
  const input: Parameters<typeof addTimelineEvent>[1] = {
    slug: args["slug"],
    occurred_at: args["occurred_at"],
    event: args["event"],
  };
  if (typeof args["source_chunk_id"] === "string")
    input.source_chunk_id = args["source_chunk_id"];
  const r = await addTimelineEvent(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callEntityFacts(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["entity_slug"] !== "string")
    return errResult("entity_facts: `entity_slug` is required");
  const opts: ListFactsOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["source_slug"] === "string")
    opts.source_slug = args["source_slug"];
  if (args["order"] === "recency" || args["order"] === "confidence")
    opts.order = args["order"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  // Confidence decay is INTERNAL ONLY (mirrors entity_recall `query`/`decay`).
  // It reorders facts and drops expired ones using hidden `kind`/`valid_until`;
  // on the public path the text is redacted but stable ids/confidence remain,
  // so a caller could diff the decayed order against `order:"recency"` (which
  // disables decay) to infer which hidden fact expired/demoted. Force it OFF on
  // public; internal callers get it via the `MEMEX_FACT_DECAY` env default.
  if (redact) opts.decay = false;
  const facts = await listFacts(storage, args["entity_slug"], opts);
  // Public ingress: `fact` is note-derived private content — strip it,
  // mirroring the search/page body redaction policy.
  const out = redact
    ? redactFacts(facts as unknown as Record<string, unknown>[])
    : facts;
  return jsonResult({ ok: true, entity_slug: args["entity_slug"], facts: out });
}

async function callEntityTimeline(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("entity_timeline: `slug` is required");
  const opts: ListTimelineOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["until"] === "string") opts.until = args["until"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const timeline = await getEntityTimeline(storage, args["slug"], opts);
  // Public ingress: `event` is note-derived private content — strip it.
  const out = redact
    ? redactTimeline(timeline as unknown as Record<string, unknown>[])
    : timeline;
  return jsonResult({ ok: true, slug: args["slug"], timeline: out });
}

async function callEntityRecall(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("entity_recall: `slug` is required");
  const opts: EntityRecallOptions = {};
  // `query` re-orders facts by semantic similarity to caller-supplied text.
  // INTERNAL ONLY: on the public-bearer path (redact) the fact text is stripped
  // but stable identifiers remain, so query-driven REORDERING would be a
  // content oracle (probe which hidden fact moves for "funding" / "health" /
  // …) AND an unbounded per-call Bedrock cost knob. Drop it on public ingress;
  // public recall keeps the fixed confidence order.
  if (!redact && typeof args["query"] === "string" && args["query"].trim())
    opts.query = args["query"];
  // Confidence decay is INTERNAL ONLY for the same reason: it REORDERS facts
  // (and DROPS expired ones) using hidden `kind`/`valid_until` metadata. On the
  // public path the fact text is stripped but stable ids/confidence remain, so
  // a caller could diff decayed vs `order:"recency"` output to infer which
  // hidden fact expired/demoted. Force decay OFF on public; internal recall
  // honors `MEMEX_FACT_DECAY` via the recall layer's env default.
  if (redact) opts.decay = false;
  if (typeof args["fact_limit"] === "number")
    opts.fact_limit = args["fact_limit"];
  if (typeof args["timeline_limit"] === "number")
    opts.timeline_limit = args["timeline_limit"];
  // Public ingress forces body redaction (omits page.markdown_body) via
  // the recall layer's native flag; an explicit `redact_body` arg still
  // wins for internal callers who want to override.
  if (typeof args["redact_body"] === "boolean")
    opts.redact_body = args["redact_body"];
  else if (redact) opts.redact_body = true;
  const r = await entityRecall(storage, args["slug"], opts);
  // `redact_body` only strips the page body; the facts + timeline arrays
  // carry note-derived `fact`/`event` text and must be redacted on public
  // ingress too (mirrors callEntityFacts / callEntityTimeline).
  if (redact) {
    return jsonResult({
      ...r,
      ok: true,
      // Run the page through the same PUBLIC_SAFE_PAGE_FIELDS allowlist the
      // other page tools use. The recall layer's redact_body only strips
      // markdown_body via destructure, which is NOT fail-safe — a new
      // PageRow field would leak by default here. redactBody keeps recall
      // consistent with page_get/page_list (e.g. drops deleted_at too).
      page: r.page
        ? redactBody(r.page as unknown as Record<string, unknown>)
        : r.page,
      facts: redactFacts(r.facts as unknown as Record<string, unknown>[]),
      timeline: redactTimeline(
        r.timeline as unknown as Record<string, unknown>[],
      ),
    });
  }
  return jsonResult({ ok: true, ...r });
}

// ---------------------------------------------------------------------------
// Jobs DAG tools (Phase A.4). Writes (jobs_submit, jobs_cancel) are
// in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads are open.
// ---------------------------------------------------------------------------

async function callJobsSubmit(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["kind"] !== "string")
    return errResult("jobs_submit: `kind` is required");
  const input: SubmitJobInput = { kind: args["kind"] };
  if (typeof args["payload"] === "object" && args["payload"] !== null)
    input.payload = args["payload"] as Record<string, unknown>;
  if (typeof args["priority"] === "number") input.priority = args["priority"];
  if (typeof args["max_retries"] === "number")
    input.max_retries = args["max_retries"];
  if (typeof args["parent_job_id"] === "string")
    input.parent_job_id = args["parent_job_id"];
  if (typeof args["idempotency_key"] === "string")
    input.idempotency_key = args["idempotency_key"];
  if (typeof args["not_before"] === "string")
    input.not_before = args["not_before"];
  if (typeof args["timeout_ms"] === "number")
    input.timeout_ms = args["timeout_ms"];
  const r = await submitJob(storage.engine(), input);
  return jsonResult({ ok: true, ...r });
}

async function callJobsList(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  const opts: ListJobsOptions = {};
  if (typeof args["status"] === "string") opts.status = args["status"];
  if (typeof args["kind"] === "string") opts.kind = args["kind"];
  if (typeof args["parent_job_id"] === "string")
    opts.parent_job_id = args["parent_job_id"];
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const jobs = await listJobs(storage.engine(), opts);
  // Public ingress: drop caller-derived `idempotency_key` (often a path).
  const out = redact
    ? jobs.map((j) => redactJob(j as unknown as Record<string, unknown>))
    : jobs;
  return jsonResult({ ok: true, jobs: out });
}

async function callJobsGet(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string")
    return errResult("jobs_get: `id` is required");
  const job = await getJob(storage.engine(), args["id"]);
  if (!job) return errResult(`jobs_get: ${args["id"]} not found`);
  // Public ingress: `payload`/`result`/`last_error` carry arbitrary
  // note-derived free text (vault paths, snippets) — strip them.
  const out = redact
    ? redactJob(job as unknown as Record<string, unknown>)
    : job;
  return jsonResult({ ok: true, job: out });
}

async function callJobsCancel(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string")
    return errResult("jobs_cancel: `id` is required");
  const opts: { cascade?: boolean; reason?: string } = {};
  if (typeof args["cascade"] === "boolean") opts.cascade = args["cascade"];
  if (typeof args["reason"] === "string") opts.reason = args["reason"];
  const r = await cancelJob(storage.engine(), args["id"], opts);
  return jsonResult({ ok: true, ...r });
}

async function callJobsLogs(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string")
    return errResult("jobs_logs: `id` is required");
  const job = await getJob(storage.engine(), args["id"]);
  if (!job) return errResult(`jobs_logs: ${args["id"]} not found`);
  const log = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    retry_count: job.retry_count,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    depth: job.depth,
    parent_job_id: job.parent_job_id,
    children_count: job.children.length,
    inbox_unread: job.inbox_unread,
  };
  // Public ingress: `last_error` can echo pgerror text / vault paths.
  const out = redact
    ? redactJob(log as unknown as Record<string, unknown>)
    : log;
  return jsonResult({ ok: true, log: out });
}

// --- Wave 1: graph reads, insights, facts, identity, refinement ---

async function callGetLinks(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("get_links: `slug` is required");
  }
  const opts: Parameters<typeof getLinks>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const groups = await getLinks(storage, args["slug"], opts);
  return jsonResult({ ok: true, slug: args["slug"], groups });
}

async function callListLinkSources(storage: Storage): Promise<ToolCallResult> {
  const sources = await listLinkSources(storage);
  return jsonResult({ ok: true, sources });
}

async function callFindOrphans(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const opts: FindOrphansOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const pages = await findOrphans(storage, opts);
  return jsonResult({ ok: true, pages });
}

async function callFindExperts(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const opts: FindExpertsOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const experts = await findExperts(storage, opts);
  return jsonResult({ ok: true, experts });
}

async function callFindContradictions(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const opts: FindContradictionsOptions = {};
  if (typeof args["slug"] === "string") opts.slug = args["slug"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const contradictions = await findContradictions(storage, opts);
  return jsonResult({ ok: true, contradictions });
}

async function callFindTrajectory(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["entity_slug"] !== "string" || args["entity_slug"].length === 0) {
    return errResult("find_trajectory: `entity_slug` is required");
  }
  const opts: FindTrajectoryOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["until"] === "string") opts.until = args["until"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const points = await findTrajectory(storage, args["entity_slug"], opts);
  return jsonResult({ ok: true, entity_slug: args["entity_slug"], points });
}

async function callGetRecentSalience(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getRecentSalience>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["days"] === "number") opts.days = args["days"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const pages = await getRecentSalience(storage, opts);
  return jsonResult({ ok: true, pages });
}

async function callFindAnomalies(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof findAnomalies>[1] = {};
  if (typeof args["sigma"] === "number") opts.sigma = args["sigma"];
  if (typeof args["staleDays"] === "number") opts.staleDays = args["staleDays"];
  if (typeof args["salienceFloor"] === "number") opts.salienceFloor = args["salienceFloor"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const anomalies = await findAnomalies(storage, opts);
  return jsonResult({ ok: true, anomalies });
}

async function callRecall(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = args["id"];
  if (!Number.isInteger(id) || (id as number) < 1) {
    return errResult("recall: `id` must be a positive integer");
  }
  const fact = await recallFact(storage, id as number);
  if (!fact) {
    throw new OperationError(
      "not_found",
      `recall: fact ${id} not found`,
      "Pass a live fact id (see entity_facts).",
    );
  }
  return jsonResult({ ok: true, fact });
}

async function callForgetFact(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = args["id"];
  if (!Number.isInteger(id) || (id as number) < 1) {
    return errResult("forget_fact: `id` must be a positive integer");
  }
  const opts: Parameters<typeof forgetFact>[2] = {};
  if (typeof args["reason"] === "string") opts.reason = args["reason"];
  const r = await forgetFact(storage, id as number, opts);
  return jsonResult({ ok: true, ...r });
}

async function callGetBrainIdentity(storage: Storage): Promise<ToolCallResult> {
  const id = await brainIdentity(storage);
  return jsonResult({ ok: true, ...id });
}

async function callPurgeDeletedPages(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  let olderThanHours: number | undefined;
  if (args["older_than_hours"] !== undefined) {
    const v = args["older_than_hours"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return errResult(
        "purge_deleted_pages: `older_than_hours` must be a non-negative number",
      );
    }
    olderThanHours = v;
  }
  const r =
    olderThanHours === undefined
      ? await purgeDeletedPages(storage.engine())
      : await purgeDeletedPages(storage.engine(), olderThanHours);
  return jsonResult({ ok: true, ...r });
}

async function callQuery(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const q = args["q"];
  if (typeof q !== "string" || q.length === 0) {
    throw new OperationError(
      "invalid_params",
      "query: `q` is required",
      "Pass a non-empty `q` string.",
    );
  }
  const opts: Parameters<typeof queryRefine>[3] = {};
  if (typeof args["k"] === "number") opts.k = args["k"];
  if (typeof args["primary_weight"] === "number") opts.primaryWeight = args["primary_weight"];
  if (typeof args["refine_weight"] === "number") opts.refineWeight = args["refine_weight"];
  const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
    toolName: "mcp.query",
    remote: true,
  });
  if (onCapture) opts.search = { onCapture };
  const refine = typeof args["refine"] === "string" ? args["refine"] : "";
  const hits = await queryRefine(storage, q, refine, opts);
  return jsonResult({ ok: true, hits });
}
