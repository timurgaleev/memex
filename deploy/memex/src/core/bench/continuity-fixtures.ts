/**
 * Continuity fixtures — the labelled corpus behind "written in one session,
 * recalled in a later one, by a DIFFERENT client".
 *
 * A fixture is three things: a set of identities, a session-A write phase, and
 * a session-B probe phase. Each probe carries the handles a human says MUST
 * come back (`gold`); an EMPTY gold is a positive label — "this identity must
 * be shown nothing" — and it is the term that stops a brain scoring well by
 * returning everything to everyone.
 *
 * WHAT THE LOADER ENFORCES, AND WHY EACH RULE EXISTS. A continuity corpus has
 * four ways to score 100% while measuring nothing, and three of them are
 * detectable in the JSON before a single op runs:
 *
 *   1. READ BACK AS YOURSELF. A probe run by the writing identity proves only
 *      that the database kept the row. Every fixture must therefore carry at
 *      least one recall probe whose `as` differs from the identity that wrote
 *      the thing it asks for. The requirement is "a DIFFERENT client"; a corpus
 *      without one is malformed, not merely weak.
 *   2. RETURN EVERYTHING. Perfect recall is free for a brain with no fence, so
 *      every fixture must carry at least one probe labelled `gold: []`.
 *   3. A NEGATIVE THAT COULD NEVER HAVE FIRED. `gold: []` against an op that
 *      returns nothing for anybody is a pass for an exam nobody sat — the same
 *      failure the push harness diagnoses per turn (`harness.ts:17-33`). Here
 *      it is checkable statically: every `gold: []` probe must share its op AND
 *      its exact args with a probe whose gold is non-empty. The fence is then
 *      always graded against a call that demonstrably returns the item.
 *   4. SEED THE ANSWER. A gold slug that was planted in `pages` and never
 *      written measures the seeder. So a provenance-required probe may only
 *      name handles the WRITE phase produced, and no slug may appear in both
 *      `pages` and a write.
 *
 * The fourth cheat — a warm query cache — is not visible in JSON; the harness
 * clears the cache at the session boundary and the test pins it.
 *
 * ARGS ARE VALIDATED AGAINST THE SHIPPED OP CONTRACT. `validateParams`
 * (`mcp/operations.ts:99`) type-checks declared params but silently ignores
 * undeclared ones, and dispatch reads args key by key. So `{"body": "..."}` on
 * a `page_put` (the field is `markdown_body`) or `{"kind": "commitment"}` on an
 * `add_fact` (not an MCP param at all) lands as a page with no body / a fact
 * with no kind, and the fixture author sees a plausible score computed over a
 * write that never happened. Unknown arg keys are rejected here for the same
 * reason `"glod"` is rejected in the push loader.
 *
 * What this file does NOT tell you: whether the labels are RIGHT. It enforces
 * that a fixture is well-formed, internally consistent and structurally
 * un-gameable; whether a human's judgement about what a reader should recall is
 * correct is invisible here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_PAGE_TYPES } from "../pages.ts";
import { OPERATIONS } from "../../mcp/operations.ts";
import type { FixturePage } from "./fixtures.ts";

/** Directory holding the shipped continuity corpus (one fixture per file). */
export const CONTINUITY_CORPUS_DIR = join(import.meta.dir, "corpus-continuity");

/**
 * One caller. The fields map onto `AuthInfo` (`core/auth-info.ts:24`) and are
 * resolved into a read/write scope by the PRODUCTION resolvers at run time —
 * a bench that reimplements scoping grades its own copy of the fence.
 */
export interface BenchIdentity {
  /** Fixture-local handle, referenced by `writes[].as` / `probes[].as`. */
  id: string;
  /** Becomes `AuthInfo.clientId`, and through it the `client:<id>` writer stamp. */
  clientId: string;
  /** `AuthInfo.sourceId` — the tenant this client writes to. Omit = unscoped. */
  writeSource?: string;
  /** `AuthInfo.allowedSources` — the federated read grant. Omit = whole brain. */
  readSources?: string[];
  /** Granted OAuth scopes; dispatch refuses a write op to a read-only token. */
  scopes?: string[];
  /**
   * The static public bearer (`brain.<domain>/mcp`): dispatched with
   * `isPublic: true` and NO authInfo, which is the shape that ingress actually
   * presents. An identity that sets this may declare nothing else — an
   * authenticated public OAuth client is a different principal with different
   * gates, and half-modelling it here would grade a caller memex does not have.
   */
  isPublic?: boolean;
}

/** Write ops a session-A phase may perform. See the harness for why the list
 *  is closed and why `page_put` does not go through dispatch. */
export type ContinuityWriteOp = "page_put" | "add_fact" | "link";

export interface ContinuitySessionWrite {
  /** Which identity performs it. */
  as: string;
  op: ContinuityWriteOp;
  args: Record<string, unknown>;
}

/** Read ops a probe may use. All are model-free except `search`/`query`, which
 *  the harness drives through the `DispatchOptions.embedQuery` seam. */
export type ContinuityProbeOp =
  | "page_get"
  | "page_list"
  | "entity_facts"
  | "resolve_slugs"
  | "volunteer_context"
  | "get_links"
  | "search"
  | "query";

export interface ContinuityProbe {
  id: string;
  as: string;
  op: ContinuityProbeOp;
  args: Record<string, unknown>;
  /**
   * Handles that MUST come back: a page slug, or `fact:<n>` / `link:<n>`
   * naming `writes[n]`. `[]` is the leak label — this identity must be shown
   * nothing from the write set. Required, never defaulted.
   */
  gold: string[];
  /** Defensible if returned; counts for precision, never for recall. */
  acceptable?: string[];
  /**
   * Require every gold handle to carry the session-A write's provenance
   * (tenant stamp + writer stamp + row identity). Defaults to true for a
   * recall probe. Meaningless on a leak probe, so setting it there is an error
   * rather than a no-op.
   */
  requireProvenance?: boolean;
  note?: string;
}

export interface ContinuityFixture {
  /** Corpus-unique identifier; must equal the file's basename. */
  name: string;
  description: string;
  identities: BenchIdentity[];
  /** Brain state BEFORE session A. Never the answer to a provenance probe. */
  pages?: FixturePage[];
  /** Session A. */
  writes: ContinuitySessionWrite[];
  /** Session B — run after the explicit session boundary (see the harness). */
  probes: ContinuityProbe[];
}

const FIXTURE_KEYS = new Set([
  "name",
  "description",
  "identities",
  "pages",
  "writes",
  "probes",
]);
const IDENTITY_KEYS = new Set([
  "id",
  "clientId",
  "writeSource",
  "readSources",
  "scopes",
  "isPublic",
]);
const WRITE_KEYS = new Set(["as", "op", "args"]);
const PROBE_KEYS = new Set([
  "id",
  "as",
  "op",
  "args",
  "gold",
  "acceptable",
  "requireProvenance",
  "note",
]);
const PAGE_KEYS = new Set(["slug", "type", "title", "body", "aliases", "source"]);

const WRITE_OPS = new Set<string>(["page_put", "add_fact", "link"]);
const PROBE_OPS = new Set<string>([
  "page_get",
  "page_list",
  "entity_facts",
  "resolve_slugs",
  "volunteer_context",
  "get_links",
  "search",
  "query",
]);

/** Declared param names per op, straight from the shipped contract. */
const PARAMS_BY_OP = new Map<string, ReadonlySet<string>>(
  OPERATIONS.map((op) => [op.name, new Set(Object.keys(op.params))] as const),
);

/** Thrown for any malformed fixture. Carries the offending path in `where`. */
export class ContinuityFixtureError extends Error {
  readonly where: string;
  constructor(where: string, detail: string) {
    super(`continuity fixture ${where}: ${detail}`);
    this.name = "ContinuityFixtureError";
    this.where = where;
  }
}

function fail(where: string, detail: string): never {
  throw new ContinuityFixtureError(where, detail);
}

function asObject(where: string, v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(where, `expected an object, got ${Array.isArray(v) ? "an array" : typeof v}`);
  }
  return v as Record<string, unknown>;
}

function rejectUnknownKeys(
  where: string,
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${[...allowed].sort().join(", ")})`);
    }
  }
}

function requireString(where: string, obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    fail(`${where}.${key}`, `expected a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireStringArray(where: string, obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) fail(`${where}.${key}`, `expected an array, got ${JSON.stringify(v)}`);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== "string" || item.trim() === "") {
      fail(`${where}.${key}[${i}]`, `expected a non-empty string, got ${JSON.stringify(item)}`);
    }
    if (out.includes(item)) fail(`${where}.${key}[${i}]`, `duplicate entry ${JSON.stringify(item)}`);
    out.push(item);
  }
  return out;
}

function optionalStringArray(
  where: string,
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  return key in obj ? requireStringArray(where, obj, key) : undefined;
}

function parseIdentity(where: string, raw: unknown): BenchIdentity {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, IDENTITY_KEYS);
  const identity: BenchIdentity = {
    id: requireString(where, obj, "id"),
    clientId: requireString(where, obj, "clientId"),
  };
  if ("isPublic" in obj) {
    if (obj["isPublic"] !== true) {
      fail(`${where}.isPublic`, "only `true` is meaningful — omit the key for an internal caller");
    }
    for (const k of ["writeSource", "readSources", "scopes"]) {
      if (k in obj) {
        fail(
          `${where}.${k}`,
          "a public identity is the static bearer: it carries no grant of its own. " +
            "An authenticated public client is a different principal and no fixture models it yet.",
        );
      }
    }
    identity.isPublic = true;
    return identity;
  }
  if ("writeSource" in obj) identity.writeSource = requireString(where, obj, "writeSource");
  const readSources = optionalStringArray(where, obj, "readSources");
  if (readSources !== undefined) {
    if (readSources.length === 0) {
      fail(`${where}.readSources`, "an empty array reads as unscoped — omit the key instead");
    }
    identity.readSources = readSources;
  }
  const scopes = optionalStringArray(where, obj, "scopes");
  if (scopes !== undefined) identity.scopes = scopes;
  return identity;
}

function parsePage(where: string, raw: unknown): FixturePage {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, PAGE_KEYS);
  const type = requireString(where, obj, "type");
  if (!(KNOWN_PAGE_TYPES as readonly string[]).includes(type)) {
    fail(`${where}.type`, `${JSON.stringify(type)} is not a known page type`);
  }
  const page: FixturePage = {
    slug: requireString(where, obj, "slug"),
    type,
    title: requireString(where, obj, "title"),
    body: requireString(where, obj, "body"),
  };
  const aliases = optionalStringArray(where, obj, "aliases");
  if (aliases) page.aliases = aliases;
  if ("source" in obj) page.source = requireString(where, obj, "source");
  return page;
}

/** Reject arg keys the shipped op does not declare — see the header. */
function checkArgs(where: string, op: string, args: Record<string, unknown>): void {
  const declared = PARAMS_BY_OP.get(op);
  if (!declared) fail(where, `no shipped operation named ${JSON.stringify(op)}`);
  for (const k of Object.keys(args)) {
    if (!declared.has(k)) {
      fail(
        `${where}.args`,
        `${JSON.stringify(k)} is not a parameter of '${op}' — dispatch would ignore it ` +
          `silently (declared: ${[...declared].sort().join(", ")})`,
      );
    }
  }
}

function parseWrite(where: string, raw: unknown, ids: ReadonlySet<string>): ContinuitySessionWrite {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, WRITE_KEYS);
  const as = requireString(where, obj, "as");
  if (!ids.has(as)) fail(`${where}.as`, `${JSON.stringify(as)} is not a declared identity`);
  const op = requireString(where, obj, "op");
  if (!WRITE_OPS.has(op)) {
    fail(`${where}.op`, `expected one of ${[...WRITE_OPS].sort().join(", ")}, got ${JSON.stringify(op)}`);
  }
  const args = asObject(`${where}.args`, obj["args"]);
  checkArgs(where, op, args);
  // The writer stamp is the caller's identity, resolved by the same helper
  // dispatch uses. Letting a fixture name its own would hand it the provenance
  // the probe is supposed to prove.
  if (op === "page_put" && "written_by" in args) {
    fail(
      `${where}.args.written_by`,
      "the harness stamps the writing identity — a fixture that sets its own writer " +
        "would be asserting the provenance its probes exist to verify",
    );
  }
  return { as, op: op as ContinuityWriteOp, args };
}

function parseProbe(where: string, raw: unknown, ids: ReadonlySet<string>): ContinuityProbe {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, PROBE_KEYS);
  const as = requireString(where, obj, "as");
  if (!ids.has(as)) fail(`${where}.as`, `${JSON.stringify(as)} is not a declared identity`);
  const op = requireString(where, obj, "op");
  if (!PROBE_OPS.has(op)) {
    fail(`${where}.op`, `expected one of ${[...PROBE_OPS].sort().join(", ")}, got ${JSON.stringify(op)}`);
  }
  const args = asObject(`${where}.args`, obj["args"]);
  checkArgs(where, op, args);
  // `query --refine` reaches queryRefine, which embeds the refine text through
  // the real Titan path — the embedQuery seam does not cover it. A bench probe
  // must not be able to spend money by naming a parameter.
  if (op === "query" && "refine" in args) {
    fail(`${where}.args.refine`, "the refine path has no embedder seam and would call Bedrock");
  }
  if (!("gold" in obj)) {
    fail(`${where}.gold`, "missing — every probe must be labelled ([] means 'must see nothing')");
  }
  const gold = requireStringArray(where, obj, "gold");
  const acceptable = optionalStringArray(where, obj, "acceptable") ?? [];
  for (const h of acceptable) {
    if (gold.includes(h)) fail(`${where}.acceptable`, `${JSON.stringify(h)} is already required by gold`);
  }
  const probe: ContinuityProbe = {
    id: requireString(where, obj, "id"),
    as,
    op: op as ContinuityProbeOp,
    args,
    gold,
  };
  if (acceptable.length) probe.acceptable = acceptable;
  if ("requireProvenance" in obj) {
    const v = obj["requireProvenance"];
    if (typeof v !== "boolean") fail(`${where}.requireProvenance`, "expected a boolean");
    if (gold.length === 0 && v) {
      fail(
        `${where}.requireProvenance`,
        "a leak probe has no gold to attach provenance to — the label is `gold: []`",
      );
    }
    probe.requireProvenance = v;
  }
  if ("note" in obj) probe.note = requireString(where, obj, "note");
  return probe;
}

/** True when a probe's gold must carry session-A provenance (default for recall). */
export function provenanceRequired(probe: ContinuityProbe): boolean {
  return probe.gold.length > 0 && (probe.requireProvenance ?? true);
}

/** The handle a write produces: its page slug, or `fact:<n>` / `link:<n>`. */
export function writeHandle(fixture: ContinuityFixture, index: number): string {
  const w = fixture.writes[index]!;
  if (w.op === "page_put") return String(w.args["slug"]);
  return `${w.op === "add_fact" ? "fact" : "link"}:${index}`;
}

/** Key-order-independent form of an arg object, so "same args" is a real
 *  comparison rather than a comparison of how the JSON happened to be typed. */
function stableArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableArgs(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Validate a parsed JSON value as a continuity fixture. */
export function parseContinuityFixture(where: string, raw: unknown): ContinuityFixture {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, FIXTURE_KEYS);
  const name = requireString(where, obj, "name");
  const description = requireString(where, obj, "description");

  const rawIdentities = obj["identities"];
  if (!Array.isArray(rawIdentities) || rawIdentities.length < 2) {
    fail(
      `${where}.identities`,
      "expected at least two identities — a corpus with one client cannot express " +
        "'recalled by a DIFFERENT client'",
    );
  }
  const identities = rawIdentities.map((v, i) => parseIdentity(`${where}.identities[${i}]`, v));
  const ids = new Set<string>();
  for (const identity of identities) {
    if (ids.has(identity.id)) fail(`${where}.identities`, `duplicate id ${JSON.stringify(identity.id)}`);
    ids.add(identity.id);
  }

  const rawPages = obj["pages"];
  let pages: FixturePage[] = [];
  if (rawPages !== undefined) {
    if (!Array.isArray(rawPages)) fail(`${where}.pages`, "expected an array of seed pages");
    pages = rawPages.map((p, i) => parsePage(`${where}.pages[${i}]`, p));
  }
  const seeded = new Set<string>();
  for (const p of pages) {
    if (seeded.has(p.slug)) fail(`${where}.pages`, `duplicate slug ${JSON.stringify(p.slug)}`);
    seeded.add(p.slug);
  }

  const rawWrites = obj["writes"];
  if (!Array.isArray(rawWrites) || rawWrites.length === 0) {
    fail(`${where}.writes`, "expected a non-empty session-A write phase");
  }
  const writes = rawWrites.map((w, i) => parseWrite(`${where}.writes[${i}]`, w, ids));

  const rawProbes = obj["probes"];
  if (!Array.isArray(rawProbes) || rawProbes.length === 0) {
    fail(`${where}.probes`, "expected a non-empty session-B probe phase");
  }
  const probes = rawProbes.map((p, i) => parseProbe(`${where}.probes[${i}]`, p, ids));
  const probeIds = new Set<string>();
  for (const p of probes) {
    if (probeIds.has(p.id)) fail(`${where}.probes`, `duplicate probe id ${JSON.stringify(p.id)}`);
    probeIds.add(p.id);
  }

  const fixture: ContinuityFixture = { name, description, identities, writes, probes };
  if (pages.length) fixture.pages = pages;

  // Cheat 4 (seed the answer), first half: a slug cannot be both the brain's
  // prior state and the thing session A wrote.
  const writtenSlugs = new Map<string, number>();
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i]!;
    if (w.op !== "page_put") continue;
    const slug = w.args["slug"];
    if (typeof slug !== "string") fail(`${where}.writes[${i}].args.slug`, "page_put needs a slug");
    if (seeded.has(slug)) {
      fail(
        `${where}.writes[${i}].args.slug`,
        `${JSON.stringify(slug)} is also a seeded page — a probe would find it whether or not ` +
          `the write ran, which measures the seeder`,
      );
    }
    // Two writes to one slug give the handle two provenances, and the probe
    // would be graded against whichever the harness happened to record last.
    if (writtenSlugs.has(slug)) {
      fail(`${where}.writes[${i}].args.slug`, `${JSON.stringify(slug)} is written twice`);
    }
    writtenSlugs.set(slug, i);
  }

  // Every labelled handle has to name something this fixture actually has, and
  // every provenance-required one has to name something the WRITE phase
  // produced (cheat 4, second half). The same pass catches the visibility trap:
  // `add_fact` defaults to 'private', which only the operator reads back
  // (dispatch floors every scoped caller to 'world'), so a fact that is gold
  // for a scoped reader and omits `visibility` measures that default.
  const handleToWrite = new Map<string, number>();
  for (let i = 0; i < writes.length; i++) handleToWrite.set(writeHandle(fixture, i), i);

  for (const probe of probes) {
    for (const [key, list] of [
      ["gold", probe.gold],
      ["acceptable", probe.acceptable ?? []],
    ] as const) {
      for (const handle of list) {
        const m = /^(fact|link):(\d+)$/.exec(handle);
        if (m) {
          const idx = Number(m[2]);
          const w = writes[idx];
          const want = m[1] === "fact" ? "add_fact" : "link";
          if (!w || w.op !== want) {
            fail(
              `${where}.probes(${probe.id}).${key}`,
              `${JSON.stringify(handle)} does not name a ${want} write`,
            );
          }
          continue;
        }
        if (!seeded.has(handle) && !writtenSlugs.has(handle)) {
          fail(
            `${where}.probes(${probe.id}).${key}`,
            `${JSON.stringify(handle)} is neither a seeded page, a written page, ` +
              `nor a fact:/link: handle`,
          );
        }
      }
    }
    if (!provenanceRequired(probe)) continue;
    for (const handle of probe.gold) {
      const idx = handleToWrite.get(handle);
      if (idx === undefined) {
        fail(
          `${where}.probes(${probe.id}).gold`,
          `${JSON.stringify(handle)} was not produced by the write phase, so provenance ` +
            `cannot be required of it — seed-only recall needs requireProvenance: false ` +
            `and a note saying what it measures`,
        );
      }
      const w = writes[idx]!;
      if (w.op === "add_fact" && typeof w.args["visibility"] !== "string") {
        fail(
          `${where}.writes[${idx}].args.visibility`,
          "a fact recalled by a scoped reader must declare its visibility — the column " +
            "default is 'private' and every non-operator read is floored to 'world', so " +
            "omitting it measures the default instead of continuity",
        );
      }
    }
  }

  // Cheat 1: at least one recall probe by an identity that did not write it.
  const crossIdentity = probes.some(
    (p) =>
      provenanceRequired(p) &&
      p.gold.every((h) => {
        const idx = handleToWrite.get(h);
        return idx !== undefined && writes[idx]!.as !== p.as;
      }),
  );
  if (!crossIdentity) {
    fail(
      `${where}.probes`,
      "no recall probe is performed by an identity other than the one that wrote its gold — " +
        "this fixture measures a database, not continuity across clients",
    );
  }

  // Cheat 2 + 3: at least one leak probe, and every leak probe paired with a
  // recall probe over the same op and the same args.
  const leaks = probes.filter((p) => p.gold.length === 0);
  if (leaks.length === 0) {
    fail(
      `${where}.probes`,
      "no probe is labelled `gold: []` — without a negative case, 'return everything' scores 100%",
    );
  }
  for (const leak of leaks) {
    const paired = probes.some(
      (p) => p.gold.length > 0 && p.op === leak.op && stableArgs(p.args) === stableArgs(leak.args),
    );
    if (!paired) {
      fail(
        `${where}.probes(${leak.id})`,
        `no probe with the same op and args returns anything, so this negative case could ` +
          `never have fired — pair it with the identity that IS allowed to see the item`,
      );
    }
  }

  return fixture;
}

/** Load and validate one fixture file. The basename is its identity. */
export function loadContinuityFixtureFile(path: string): ContinuityFixture {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ContinuityFixtureError(path, `invalid JSON — ${(e as Error).message}`);
  }
  const fixture = parseContinuityFixture(path, raw);
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
  if (fixture.name !== base) {
    throw new ContinuityFixtureError(
      path,
      `name ${JSON.stringify(fixture.name)} != filename ${JSON.stringify(base)}`,
    );
  }
  return fixture;
}

/**
 * Load every `*.json` fixture in `dir`, sorted by filename so a run is
 * reproducible. Throws on the first malformed file — a corpus that half-loads
 * would report scores over a corpus nobody chose.
 */
export function loadContinuityCorpus(dir: string = CONTINUITY_CORPUS_DIR): ContinuityFixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new ContinuityFixtureError(dir, "no *.json fixtures found");
  const out: ContinuityFixture[] = [];
  const names = new Set<string>();
  for (const f of files) {
    const fixture = loadContinuityFixtureFile(join(dir, f));
    if (names.has(fixture.name)) {
      throw new ContinuityFixtureError(join(dir, f), `duplicate fixture name ${JSON.stringify(fixture.name)}`);
    }
    names.add(fixture.name);
    out.push(fixture);
  }
  return out;
}
