/**
 * Continuity harness — replays "one client writes, a different client asks
 * later" against the real dispatch path, and hands back scoreable probes plus
 * the evidence behind them.
 *
 * Per fixture: empty the brain, seed the pages that existed BEFORE session A,
 * run session A's writes under the writing identity, cross the session
 * boundary, then run session B's probes under the reading identities.
 *
 * WHAT MAKES THE IDENTITIES REAL. Each fixture identity is resolved into an
 * `AuthInfo` and handed to the production `dispatchTool`, which runs its own
 * scope resolvers (`effectiveReadSourceIdsForIngress` /
 * `effectiveWriteSourceIdForIngress`), its own scope gate, and its own
 * redaction. Nothing here filters by tenant; a bench that reimplements scoping
 * grades its own copy of the fence and passes for reasons the product does not
 * share. The public identity is the same idea one layer up: the static bearer
 * never reaches dispatch for a forbidden tool, so the harness asks the SHIPPED
 * ingress predicate (`isPublicMcpToolForbidden`, `http/public_guard.ts:443`)
 * and records a refusal, rather than calling a path the caller cannot reach or
 * re-deriving the denylist here.
 *
 * TWO DELIBERATE DEPARTURES, both with a cost reason:
 *
 *   1. `page_put` does NOT go through dispatch. `callPagePut` mirrors the page
 *      into the search store with the REAL Titan embedder — dispatch forwards
 *      no `embedFn` to `indexPageIntoSearch`, and `IndexFileOptions.embedFn`
 *      (`core/indexer.ts:78`) is the seam that would let it. Measured, not
 *      assumed: one `page_put` through dispatch books an `embedding` row in
 *      `mcp_spend_log` — real money on a machine with credentials. So the page
 *      write runs `putPage` + `indexPageIntoSearch({ embedFn })` directly,
 *      stamping tenancy and writer through the SAME production helpers
 *      dispatch uses (`effectiveWriteSourceIdForIngress`, `writerIdentity`).
 *      What that costs the bench: the derived-edge syncs (wikilinks, typed
 *      links) and the on-write fact hook are not exercised by a page write.
 *      What it buys: the family cannot spend money. When dispatch grows an
 *      embedder seam, this collapses into the same `dispatchTool` call the
 *      other two write ops already use.
 *   2. The vector arm runs on a deterministic embedder defined HERE rather
 *      than on `tests/det-embed.ts`. The Docker image copies `src/` and not
 *      `tests/` (deploy/memex/Dockerfile:25), so a `src/` module that imports
 *      the test helper would break `memex bench` in the container. Seeding and
 *      querying use the same function, so the arm is self-consistent, which is
 *      all a fence probe needs from it.
 *
 * WHAT THIS HARNESS DOES NOT TELL YOU. It does not cross a real transport: two
 * `AuthInfo`s through one process is not two HTTP connections with two bearer
 * tokens, so ingress-layer divergence beyond the tool denylist is unmeasured.
 * It does not grade redaction — only which handles came back, never whether a
 * body was stripped. And a probe scores on the SET it returned, so a fence that
 * holds while leaking through ordering, counts or error text is invisible here.
 */

import type { Storage } from "../storage.ts";
import type { AuthInfo } from "../auth-info.ts";
import {
  effectiveWriteSourceIdForIngress,
  tenantFailClosedEnabled,
  NO_SOURCE_SENTINEL,
} from "../auth-info.ts";
import { putPage, type PageInput } from "../pages.ts";
import { registerSource } from "../sources.ts";
import { indexPageIntoSearch } from "../page-index.ts";
import { EMBED_DIMENSIONS } from "../embedding.ts";
import {
  dispatchTool,
  writerIdentity,
  type DispatchOptions,
  type ToolCallResult,
} from "../../mcp/dispatch.ts";
import { isPublicMcpToolForbidden } from "../../http/public_guard.ts";
import { resetBrain, resetProcessGlobals, assertBrainEmpty } from "./reset.ts";
import type { ScoredTurn } from "./push-metrics.ts";
import {
  provenanceRequired,
  writeHandle,
  type BenchIdentity,
  type ContinuityFixture,
  type ContinuityProbe,
  type ContinuityProbeOp,
  type ContinuitySessionWrite,
} from "./continuity-fixtures.ts";
import type { FixturePage } from "./fixtures.ts";

// --------------------------------------------------------------------------
// Deterministic embedder (see departure 2 in the header).
// --------------------------------------------------------------------------

/** Token bag → unit vector. Shared tokens are the only similarity signal,
 *  which is enough for a fixture that asks whether a hit crosses a fence. */
function benchEmbed(text: string): number[] {
  const v = Array.from<number>({ length: EMBED_DIMENSIONS }).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const dim = h % EMBED_DIMENSIONS;
    v[dim] = (v[dim] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  // An empty / punctuation-only string maps to a fixed unit vector rather than
  // a zero one, which would make cosine distance undefined.
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  for (let i = 0; i < EMBED_DIMENSIONS; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

async function benchEmbedQuery(text: string): Promise<number[]> {
  return benchEmbed(text);
}

// --------------------------------------------------------------------------
// Outcomes
// --------------------------------------------------------------------------

/** What session A actually landed, and under whose identity. */
export interface ContinuityWriteOutcome {
  index: number;
  as: string;
  op: ContinuitySessionWrite["op"];
  /** The handle probes refer to it by: a slug, or `fact:<n>` / `link:<n>`. */
  handle: string;
  /** Resolved write source — `"default"` when the identity is unscoped. */
  writeSource: string;
  /** Resolved writer stamp (`client:<clientId>`), as dispatch would set it. */
  writer: string;
  /** `entity_facts.id` for an `add_fact`; the row identity a probe must match. */
  factId?: number;
  /** Error text when the write failed. A failed write is not silently a miss. */
  error?: string;
}

/** One replayed probe: the label, what came back, and what it was worth. */
export interface ContinuityProbeOutcome {
  /** `<fixture>#<probe id>` — matches ScoredTurn.id. */
  id: string;
  fixture: string;
  as: string;
  op: ContinuityProbeOp;
  gold: string[];
  acceptable: string[];
  /** Every handle the op returned, BEFORE the provenance filter. */
  returned: string[];
  /** Gold handles that came back but did not carry session A's provenance. */
  provenanceMismatches: string[];
  /** What feeds the score. */
  injected: string[];
  /** True when the shipped public-ingress guard forbids this tool outright. */
  refused: boolean;
  /** The op's own error text, when it returned one (a miss is often an error). */
  error?: string;
  note?: string;
}

export interface ContinuityFixtureRun {
  fixture: string;
  description: string;
  writes: ContinuityWriteOutcome[];
  probes: ContinuityProbeOutcome[];
  scored: ScoredTurn[];
}

export interface ContinuityCorpusRun {
  runs: ContinuityFixtureRun[];
  /** Every probe of every fixture, in corpus order. */
  probes: ContinuityProbeOutcome[];
  /** The same probes, reduced to what `scorePush` consumes. */
  scored: ScoredTurn[];
}

/** Reduce a replayed probe to the three fields `scorePush` reads. */
export function toScoredProbe(p: ContinuityProbeOutcome): ScoredTurn {
  return {
    id: p.id,
    gold: p.gold,
    ...(p.acceptable.length ? { acceptable: p.acceptable } : {}),
    injected: p.injected,
  };
}

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

/**
 * The dispatch options for an identity. The static public bearer presents NO
 * `authInfo` (that is what makes it the unscoped-but-redacted principal);
 * every other identity presents one and lets dispatch resolve its scope.
 */
export function dispatchOptionsFor(identity: BenchIdentity): DispatchOptions {
  if (identity.isPublic) return { isPublic: true, embedQuery: benchEmbedQuery };
  const authInfo: AuthInfo = {
    token: `bench-token-${identity.clientId}`,
    clientId: identity.clientId,
    scopes: identity.scopes ?? [],
    ...(identity.writeSource !== undefined ? { sourceId: identity.writeSource } : {}),
    ...(identity.readSources !== undefined ? { allowedSources: identity.readSources } : {}),
    isPublic: false,
  };
  return { authInfo, embedQuery: benchEmbedQuery };
}

/** The tenant a write lands in, resolved by the production ingress helper. */
function resolvedWriteSource(opts: DispatchOptions): string | undefined {
  const raw = effectiveWriteSourceIdForIngress(opts.authInfo, {
    failClosed: tenantFailClosedEnabled(),
  });
  if (raw === NO_SOURCE_SENTINEL) {
    throw new Error(
      "continuity harness: identity resolves to no write source under the fail-closed " +
        "policy, so its session-A writes would be refused — give it a writeSource",
    );
  }
  return raw;
}

// --------------------------------------------------------------------------
// Seeding + writing
// --------------------------------------------------------------------------

/** Every source a fixture names, so `pages.source_id`'s foreign key resolves. */
function sourcesOf(fixture: ContinuityFixture): string[] {
  const out = new Set<string>();
  for (const identity of fixture.identities) {
    if (identity.writeSource) out.add(identity.writeSource);
    for (const s of identity.readSources ?? []) out.add(s);
  }
  for (const p of fixture.pages ?? []) if (p.source) out.add(p.source);
  out.delete("default");
  return [...out].sort();
}

/**
 * Write a page and mirror it into the search store, the way `callPagePut`
 * does — minus the derived-edge syncs, and with the embedder injected.
 */
async function writePage(storage: Storage, input: PageInput): Promise<void> {
  const r = await putPage(storage, input);
  const page = {
    slug: r.slug,
    title: input.title ?? null,
    markdown_body: input.markdown_body ?? "",
    content_hash: r.content_hash,
    ...(input.source_id ? { source_id: input.source_id } : {}),
  };
  await indexPageIntoSearch(storage, page, { embedFn: async (t) => benchEmbed(t) });
}

/** Seed the brain state that existed BEFORE session A. */
async function seedContinuityPages(storage: Storage, pages: readonly FixturePage[]): Promise<void> {
  for (const p of pages) {
    await writePage(storage, {
      slug: p.slug,
      type: p.type,
      title: p.title,
      markdown_body: p.body.endsWith("\n") ? p.body : `${p.body}\n`,
      compiled_truth: p.aliases?.length ? { aliases: p.aliases } : {},
      source_id: p.source ?? "default",
    });
  }
}

/** Mirror of `asPageInput` (`mcp/dispatch.ts:1207`) for the direct page write. */
function pageInputFrom(args: Record<string, unknown>, writer: string): PageInput {
  const input: PageInput = { slug: String(args["slug"]), written_by: writer };
  if (typeof args["type"] === "string") input.type = args["type"];
  if (typeof args["title"] === "string") input.title = args["title"];
  if (typeof args["markdown_body"] === "string") input.markdown_body = args["markdown_body"];
  if (typeof args["compiled_truth"] === "object" && args["compiled_truth"] !== null) {
    input.compiled_truth = args["compiled_truth"] as Record<string, unknown>;
  }
  if (typeof args["allowAdHocType"] === "boolean") input.allowAdHocType = args["allowAdHocType"];
  return input;
}

/** The JSON payload of a tool result, or null when the op returned an error. */
function readJson(result: ToolCallResult): Record<string, unknown> | null {
  if (result.isError) return null;
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** An op's error text, for the outcome record. */
function errorText(result: ToolCallResult): string | undefined {
  if (!result.isError) return undefined;
  const text = result.content?.[0]?.text;
  return typeof text === "string" ? text : "unknown error";
}

async function runWrite(
  storage: Storage,
  fixture: ContinuityFixture,
  index: number,
): Promise<ContinuityWriteOutcome> {
  const write = fixture.writes[index]!;
  const identity = fixture.identities.find((i) => i.id === write.as)!;
  const opts = dispatchOptionsFor(identity);
  const writeSource = resolvedWriteSource(opts);
  const outcome: ContinuityWriteOutcome = {
    index,
    as: write.as,
    op: write.op,
    handle: writeHandle(fixture, index),
    writeSource: writeSource ?? "default",
    writer: writerIdentity(opts),
  };

  if (write.op === "page_put") {
    const input = pageInputFrom(write.args, outcome.writer);
    if (writeSource) input.source_id = writeSource;
    await writePage(storage, input);
    return outcome;
  }

  const result = await dispatchTool(
    storage,
    { name: write.op, arguments: write.args },
    opts,
  );
  const body = readJson(result);
  if (!body) {
    outcome.error = errorText(result) ?? "write returned no payload";
    return outcome;
  }
  if (write.op === "add_fact") {
    const id = body["id"];
    if (typeof id !== "number") {
      // `inserted: false` with a null id means the claim collapsed into a row
      // already on file — for a bench that is a fixture bug, not a result.
      outcome.error = `add_fact returned no row id (${JSON.stringify(body)})`;
      return outcome;
    }
    outcome.factId = id;
  }
  return outcome;
}

// --------------------------------------------------------------------------
// Probing
// --------------------------------------------------------------------------

/**
 * `page://slug` / `page://source/slug` → the page slug it mirrors
 * (`pageSourcePath`, `core/page-index.ts:43`). The tenant prefix is stripped by
 * matching it against the fixture's own sources rather than by counting
 * segments — a single-segment slug in a tenant is indistinguishable from a
 * two-segment slug in the default tenant otherwise.
 */
function slugFromSourcePath(sourcePath: string, tenants: ReadonlySet<string>): string | null {
  if (!sourcePath.startsWith("page://")) return null;
  const rest = sourcePath.slice("page://".length);
  const cut = rest.indexOf("/");
  const head = cut > 0 ? rest.slice(0, cut) : "";
  return tenants.has(head) ? rest.slice(cut + 1) : rest;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? (v.filter((x) => typeof x === "object" && x !== null) as Record<string, unknown>[])
    : [];
}

/** What a returned row has to be matched against to become a labelled handle. */
interface ProbeHandles {
  /** `entity_facts.id` → `fact:<n>`, for the rows session A wrote. */
  facts: ReadonlyMap<number, string>;
  /** `<source> <target> <type>` → `link:<n>`, likewise. */
  links: ReadonlyMap<string, string>;
  /** The fixture's tenants, so a mirror path's prefix can be told from a slug. */
  tenants: ReadonlySet<string>;
}

/**
 * Reduce a tool result to the handles a label can name. Unknown rows keep a
 * distinguishable handle rather than being dropped: an item the fixture did not
 * expect is noise, and noise belongs in the precision denominator.
 */
function handlesFrom(
  op: ContinuityProbeOp,
  body: Record<string, unknown> | null,
  handles: ProbeHandles,
): string[] {
  if (!body) return [];
  const out: string[] = [];
  const push = (h: string): void => {
    if (!out.includes(h)) out.push(h);
  };
  switch (op) {
    case "page_get": {
      const page = body["page"];
      if (typeof page === "object" && page !== null) {
        const slug = (page as Record<string, unknown>)["slug"];
        if (typeof slug === "string") push(slug);
      }
      break;
    }
    case "page_list":
    case "volunteer_context":
      for (const row of asArray(body["pages"])) {
        if (typeof row["slug"] === "string") push(row["slug"]);
      }
      break;
    case "resolve_slugs":
      for (const row of asArray(body["hits"])) {
        if (typeof row["slug"] === "string") push(row["slug"]);
      }
      break;
    case "entity_facts":
      for (const row of asArray(body["facts"])) {
        const id = row["id"];
        if (typeof id !== "number") continue;
        push(handles.facts.get(id) ?? `fact:row=${id}`);
      }
      break;
    case "get_links":
      for (const group of asArray(body["groups"])) {
        for (const link of asArray(group["links"])) {
          const key = `${String(link["source_slug"])} ${String(link["target_slug"])} ${String(link["type"])}`;
          push(handles.links.get(key) ?? `link:${key.replace(/ /g, "->")}`);
        }
      }
      break;
    case "search":
    case "query":
      for (const hit of asArray(body["hits"])) {
        const path = hit["sourcePath"];
        if (typeof path !== "string") continue;
        push(slugFromSourcePath(path, handles.tenants) ?? path);
      }
      break;
  }
  return out;
}

/**
 * Does a returned handle carry the provenance of the session-A write that
 * produced it? Read back from the row, never from the response — a response
 * can echo whatever the reader asked for.
 *
 *   page   tenancy stamp + the writer on its first version
 *   fact   row identity (already implied by the handle) + tenancy + writer
 *   link   tenancy on the (source, target, type) edge the write asserted
 *
 * Exported because it IS the anti-cheat: without it a probe scores for finding
 * anything shaped like the answer, and a seeded page is shaped like the answer.
 * A guard nothing can test is a guard nobody can trust, so the test tampers
 * with a row and asserts this turns false.
 */
export async function carriesProvenance(
  storage: Storage,
  fixture: ContinuityFixture,
  write: ContinuityWriteOutcome,
): Promise<boolean> {
  const engine = storage.engine();
  if (write.op === "page_put") {
    const r = await engine.query<{ source_id: string; written_by: string | null }>(
      `SELECT p.source_id, v.written_by
         FROM pages p
         JOIN page_versions v ON v.slug = p.slug
        WHERE p.slug = $1
        ORDER BY v.version_n ASC
        LIMIT 1`,
      [write.handle],
    );
    const row = r.rows[0];
    return !!row && row.source_id === write.writeSource && row.written_by === write.writer;
  }
  if (write.op === "add_fact") {
    if (write.factId === undefined) return false;
    const r = await engine.query<{ source_id: string; written_by: string | null }>(
      `SELECT source_id, written_by FROM entity_facts WHERE id = $1`,
      [write.factId],
    );
    const row = r.rows[0];
    if (!row || row.source_id !== write.writeSource) return false;
    // `callAddFact` only stamps the caller identity when the write named no
    // provenance of its own (dispatch.ts:2141-2147), so a fixture that passed
    // `source_slug` legitimately has a NULL writer here.
    const args = fixture.writes[write.index]!.args;
    const namedOwnProvenance =
      typeof args["source_slug"] === "string" ||
      typeof args["source_chunk_id"] === "string" ||
      typeof args["written_by"] === "string";
    return namedOwnProvenance || row.written_by === write.writer;
  }
  const args = fixture.writes[write.index]!.args;
  const r = await engine.query<{ source_id: string }>(
    `SELECT source_id FROM links
      WHERE source_slug = $1 AND target_slug = $2 AND type = $3`,
    [args["source_slug"], args["target_slug"], args["type"]],
  );
  return r.rows.some((row) => row.source_id === write.writeSource);
}

async function runProbe(
  storage: Storage,
  fixture: ContinuityFixture,
  probe: ContinuityProbe,
  writes: readonly ContinuityWriteOutcome[],
  handles: ProbeHandles,
): Promise<ContinuityProbeOutcome> {
  const identity = fixture.identities.find((i) => i.id === probe.as)!;
  const outcome: ContinuityProbeOutcome = {
    id: `${fixture.name}#${probe.id}`,
    fixture: fixture.name,
    as: probe.as,
    op: probe.op,
    gold: probe.gold,
    acceptable: probe.acceptable ?? [],
    returned: [],
    provenanceMismatches: [],
    injected: [],
    refused: false,
    ...(probe.note !== undefined ? { note: probe.note } : {}),
  };

  // The ingress guard runs BEFORE dispatch for a public caller, so a forbidden
  // tool never reaches the dispatcher at all. Calling it anyway would grade a
  // code path this caller cannot reach.
  if (identity.isPublic && isPublicMcpToolForbidden(probe.op)) {
    outcome.refused = true;
    return outcome;
  }

  const result = await dispatchTool(
    storage,
    { name: probe.op, arguments: probe.args },
    dispatchOptionsFor(identity),
  );
  const err = errorText(result);
  if (err !== undefined) outcome.error = err;
  outcome.returned = handlesFrom(probe.op, readJson(result), handles);

  const checked = provenanceRequired(probe);
  const byHandle = new Map(writes.map((w) => [w.handle, w] as const));
  for (const handle of outcome.returned) {
    if (checked && probe.gold.includes(handle)) {
      const write = byHandle.get(handle);
      if (!write || !(await carriesProvenance(storage, fixture, write))) {
        outcome.provenanceMismatches.push(handle);
        continue;
      }
    }
    outcome.injected.push(handle);
  }
  return outcome;
}

// --------------------------------------------------------------------------
// The replay
// --------------------------------------------------------------------------

/** Empty the brain, replay one fixture's two sessions, and score the probes. */
export async function runContinuityFixture(
  storage: Storage,
  fixture: ContinuityFixture,
): Promise<ContinuityFixtureRun> {
  await resetBrain(storage);
  await resetProcessGlobals(storage.engine());
  await assertBrainEmpty(storage);

  for (const id of sourcesOf(fixture)) {
    await registerSource(storage.engine(), {
      id,
      kind: "other",
      pathPrefix: `/continuity-bench/${id}`,
      description: `continuity-bench tenant (${fixture.name})`,
    });
  }
  await seedContinuityPages(storage, fixture.pages ?? []);

  const writes: ContinuityWriteOutcome[] = [];
  for (let i = 0; i < fixture.writes.length; i++) {
    writes.push(await runWrite(storage, fixture, i));
  }

  // The session boundary. A probe served out of the query cache written during
  // session A is a cache hit wearing continuity's clothes, so the in-process
  // state goes before session B starts. The database keeps everything — that
  // is the whole point of the family.
  await resetProcessGlobals(storage.engine());

  const facts = new Map<number, string>();
  const links = new Map<string, string>();
  for (const w of writes) {
    if (w.op === "add_fact" && w.factId !== undefined) facts.set(w.factId, w.handle);
    if (w.op === "link") {
      const args = fixture.writes[w.index]!.args;
      links.set(
        `${String(args["source_slug"])} ${String(args["target_slug"])} ${String(args["type"])}`,
        w.handle,
      );
    }
  }
  const handles: ProbeHandles = { facts, links, tenants: new Set(sourcesOf(fixture)) };

  const probes: ContinuityProbeOutcome[] = [];
  for (const probe of fixture.probes) {
    probes.push(await runProbe(storage, fixture, probe, writes, handles));
  }

  return {
    fixture: fixture.name,
    description: fixture.description,
    writes,
    probes,
    scored: probes.map(toScoredProbe),
  };
}

/** Replay a whole corpus on one Storage, in the order given. */
export async function runContinuityCorpus(
  storage: Storage,
  fixtures: readonly ContinuityFixture[],
): Promise<ContinuityCorpusRun> {
  const runs: ContinuityFixtureRun[] = [];
  for (const f of fixtures) runs.push(await runContinuityFixture(storage, f));
  const probes = runs.flatMap((r) => r.probes);
  return { runs, probes, scored: probes.map(toScoredProbe) };
}
