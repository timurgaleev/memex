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
import {
  type AuthInfo,
  effectiveReadSourceIdsForIngress,
  effectiveWriteSourceIdForIngress,
  tenantFailClosedEnabled,
  NO_SOURCE_SENTINEL,
} from "../core/auth-info.ts";
import { hybridSearch, type SearchOptions } from "../core/search/index.ts";
import { indexDocument, indexFile } from "../core/indexer.ts";
import { findBacklinks } from "../core/backlinks.ts";
import {
  brainHealthMetrics,
  collectPerSourceHealth,
} from "../core/source-health.ts";
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
  syncVerbLinksForPage,
  stampLinksExtracted,
  type GraphNeighborsOptions,
  type GraphQueryOptions,
  type TraverseGraphOptions,
} from "../core/links.ts";
import { syncMentionsForPage } from "../core/gazetteer.ts";
import { syncTypedLinksForPage, typedLinksEnabled } from "../core/typed-links.ts";
import { bumpLastRetrievedAt } from "../core/last-retrieved.ts";
import { linkVerbInferEnabled } from "../core/link-verb-infer.ts";
import {
  indexPageIntoSearch,
  removePageFromSearch,
  isPageSourcePath,
} from "../core/page-index.ts";
import { getChunksForPage, getChunksForSource } from "../core/chunks-read.ts";
import { resolveSlugs } from "../core/slug-resolve.ts";
import { addTag, removeTag, getTags } from "../core/tags.ts";
import { relationalRecall } from "../core/search/relational-recall.ts";
import { relationalRecallLlm } from "../core/search/relational-llm.ts";
import { getLinks, listLinkSources } from "../core/links-read.ts";
import {
  findOrphans,
  findExperts,
  findContradictions,
  listProbedContradictions,
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
import { codeCallers, codeCallees, codeDefs, codeRefs } from "../core/code-graph.ts";
import { runRecursiveWalk } from "../core/code-walk.ts";
import { parseWindow, volunteerContext, volunteerUsageStats } from "../core/context/volunteer.ts";
import {
  logVolunteerEventsFireAndForget,
  volunteerEventRowsFrom,
} from "../core/context/volunteer-events.ts";
import { runAdvisor } from "../core/advisor/run.ts";
import { listBrainSkillpacks, getBrainSkill } from "../core/skillpack/brain-resident.ts";
import {
  listConcepts,
  listTakes,
  searchTakes,
  getCalibrationProfile,
  getTakesScorecard,
  getTakesCalibration,
} from "../core/synthesis/reads.ts";
import { listRecentTranscripts } from "../core/transcripts-read.ts";
import { setTakeStatus } from "../core/synthesis/takes.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
  reconcileFactsForPage,
  purgeFenceFactsForPage,
} from "../core/facts-reconcile.ts";
import {
  factsExtractionEnabled,
  isFactsExtractionEligible,
  extractFactsForPage,
  extractFactsOnDemand,
} from "../core/facts-extract.ts";
import { getFactsQueue } from "../core/facts-queue.ts";
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
import { getBrainHotMemoryMeta } from "../core/hot-memory-meta.ts";
import { OPERATIONS, WRITE_SCOPED_TOOLS, validateParams } from "./operations.ts";

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
  /** MCP `_meta` — out-of-band data attached to a result. Used for the
   *  best-effort `brain_hot_memory` injection (see the dispatchTool wrapper). */
  _meta?: Record<string, unknown>;
}

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  "wikilink",
  "tag",
  "date",
]);

/**
 * Tools that stamp/filter on the caller's WRITE source (they receive
 * `writeSource` in the dispatch switch). Under the fail-closed policy an
 * authenticated public principal with NO write grant must be rejected on these
 * before any handler runs — never allowed to default to the 'default' tenant.
 * A non-write op is unaffected (reads keep their own scope resolver).
 *
 * The set is DERIVED from each op's `scope: "write"` field in operations.ts (the
 * single source of truth), so a new write op declares its scope once on the op
 * and is automatically gated here — no separate list to keep in lock-step. The
 * source_id FK is still the backstop if one is ever mis-tagged (the sentinel
 * can't reference a real row).
 */

/**
 * Operator-only operational tools. These expose brain-wide state that has no
 * per-source axis — the job queue (jobs_* return another tenant's job
 * payload/result/logs: vault paths, note snippets) and the advisor/stats
 * dashboards (migrations, embed coverage, whole-brain counts, internal-auth
 * config). They are refused for any authenticated tenant principal
 * (`authInfo !== undefined`), i.e. an OAuth `memex_at_` caller. The static
 * daily bearer and the trusted-local/internal path (both `authInfo === undefined`)
 * keep full access — they are the operator. `source_health` is deliberately NOT
 * here: it is the per-source (tenant-safe) health view.
 */
const OPERATOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "stats",
  "advisor",
  "jobs_submit",
  "jobs_list",
  "jobs_get",
  "jobs_cancel",
  "jobs_logs",
]);

/** Per-call options the transport supplies. */
export interface DispatchOptions {
  /** True when the request arrived over the public ingress
   *  (`brain.<domain>/mcp` via Cloudflare). Read tools then redact note
   *  bodies unless `MEMEX_PUBLIC_READ_BODIES` is opted-in — identical to
   *  the REST routes so the two ingress paths cannot diverge. */
  isPublic?: boolean;
  /** Resolved caller identity. When present, its source grant scopes every
   *  read (to `allowedSources`/`sourceId`) and stamps every write
   *  (`sourceId`). Absent → unscoped (local/internal whole-brain access). */
  authInfo?: AuthInfo;
}

/**
 * Public entry: dispatch the tool call, then best-effort attach the
 * `_meta.brain_hot_memory` payload (Item 3, migration 020 surfacing).
 *
 * The injection is gated hard: it runs ONLY for a successful, non-public,
 * UNSCOPED (operator / trusted-local, `authInfo === undefined`) call, and is a
 * no-op unless MEMEX_HOT_MEMORY_META=1. `hot_memory` has no tenant/visibility
 * axis and holds unvetted PII, so it must never reach a public or tenant-scoped
 * caller. Any error here is swallowed — the meta hook can NEVER fail a tool call.
 */
export async function dispatchTool(
  storage: Storage,
  req: ToolCallRequest,
  opts: DispatchOptions = {},
): Promise<ToolCallResult> {
  const result = await dispatchToolInner(storage, req, opts);
  const injectable =
    !result.isError &&
    !(opts.isPublic ?? false) &&
    opts.authInfo === undefined;
  if (injectable) {
    try {
      const meta = await getBrainHotMemoryMeta(storage);
      if (meta) return { ...result, _meta: meta };
    } catch {
      // Best-effort: never let the meta hook fail the underlying tool call.
    }
  }
  return result;
}

async function dispatchToolInner(
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
  // The caller's tenant grant: read scope (union of allowed sources) + the
  // single write source. Undefined when no authInfo → unscoped whole-brain
  // (local CLI / internal token), preserving single-tenant behavior.
  const readSources = effectiveReadSourceIdsForIngress(opts.authInfo, {
    failClosed: tenantFailClosedEnabled(),
  });
  // The write source, with the same fail-closed floor as reads: an
  // authenticated PUBLIC principal holding no write grant resolves to the
  // NO_SOURCE_SENTINEL, which the gate below turns into permission_denied on any
  // write op — it must NEVER fall through and stamp the shared 'default' tenant.
  // Undefined (static bearer / trusted-local / OAuth non-public) stays unscoped.
  const writeSourceRaw = effectiveWriteSourceIdForIngress(opts.authInfo, {
    failClosed: tenantFailClosedEnabled(),
  });
  const writeDenied = writeSourceRaw === NO_SOURCE_SENTINEL;
  const writeSource = writeDenied ? undefined : writeSourceRaw;
  try {
    // Fail-closed write gate: reject a scopeless authenticated public principal
    // from every write op before dispatch (default-OFF unless
    // MEMEX_TENANT_FAIL_CLOSED=1). Reads are unaffected.
    if (writeDenied && WRITE_SCOPED_TOOLS.has(req.name)) {
      throw new OperationError(
        "permission_denied",
        `no write source is granted to this client for '${req.name}'`,
        "Request a write scope for your client, or use a scoped token.",
      );
    }
    // Operator-only gate: an authenticated tenant principal (OAuth `memex_at_`
    // token, `authInfo` present) cannot reach the brain-wide operational tools —
    // they have no per-source scope and would leak another tenant's job
    // payload/logs or the whole-brain advisor/stats. The static bearer + internal
    // path (`authInfo === undefined`) are the operator and keep access.
    if (opts.authInfo !== undefined && OPERATOR_ONLY_TOOLS.has(req.name)) {
      throw new OperationError(
        "permission_denied",
        `tool '${req.name}' is operator-only and not callable by a tenant token`,
        "Use the per-source 'source_health' tool for tenant-scoped health.",
      );
    }
    // Enforce the declared param contract (type / enum / min-max of present
    // params) before dispatch. Known tools only — an unknown name falls through
    // to the switch default. Throws OperationError('invalid_params'), rendered
    // by the catch below.
    const op = OP_BY_NAME.get(req.name);
    if (op) validateParams(op, args);
    switch (req.name) {
      case "search":
        return await callSearch(storage, args, redact, readSources);
      case "index":
        return await callIndex(storage, args, opts.isPublic ?? false, writeSource);
      case "backlinks":
        return await callBacklinks(storage, args, redact, readSources);
      case "stats":
        return await callStats(storage);
      case "source_health":
        return await callSourceHealth(storage, readSources);
      case "log_friction":
        return await callLogFriction(storage, args);
      case "page_put":
        return await callPagePut(storage, args, writeSource);
      case "page_append":
        return await callPageAppend(storage, args, writeSource);
      case "page_delete":
        return await callPageDelete(storage, args, writeSource);
      case "page_restore":
        return await callPageRestore(storage, args, writeSource);
      case "page_revert":
        return await callPageRevert(storage, args, writeSource);
      case "page_get":
        return await callPageGet(storage, args, redact, readSources);
      case "page_list":
        return await callPageList(storage, args, redact, readSources);
      case "page_versions":
        return await callPageVersions(storage, args, redact, readSources);
      case "link":
        return await callLink(storage, args, writeSource);
      case "unlink":
        return await callUnlink(storage, args, writeSource);
      case "graph_neighbors":
        return await callGraphNeighbors(storage, args, redactGraph, readSources);
      case "graph_query":
        return await callGraphQuery(storage, args, redactGraph, readSources);
      case "traverse_graph":
        return await callTraverseGraph(storage, args, readSources);
      case "get_chunks":
        return await callGetChunks(storage, args, readSources);
      case "resolve_slugs":
        return await callResolveSlugs(storage, args, readSources);
      case "add_tag":
        return await callAddTag(storage, args, writeSource);
      case "remove_tag":
        return await callRemoveTag(storage, args, writeSource);
      case "get_tags":
        return await callGetTags(storage, args, readSources);
      case "relational_recall":
        return await callRelationalRecall(storage, args, readSources);
      case "add_fact":
        return await callAddFact(storage, args, writeSource);
      case "add_timeline_event":
        return await callAddTimelineEvent(storage, args, writeSource);
      case "entity_facts":
        return await callEntityFacts(storage, args, redact, readSources);
      case "entity_timeline":
        return await callEntityTimeline(storage, args, redact, readSources);
      case "entity_recall":
        return await callEntityRecall(storage, args, redact, readSources);
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
        return await callGetLinks(storage, args, readSources);
      case "list_link_sources":
        return await callListLinkSources(storage, readSources);
      case "find_orphans":
        return await callFindOrphans(storage, args, readSources);
      case "find_experts":
        return await callFindExperts(storage, args, readSources);
      case "find_contradictions":
        return await callFindContradictions(storage, args, readSources);
      case "find_trajectory":
        return await callFindTrajectory(storage, args, readSources);
      case "get_recent_salience":
        return await callGetRecentSalience(storage, args, readSources);
      case "find_anomalies":
        return await callFindAnomalies(storage, args, readSources);
      case "recall":
        return await callRecall(storage, args, readSources);
      case "forget_fact":
        return await callForgetFact(storage, args, writeSource);
      case "get_brain_identity":
        return await callGetBrainIdentity(storage);
      case "whoami":
        return callWhoami(opts.authInfo, readSources, opts.isPublic ?? false);
      case "purge_deleted_pages":
        return await callPurgeDeletedPages(storage, args, writeSource);
      case "query":
        return await callQuery(storage, args, readSources);
      case "code_callers":
        return await callCodeCallers(storage, args, readSources);
      case "code_callees":
        return await callCodeCallees(storage, args, readSources);
      case "code_def":
        return await callCodeDefs(storage, args, readSources);
      case "code_refs":
        return await callCodeRefs(storage, args, readSources);
      case "code_blast":
        return await callCodeWalk(storage, args, readSources, "callers");
      case "code_flow":
        return await callCodeWalk(storage, args, readSources, "callees");
      case "volunteer_context":
        return await callVolunteerContext(storage, args);
      case "advisor":
        return await callAdvisor(storage);
      case "list_brain_skillpack":
        return await callListBrainSkillpack();
      case "list_concepts":
        return await callListConcepts(storage, args, readSources);
      case "list_takes":
        return await callListTakes(storage, args, readSources);
      case "set_take_status":
        return await callSetTakeStatus(storage, args, writeSource);
      case "takes_search":
        return await callSearchTakes(storage, args, readSources);
      case "get_calibration_profile":
        return await callGetCalibrationProfile(storage, readSources);
      case "takes_scorecard":
        return await callTakesScorecard(storage, args, readSources);
      case "takes_calibration":
        return await callTakesCalibration(storage, args, readSources);
      case "extract_facts":
        return await callExtractFacts(storage, args, readSources);
      case "list_skills":
        return callListSkills();
      case "get_skill":
        return callGetSkill(args);
      case "get_recent_transcripts":
        return await callGetRecentTranscripts(storage, args, redact, readSources);
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
  readSources?: string[],
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
  if (readSources && readSources.length) searchOpts.sourceIds = readSources;
  // Optional per-call filters — strings validated by the op contract.
  if (typeof args["lang"] === "string" && args["lang"]) searchOpts.lang = args["lang"];
  if (typeof args["symbol_kind"] === "string" && args["symbol_kind"]) {
    searchOpts.symbolKind = args["symbol_kind"];
  }
  const dateBound = (name: "since" | "until"): string | undefined => {
    const v = args[name];
    if (v === undefined || v === null || v === "") return undefined;
    // Require an ISO-8601 date (optionally with a time) so a malformed bound
    // ("last month") fails loud at the call site instead of silently dropping
    // results in the comparison below.
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v) || Number.isNaN(Date.parse(v))) {
      throw new OperationError(
        "invalid_params",
        `search: \`${name}\` must be an ISO-8601 date (e.g. 2024-03-15 or 2024-03-15T10:00:00Z)`,
        `Pass \`${name}\` as an ISO date or datetime.`,
      );
    }
    return v;
  };
  const since = dateBound("since");
  const until = dateBound("until");
  if (since) searchOpts.since = since;
  if (until) searchOpts.until = until;
  // Structural two-pass expansion (code graph) — strings/ints validated by the
  // op contract; walk_depth clamped to the engine cap defensively.
  if (typeof args["near_symbol"] === "string" && args["near_symbol"]) {
    searchOpts.nearSymbol = args["near_symbol"];
  }
  if (typeof args["walk_depth"] === "number") {
    searchOpts.walkDepth = Math.min(Math.max(args["walk_depth"], 0), 2);
  }
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
  isPublic = false,
  writeSource?: string,
): Promise<ToolCallResult> {
  const path = args["path"];
  if (typeof path === "string" && path.length > 0) {
    // The `path` form reads a file off the daemon's filesystem. Even though
    // isWithinAllowedRoot caps it to the vault/code roots, the public ingress
    // must never trigger a server-side file read — remote callers index inline
    // (`sourcePath` + `text`) only. Defence-in-depth on top of the root guard.
    if (isPublic) {
      return errResult(
        "index: the `path` form is internal-only; pass `sourcePath` + `text` " +
          "to index inline content from the public path",
      );
    }
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
    const r = await indexDocument(storage, { sourcePath, text, ...(writeSource ? { sourceId: writeSource } : {}) });
    return jsonResult({ ok: true, ...r });
  }
  return errResult("index: pass either `path` or both `sourcePath` and `text`");
}

async function callBacklinks(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
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
  if (readSources?.length) opts.sourceIds = readSources;
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

/**
 * Per-source health breakdown. `readSources` scopes the rows: a scoped tenant
 * sees only its granted sources (and never the NULL '(unclassified)' bucket);
 * an unscoped local/internal caller (readSources undefined) sees every source
 * plus the whole-brain `health` roll-up. The brain-level metric is only
 * exposed to unscoped callers so a tenant can't read cross-tenant totals.
 */
async function callSourceHealth(
  storage: Storage,
  readSources?: string[],
): Promise<ToolCallResult> {
  const engine = storage.engine();
  const perSource = await collectPerSourceHealth(engine, readSources);
  const payload: Record<string, unknown> = { ok: true, perSource };
  if (readSources === undefined) {
    payload.health = await brainHealthMetrics(engine);
  }
  return jsonResult(payload);
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
  writeSource?: string,
): Promise<ToolCallResult> {
  const input = asPageInput(args);
  if (typeof input === "string") return errResult(input);
  if (writeSource) input.source_id = writeSource;
  const r = await putPage(storage, input);
  let searchIndexed: boolean | undefined;
  if (r.changed) {
    // Fetch the canonical row once: an omitted-title/-body re-put preserves
    // the stored values, so `input` alone may not reflect what's searchable.
    const page = await getPage(storage, r.slug);
    const body = page?.markdown_body ?? input.markdown_body ?? "";
    await syncWikilinksForPage(storage, r.slug, body, writeSource);
    // Gazetteer auto-link (opt-in, MEMEX_GAZETTEER=1) — derives `mentions`
    // edges from plain-text references to known entity pages.
    await syncMentionsForPage(storage, r.slug, body, writeSource);
    // Typed-link inference (opt-in, MEMEX_TYPED_LINKS=1) — derive works_at /
    // founded / attended / … edges from frontmatter fields.
    if (typedLinksEnabled() && page) {
      await syncTypedLinksForPage(storage, r.slug, page.type, page.compiled_truth, writeSource);
    }
    // Verb-context typed edges from prose (opt-in MEMEX_LINK_VERB_INFER) —
    // owns link_kind='verb_ner', never touches the edges above.
    if (linkVerbInferEnabled() && page) {
      await syncVerbLinksForPage(storage, r.slug, page.type, body, writeSource);
    }
    // Advance the link-extraction watermark now that the full edge set is
    // synced (migration 051) — stamped after updated_at, so the staleness
    // predicate reads clean until the next edit / extractor-version bump.
    await stampLinksExtracted(storage.engine(), r.slug, writeSource);
    // Mirror the page body into the search store so a page written via
    // page_put is findable. Best-effort: the canonical page write already
    // committed and is the source of truth — an embed failure must not fail
    // the write. The cycle backstop reconciles unindexed pages later.
    if (page) {
      searchIndexed = await mirrorPageToSearch(storage, page);
      // On-write fact extraction (default-OFF, best-effort). Only on a real
      // content change and only for prose-eligible pages.
      maybeEnqueueFactExtraction(storage, page, writeSource);
    }
  }
  // Facts-fence reconcile on EVERY put (a no-op re-put is the repair path) —
  // it re-reads the current body and guards on content_hash itself.
  await reconcileFactsForPage(storage, r.slug, r.content_hash, writeSource);
  return jsonResult({ ok: true, ...r, ...(searchIndexed !== undefined ? { search_indexed: searchIndexed } : {}) });
}

/**
 * Best-effort, default-OFF on-write fact extraction. When
 * MEMEX_FACTS_EXTRACTION is enabled AND the page is prose-eligible, enqueue a
 * bounded, fire-and-forget extraction job (paid Sonnet, budget-guarded inside
 * `extractFactsForPage`). NEVER blocks or fails the triggering write — the
 * queue absorbs errors, and a dropped/failed job is re-covered by the
 * conversation-facts backfill cycle phase. The write source scopes both the
 * per-session serialization key and the tenant the facts are written to.
 */
function maybeEnqueueFactExtraction(
  storage: Storage,
  page: { slug: string; type: string; markdown_body: string; source_id?: string },
  writeSource?: string,
): void {
  if (!factsExtractionEnabled()) return;
  const eligible = isFactsExtractionEligible(
    page.type,
    page.markdown_body,
    page.slug,
  );
  if (!eligible.ok) return;
  const sessionId = writeSource ?? page.source_id ?? "default";
  getFactsQueue().enqueue(
    () =>
      extractFactsForPage(storage, {
        slug: page.slug,
        type: page.type,
        body: page.markdown_body,
        ...(page.source_id ? { sourceId: page.source_id } : {}),
      }).then(() => undefined),
    sessionId,
  );
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
    source_id?: string;
  },
): Promise<boolean> {
  try {
    await indexPageIntoSearch(storage, {
      slug: page.slug,
      title: page.title,
      markdown_body: page.markdown_body,
      ...(page.content_hash ? { content_hash: page.content_hash } : {}),
      ...(page.source_id ? { source_id: page.source_id } : {}),
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
  writeSource?: string,
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
    ...(writeSource ? { source_id: writeSource } : {}),
  });
  let searchIndexed: boolean | undefined;
  if (r.changed) {
    const fresh = await getPage(storage, r.slug);
    const body = fresh?.markdown_body ?? "";
    await syncWikilinksForPage(storage, r.slug, body, writeSource);
    await syncMentionsForPage(storage, r.slug, body, writeSource);
    if (typedLinksEnabled() && fresh) {
      await syncTypedLinksForPage(storage, r.slug, fresh.type, fresh.compiled_truth, writeSource);
    }
    if (linkVerbInferEnabled() && fresh) {
      await syncVerbLinksForPage(storage, r.slug, fresh.type, body, writeSource);
    }
    await stampLinksExtracted(storage.engine(), r.slug, writeSource); // watermark (mig 051)
    if (fresh) {
      searchIndexed = await mirrorPageToSearch(storage, fresh);
      maybeEnqueueFactExtraction(storage, fresh, writeSource);
    }
  }
  await reconcileFactsForPage(storage, r.slug, r.content_hash, writeSource);
  return jsonResult({ ok: true, ...r, ...(searchIndexed !== undefined ? { search_indexed: searchIndexed } : {}) });
}

async function callPageDelete(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_delete: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await deletePage(storage, args["slug"], writtenBy, writeSource);
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
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_restore: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await restorePage(storage, args["slug"], writtenBy, writeSource);
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
  writeSource?: string,
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
  const r = await revertPage(storage, args["slug"], v as number, writtenBy, writeSource);
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
      if (linkVerbInferEnabled()) {
        await syncVerbLinksForPage(storage, r.slug, page.type, page.markdown_body);
      }
      await stampLinksExtracted(storage.engine(), r.slug); // watermark (mig 051)
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
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_get: `slug` is required");
  }
  const page = await getPage(storage, args["slug"], readSources && readSources.length ? readSources : undefined);
  if (!page) return errResult(`page not found: ${args["slug"]}`);
  // Retrieval write-back (mig 024): a user just surfaced this page — bump the
  // last_retrieved_at signal the context-volunteer "used" stat reads. Throttled
  // + best-effort; awaited because memex is single-holder (no fire-and-forget
  // drain needed). page_get is the unambiguous page-surface op; search hits are
  // chunk/document-level and don't carry a page slug, so they don't feed it.
  await bumpLastRetrievedAt(storage.engine(), [page.slug], page.source_id);
  return jsonResult({
    ok: true,
    page: redact ? redactBody(page as unknown as Record<string, unknown>) : page,
  });
}

async function callPageList(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listPages>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_versions: `slug` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const versions = await pageVersions(storage, args["slug"], limit, sourceIds);
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
  writeSource?: string,
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
  if (writeSource) input.source_id = writeSource;
  const r = await addLink(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callUnlink(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
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
    ...(writeSource ? { source_id: writeSource } : {}),
  });
  return jsonResult({ ok: true, ...r });
}

async function callGraphNeighbors(
  storage: Storage,
  args: Record<string, unknown>,
  redact: boolean,
  readSources?: string[],
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
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
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
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
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
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
): Promise<ToolCallResult> {
  const hasSlug = typeof args["slug"] === "string" && args["slug"].length > 0;
  const hasSrc =
    typeof args["source_path"] === "string" && args["source_path"].length > 0;
  if (!hasSlug && !hasSrc) {
    return errResult("get_chunks: provide `slug` or `source_path`");
  }
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const chunks = hasSlug
    ? await getChunksForPage(storage, args["slug"] as string, sourceIds)
    : await getChunksForSource(storage, args["source_path"] as string, sourceIds);
  return jsonResult({ ok: true, chunks });
}

async function callResolveSlugs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("resolve_slugs: `query` is required");
  }
  const opts: Parameters<typeof resolveSlugs>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  // Only slugs/titles/scores returned — already public via page_get/search.
  const hits = await resolveSlugs(storage, args["query"], opts);
  return jsonResult({ ok: true, query: args["query"], hits });
}

async function callAddTag(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("add_tag: `slug` is required");
  if (typeof args["tag"] !== "string") return errResult("add_tag: `tag` is required");
  try {
    await addTag(storage, args["slug"], args["tag"], writeSource);
    return jsonResult({ ok: true, slug: args["slug"], tag: args["tag"] });
  } catch (e) {
    return errResult(`add_tag: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function callRemoveTag(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("remove_tag: `slug` is required");
  if (typeof args["tag"] !== "string") return errResult("remove_tag: `tag` is required");
  await removeTag(storage, args["slug"], args["tag"], writeSource);
  return jsonResult({ ok: true, slug: args["slug"], tag: args["tag"] });
}

async function callGetTags(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("get_tags: `slug` is required");
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const tags = await getTags(storage, args["slug"], sourceIds);
  return jsonResult({ ok: true, slug: args["slug"], tags });
}

async function callRelationalRecall(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("relational_recall: `query` is required");
  }
  const opts: Parameters<typeof relationalRecall>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (typeof args["depth"] === "number") opts.depth = args["depth"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  let hits = await relationalRecall(storage, args["query"], opts);
  // Opt-in paid fallback (default OFF): when the deterministic regex arm found
  // nothing, ask Sonnet to classify the edge-question and re-run the SAME
  // fanout. Reachable only when MEMEX_RELATIONAL_LLM=1 — live MCP stays free.
  if (hits.length === 0 && process.env["MEMEX_RELATIONAL_LLM"] === "1") {
    // Forward only the shared scope/paging fields — the two arms carry distinct
    // onMeta shapes, so pass an explicit subset rather than the regex arm's opts.
    const llmOpts: Parameters<typeof relationalRecallLlm>[2] = {};
    if (opts.limit !== undefined) llmOpts.limit = opts.limit;
    if (opts.depth !== undefined) llmOpts.depth = opts.depth;
    if (opts.sourceIds !== undefined) llmOpts.sourceIds = [...opts.sourceIds];
    hits = await relationalRecallLlm(storage, args["query"], llmOpts);
  }
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
  writeSource?: string,
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
  if (writeSource) input.source_id = writeSource;
  const r = await addFact(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callAddTimelineEvent(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
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
  if (writeSource) input.source_id = writeSource;
  const r = await addTimelineEvent(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callEntityFacts(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
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
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("entity_timeline: `slug` is required");
  const opts: ListTimelineOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["until"] === "string") opts.until = args["until"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
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
  if (readSources && readSources.length) opts.sourceIds = readSources;
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
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("get_links: `slug` is required");
  }
  const opts: Parameters<typeof getLinks>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const groups = await getLinks(storage, args["slug"], opts);
  return jsonResult({ ok: true, slug: args["slug"], groups });
}

async function callListLinkSources(storage: Storage, readSources?: string[]): Promise<ToolCallResult> {
  const sources = await listLinkSources(storage, readSources && readSources.length ? readSources : undefined);
  return jsonResult({ ok: true, sources });
}

async function callFindOrphans(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: FindOrphansOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const pages = await findOrphans(storage, opts);
  return jsonResult({ ok: true, pages });
}

async function callFindExperts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: FindExpertsOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (typeof args["topic"] === "string") opts.topic = args["topic"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const experts = await findExperts(storage, opts);
  return jsonResult({ ok: true, experts });
}

async function callFindContradictions(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: FindContradictionsOptions = {};
  if (typeof args["slug"] === "string") opts.slug = args["slug"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  // Asserted `contradicts` edges (deterministic graph) + LLM-suspected findings
  // cached by the probe-contradictions phase (migration 064; [] on a pre-064
  // brain or when the probe has never run). Same tenant scope for both.
  const probedOpts: { limit?: number; sourceIds?: string[] } = {};
  if (typeof args["limit"] === "number") probedOpts.limit = args["limit"];
  if (readSources && readSources.length) probedOpts.sourceIds = readSources;
  const [contradictions, probed] = await Promise.all([
    findContradictions(storage, opts),
    listProbedContradictions(storage, probedOpts),
  ]);
  return jsonResult({ ok: true, contradictions, probed });
}

async function callFindTrajectory(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["entity_slug"] !== "string" || args["entity_slug"].length === 0) {
    return errResult("find_trajectory: `entity_slug` is required");
  }
  const opts: FindTrajectoryOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["until"] === "string") opts.until = args["until"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const points = await findTrajectory(storage, args["entity_slug"], opts);
  return jsonResult({ ok: true, entity_slug: args["entity_slug"], points });
}

async function callGetRecentSalience(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getRecentSalience>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["days"] === "number") opts.days = args["days"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const pages = await getRecentSalience(storage, opts);
  return jsonResult({ ok: true, pages });
}

async function callFindAnomalies(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof findAnomalies>[1] = {};
  if (typeof args["sigma"] === "number") opts.sigma = args["sigma"];
  if (typeof args["staleDays"] === "number") opts.staleDays = args["staleDays"];
  if (typeof args["salienceFloor"] === "number") opts.salienceFloor = args["salienceFloor"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const anomalies = await findAnomalies(storage, opts);
  return jsonResult({ ok: true, anomalies });
}

async function callRecall(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const id = args["id"];
  if (!Number.isInteger(id) || (id as number) < 1) {
    return errResult("recall: `id` must be a positive integer");
  }
  const fact = await recallFact(storage, id as number, readSources && readSources.length ? readSources : undefined);
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
  writeSource?: string,
): Promise<ToolCallResult> {
  const id = args["id"];
  if (!Number.isInteger(id) || (id as number) < 1) {
    return errResult("forget_fact: `id` must be a positive integer");
  }
  const opts: Parameters<typeof forgetFact>[2] = {};
  if (typeof args["reason"] === "string") opts.reason = args["reason"];
  // A destructive write scopes to the caller's SINGLE write source (a scalar),
  // never the federated READ set — a tenant may read many sources but must only
  // forget within its own write source. Undefined → unscoped, unchanged.
  const r = await forgetFact(storage, id as number, opts, writeSource ? [writeSource] : undefined);
  return jsonResult({ ok: true, ...r });
}

async function callGetBrainIdentity(storage: Storage): Promise<ToolCallResult> {
  const id = await brainIdentity(storage);
  return jsonResult({ ok: true, ...id });
}

/** Introspect the calling identity — the caller's own auth context, no corpus.
 *  Unscoped (no authInfo / no read scope) reports read_sources: null. */
function callWhoami(
  authInfo: AuthInfo | undefined,
  readSources: string[] | undefined,
  isPublic: boolean,
): ToolCallResult {
  return jsonResult({
    ok: true,
    client_id: authInfo?.clientId ?? null,
    scopes: authInfo?.scopes ?? [],
    write_source: authInfo?.sourceId ?? null,
    read_sources: readSources ?? null,
    is_public: isPublic,
  });
}

async function callPurgeDeletedPages(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
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
  // Scope the reaper to the caller's write source when scoped. Passing
  // `olderThanHours` undefined still triggers the fn's default TTL (72h).
  const scope = writeSource ? [writeSource] : undefined;
  const r = await purgeDeletedPages(storage.engine(), olderThanHours, scope);
  return jsonResult({ ok: true, ...r });
}

async function callQuery(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
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
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
    toolName: "mcp.query",
    remote: true,
  });
  if (onCapture) opts.search = { onCapture };
  const refine = typeof args["refine"] === "string" ? args["refine"] : "";
  const hits = await queryRefine(storage, q, refine, opts);
  return jsonResult({ ok: true, hits });
}

async function callCodeCallers(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["name"] !== "string" || args["name"].length === 0) {
    return errResult("code_callers: `name` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const result = await codeCallers(storage.engine(), args["name"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeCallees(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["target"] !== "string" || args["target"].length === 0) {
    return errResult("code_callees: `target` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const result = await codeCallees(storage.engine(), args["target"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeDefs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["name"] !== "string" || args["name"].length === 0) {
    return errResult("code_def: `name` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const result = await codeDefs(storage.engine(), args["name"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeRefs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["name"] !== "string" || args["name"].length === 0) {
    return errResult("code_refs: `name` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const result = await codeRefs(storage.engine(), args["name"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeWalk(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  direction: "callers" | "callees",
): Promise<ToolCallResult> {
  if (typeof args["symbol"] !== "string" || args["symbol"].length === 0) {
    return errResult(
      `${direction === "callers" ? "code_blast" : "code_flow"}: \`symbol\` is required`,
    );
  }
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const depthCapMax = direction === "callers" ? 8 : 12;
  const depth =
    typeof args["depth"] === "number"
      ? Math.min(Math.max(1, Math.floor(args["depth"] as number)), depthCapMax)
      : undefined;
  const maxNodes =
    typeof args["max_nodes"] === "number"
      ? Math.min(Math.max(1, Math.floor(args["max_nodes"] as number)), 200)
      : undefined;
  const exact = args["exact"] === true;
  const result = await runRecursiveWalk(storage.engine(), args["symbol"], {
    direction,
    depth,
    maxNodes,
    sourceIds,
    exact,
  });
  return jsonResult({ ok: true, ...result });
}

async function callVolunteerContext(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  // Stats mode: per-arm used/volunteered precision (feedback loop).
  if (args["stats"] === true) {
    const days = typeof args["turn"] === "number" ? (args["turn"] as number) : 30;
    const stats = await volunteerUsageStats(storage, days);
    return jsonResult({ ok: true, ...stats });
  }
  if (typeof args["window"] !== "string" || args["window"].length === 0) {
    return errResult("volunteer_context: `window` is required");
  }
  const turns = parseWindow(args["window"]);
  if (!turns.length) return jsonResult({ ok: true, pages: [] });

  const opts: Parameters<typeof volunteerContext>[1] = { window: turns };
  if (typeof args["max_pages"] === "number") opts.maxPages = args["max_pages"];
  if (typeof args["min_confidence"] === "number") opts.minConfidence = args["min_confidence"];

  const pages = await volunteerContext(storage, opts);

  // Fire-and-forget feedback log (channel 'op').
  const sessionId = typeof args["session_id"] === "string" ? args["session_id"] : null;
  const turn = typeof args["turn"] === "number" ? (args["turn"] as number) : null;
  logVolunteerEventsFireAndForget(
    storage,
    volunteerEventRowsFrom(pages, { channel: "op", session_id: sessionId, turn }),
  );

  return jsonResult({ ok: true, pages });
}

async function callAdvisor(storage: Storage): Promise<ToolCallResult> {
  const report = await runAdvisor({
    engine: storage.raw(),
    version: packageJson.version,
    now: new Date(),
  });
  return jsonResult({ ok: true, ...report });
}

async function callListBrainSkillpack(): Promise<ToolCallResult> {
  return jsonResult({ ok: true, ...listBrainSkillpacks() });
}

async function callListConcepts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const concepts = await listConcepts(storage.engine(), limit, sourceIds);
  return jsonResult({ ok: true, concepts });
}

async function callListTakes(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listTakes>[1] = {};
  if (typeof args["status"] === "string") opts.status = args["status"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const takes = await listTakes(storage.engine(), opts);
  return jsonResult({ ok: true, takes });
}

async function callSetTakeStatus(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["take_key"] !== "string" || args["take_key"].length === 0)
    return errResult("set_take_status: `take_key` is required");
  if (args["status"] !== "accepted" && args["status"] !== "rejected")
    return errResult("set_take_status: `status` must be 'accepted' or 'rejected'");
  const sourceIds = writeSource ? [writeSource] : undefined;
  const r = await setTakeStatus(storage.engine(), args["take_key"], args["status"], sourceIds);
  return jsonResult({ ok: true, ...r });
}

async function callSearchTakes(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["q"] !== "string" || args["q"].length === 0)
    return errResult("takes_search: `q` is required");
  const opts: Parameters<typeof searchTakes>[1] = { q: args["q"] };
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const takes = await searchTakes(storage.engine(), opts);
  return jsonResult({ ok: true, takes });
}

async function callGetCalibrationProfile(
  storage: Storage,
  readSources?: string[],
): Promise<ToolCallResult> {
  const sourceIds = readSources && readSources.length ? readSources : undefined;
  const profile = await getCalibrationProfile(storage.engine(), sourceIds);
  return jsonResult({ ok: true, profile });
}

async function callTakesScorecard(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getTakesScorecard>[1] = {};
  if (typeof args["domain"] === "string" && args["domain"]) opts.domain = args["domain"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const scorecard = await getTakesScorecard(storage.engine(), opts);
  return jsonResult({ ok: true, scorecard });
}

async function callTakesCalibration(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getTakesCalibration>[1] = {};
  if (typeof args["bucket_size"] === "number") opts.bucketSize = args["bucket_size"];
  if (typeof args["domain"] === "string" && args["domain"]) opts.domain = args["domain"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const buckets = await getTakesCalibration(storage.engine(), opts);
  return jsonResult({ ok: true, buckets });
}

/**
 * On-demand fact extraction preview. Accepts raw `text` OR a `source_ref` page
 * slug (read tenant-scoped). Returns the extracted facts WITHOUT persisting;
 * PAID + default-OFF, so the {enabled:false} envelope comes back until the
 * MEMEX_FACTS_EXTRACTION gate is set. Cross-tenant `source_ref` is a no-op: the
 * scoped getPage returns null and the tool errors not_found.
 */
async function callExtractFacts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  let text = typeof args["text"] === "string" ? args["text"] : "";
  const sourceRef = typeof args["source_ref"] === "string" ? args["source_ref"] : "";
  if (!text && sourceRef) {
    const page = await getPage(
      storage,
      sourceRef,
      readSources && readSources.length ? readSources : undefined,
    );
    if (!page) {
      throw new OperationError(
        "not_found",
        `extract_facts: page not found: ${sourceRef}`,
        "Pass a valid page slug in `source_ref`, or pass `text` directly.",
      );
    }
    text = page.markdown_body ?? "";
  }
  if (!text) {
    throw new OperationError(
      "invalid_params",
      "extract_facts: provide `text` or `source_ref`",
      "Pass conversation text in `text`, or a page slug in `source_ref`.",
    );
  }
  const result = await extractFactsOnDemand(text);
  return jsonResult({ ok: true, ...result });
}

function callListSkills(): ToolCallResult {
  const pack = listBrainSkillpacks();
  return jsonResult({ ok: true, ...pack });
}

function callGetSkill(args: Record<string, unknown>): ToolCallResult {
  const name = typeof args["name"] === "string" ? args["name"] : "";
  if (!name) return errResult("get_skill: `name` is required");
  const skill = getBrainSkill(name);
  if (!skill) return errResult(`get_skill: skill not found: ${name}`);
  return jsonResult({ ok: true, skill });
}

async function callGetRecentTranscripts(
  storage: Storage,
  args: Record<string, unknown>,
  redact: boolean,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listRecentTranscripts>[1] = {};
  if (typeof args["days"] === "number") opts.days = args["days"];
  if (typeof args["summary"] === "boolean") opts.summary = args["summary"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources && readSources.length) opts.sourceIds = readSources;
  const transcripts = await listRecentTranscripts(storage.engine(), opts);
  // Public ingress: `content` is note body — strip it, mirroring the page_list
  // body-redaction policy (slug/type/title metadata stays).
  const out = redact ? transcripts.map((t) => ({ ...t, content: "" })) : transcripts;
  return jsonResult({ ok: true, transcripts: out });
}
