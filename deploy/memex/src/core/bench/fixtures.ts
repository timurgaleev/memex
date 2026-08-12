/**
 * Push-bench fixtures — the labelled corpus behind the volunteer scores.
 *
 * A fixture is a self-contained miniature brain plus a labelled conversation:
 * a handful of seed pages, then an ordered list of turns, each carrying the
 * slugs a human says MUST surface on that turn (`gold`) and the ones that are
 * merely defensible (`acceptable`). An empty `gold` is a POSITIVE label — "the
 * brain must stay quiet here" — not a missing one, which is why `gold` is
 * required on every turn and never defaulted.
 *
 * This module is the loader and the validator, nothing else. It is strict on
 * purpose: unknown keys are rejected, and every slug named in a label must
 * exist among that fixture's seed pages. A corpus is hand-maintained JSON, and
 * the failure mode that matters is silent: `"glod": ["people/dana"]` parses
 * fine, leaves `gold` empty, and turns a recall case into a silence case that
 * passes under every configuration. A typo must stop the run, loudly, at load
 * time — long before a score is computed from it.
 *
 * What this file does NOT tell you: whether the labels are RIGHT. It enforces
 * that a fixture is well-formed and internally consistent; the judgement of
 * what should surface on a turn is a human's, and a wrong-but-well-formed label
 * is invisible here. It also says nothing about coverage — a corpus can be
 * perfectly valid and still miss every case the retrieval path gets wrong.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_PAGE_TYPES } from "../pages.ts";

/** Directory holding the shipped corpus (`*.json`, one fixture per file). */
export const CORPUS_DIR = join(import.meta.dir, "corpus");

/** A seed page written into the brain before the conversation is replayed. */
export interface FixturePage {
  slug: string;
  /** Must be one of KNOWN_PAGE_TYPES — an ad-hoc type is a fixture typo. */
  type: string;
  title: string;
  /** Markdown body; also the fallback synopsis source. */
  body: string;
  /** Declared aliases (compiled_truth.aliases) — the alias resolver arm. */
  aliases?: string[];
  /** Owning source (tenant). Defaults to "default". */
  source?: string;
}

/** One labelled conversation turn. */
export interface FixtureTurn {
  role: "user" | "assistant";
  text: string;
  /** Slugs that MUST be volunteered. Empty = the brain must stay silent. */
  gold: string[];
  /** Slugs that are defensible if volunteered, but not required. */
  acceptable?: string[];
  /** Free-text rationale for the label. Ignored by the harness. */
  note?: string;
}

export interface PushFixture {
  /** Corpus-unique identifier; must equal the file's basename. */
  name: string;
  description: string;
  /** Rolling window size in turns (including the current one). Default 4. */
  windowTurns?: number;
  /** Overrides volunteerContext's default confidence gate. */
  minConfidence?: number;
  /** Overrides volunteerContext's default page cap. */
  maxPages?: number;
  /** Caller read scope. Omitted = unscoped (operator / local CLI). */
  sourceIds?: string[];
  pages: FixturePage[];
  turns: FixtureTurn[];
}

const FIXTURE_KEYS = new Set([
  "name",
  "description",
  "windowTurns",
  "minConfidence",
  "maxPages",
  "sourceIds",
  "pages",
  "turns",
]);
const PAGE_KEYS = new Set(["slug", "type", "title", "body", "aliases", "source"]);
const TURN_KEYS = new Set(["role", "text", "gold", "acceptable", "note"]);
const ROLES = new Set(["user", "assistant"]);

/** Thrown for any malformed fixture. Carries the offending path in `where`. */
export class FixtureError extends Error {
  readonly where: string;
  constructor(where: string, detail: string) {
    super(`push-bench fixture ${where}: ${detail}`);
    this.name = "FixtureError";
    this.where = where;
  }
}

function fail(where: string, detail: string): never {
  throw new FixtureError(where, detail);
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
      fail(
        where,
        `unknown key ${JSON.stringify(k)} (allowed: ${[...allowed].sort().join(", ")})`,
      );
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

function optionalStringArray(
  where: string,
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (!(key in obj)) return undefined;
  return requireStringArray(where, obj, key);
}

function requireStringArray(
  where: string,
  obj: Record<string, unknown>,
  key: string,
): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    fail(`${where}.${key}`, `expected an array, got ${JSON.stringify(v)}`);
  }
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

function optionalInt(
  where: string,
  obj: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    fail(`${where}.${key}`, `expected an integer >= ${min}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function parsePage(where: string, raw: unknown): FixturePage {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, PAGE_KEYS);
  const type = requireString(where, obj, "type");
  if (!(KNOWN_PAGE_TYPES as readonly string[]).includes(type)) {
    fail(
      `${where}.type`,
      `${JSON.stringify(type)} is not a known page type (${KNOWN_PAGE_TYPES.join(", ")})`,
    );
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

function parseTurn(where: string, raw: unknown, slugs: ReadonlySet<string>): FixtureTurn {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, TURN_KEYS);
  const role = requireString(where, obj, "role");
  if (!ROLES.has(role)) {
    fail(`${where}.role`, `expected "user" or "assistant", got ${JSON.stringify(role)}`);
  }
  // `gold` is REQUIRED even when empty: an absent label and a deliberate
  // silence label must never look the same.
  if (!("gold" in obj)) {
    fail(`${where}.gold`, "missing — every turn must be labelled ([] means 'stay silent')");
  }
  const gold = requireStringArray(where, obj, "gold");
  const acceptable = optionalStringArray(where, obj, "acceptable") ?? [];
  for (const [key, list] of [
    ["gold", gold],
    ["acceptable", acceptable],
  ] as const) {
    for (const slug of list) {
      if (!slugs.has(slug)) {
        fail(
          `${where}.${key}`,
          `${JSON.stringify(slug)} is not a seeded page in this fixture ` +
            `(seeded: ${[...slugs].join(", ")})`,
        );
      }
    }
  }
  for (const slug of acceptable) {
    if (gold.includes(slug)) {
      fail(`${where}.acceptable`, `${JSON.stringify(slug)} is already required by gold`);
    }
  }
  const turn: FixtureTurn = {
    role: role as FixtureTurn["role"],
    text: requireString(where, obj, "text"),
    gold,
  };
  if (acceptable.length) turn.acceptable = acceptable;
  if ("note" in obj) turn.note = requireString(where, obj, "note");
  return turn;
}

/** Validate a parsed JSON value as a fixture. `where` labels error messages. */
export function parseFixture(where: string, raw: unknown): PushFixture {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, FIXTURE_KEYS);
  const name = requireString(where, obj, "name");
  const description = requireString(where, obj, "description");

  const rawPages = obj["pages"];
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    fail(`${where}.pages`, "expected a non-empty array of seed pages");
  }
  const pages = rawPages.map((p, i) => parsePage(`${where}.pages[${i}]`, p));
  const slugs = new Set<string>();
  for (const p of pages) {
    if (slugs.has(p.slug)) fail(`${where}.pages`, `duplicate slug ${JSON.stringify(p.slug)}`);
    slugs.add(p.slug);
  }

  const rawTurns = obj["turns"];
  if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
    fail(`${where}.turns`, "expected a non-empty array of labelled turns");
  }
  const turns = rawTurns.map((t, i) => parseTurn(`${where}.turns[${i}]`, t, slugs));

  const fixture: PushFixture = { name, description, pages, turns };

  const windowTurns = optionalInt(where, obj, "windowTurns", 1);
  if (windowTurns !== undefined) fixture.windowTurns = windowTurns;
  const maxPages = optionalInt(where, obj, "maxPages", 1);
  if (maxPages !== undefined) fixture.maxPages = maxPages;
  if ("minConfidence" in obj) {
    const v = obj["minConfidence"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      fail(`${where}.minConfidence`, `expected a number in [0, 1], got ${JSON.stringify(v)}`);
    }
    fixture.minConfidence = v;
  }
  const sourceIds = optionalStringArray(where, obj, "sourceIds");
  if (sourceIds !== undefined) {
    if (sourceIds.length === 0) {
      fail(`${where}.sourceIds`, "empty array means unscoped — omit the key instead");
    }
    fixture.sourceIds = sourceIds;
    // A gold slug outside the caller's own scope asks the brain to leak. That
    // is a labelling bug, not an expectation the harness should try to meet.
    const scope = new Set(sourceIds);
    const sourceBySlug = new Map(pages.map((p) => [p.slug, p.source ?? "default"]));
    for (let i = 0; i < turns.length; i++) {
      for (const slug of turns[i]!.gold) {
        const src = sourceBySlug.get(slug)!;
        if (!scope.has(src)) {
          fail(
            `${where}.turns[${i}].gold`,
            `${JSON.stringify(slug)} is owned by source ${JSON.stringify(src)}, ` +
              `outside the fixture's sourceIds — a scoped caller must never be volunteered it`,
          );
        }
      }
    }
  }

  return fixture;
}

/** Load and validate one fixture file. The basename is its identity. */
export function loadFixtureFile(path: string): PushFixture {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FixtureError(path, `invalid JSON — ${(e as Error).message}`);
  }
  const fixture = parseFixture(path, raw);
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
  if (fixture.name !== base) {
    throw new FixtureError(path, `name ${JSON.stringify(fixture.name)} != filename ${JSON.stringify(base)}`);
  }
  return fixture;
}

/**
 * Load every `*.json` fixture in `dir`, sorted by filename so a run is
 * reproducible. Throws on the first malformed file — a corpus that half-loads
 * would report scores over a corpus nobody chose.
 */
export function loadCorpus(dir: string = CORPUS_DIR): PushFixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new FixtureError(dir, "no *.json fixtures found");
  const out: PushFixture[] = [];
  const names = new Set<string>();
  for (const f of files) {
    const fixture = loadFixtureFile(join(dir, f));
    if (names.has(fixture.name)) {
      throw new FixtureError(join(dir, f), `duplicate fixture name ${JSON.stringify(fixture.name)}`);
    }
    names.add(fixture.name);
    out.push(fixture);
  }
  return out;
}
