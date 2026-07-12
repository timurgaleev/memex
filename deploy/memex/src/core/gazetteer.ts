/**
 * Gazetteer auto-linking — derive `mentions` edges from a page body by
 * matching plain-text references to KNOWN entity pages, beyond the explicit
 * `[[wikilink]]` syntax.
 *
 * Today a page only links to another via an explicit `[[Alice Smith]]`. The
 * gazetteer additionally scans the body prose: if it names an existing
 * person/company page (by title or declared alias), a `mentions` edge is
 * created. Built on the slug canonicalizer (#1) + page aliases (#3): the
 * gazetteer entries ARE existing pages, so each match resolves to a real
 * canonical slug with no fuzzy guessing.
 *
 * FALSE-POSITIVE SENSITIVE — DEFAULT OFF. Matching prose against page titles
 * risks wrong edges (a person named "Will", a company "Apple"). So this is
 * opt-in (`MEMEX_GAZETTEER=1`) and conservatively guarded:
 *   - only `person` / `company` pages (named entities, not generic notes);
 *   - a phrase must be within a length band and not numeric / a stop-word;
 *   - a PROPER-NOUN heuristic: a match whose surface form is lowercase in the
 *     prose (the common-word sense) is skipped;
 *   - maximal-munch (longest phrase wins) at UNICODE word boundaries,
 *     case-insensitive, whitespace-flexible;
 *   - existing `[[wikilink]]` spans are masked out before the scan;
 *   - a page never mentions itself; first mention per target only;
 *   - the gazetteer replaces ONLY its own `link_kind='plain'` mention edges
 *     and never clobbers an explicit `mentions` edge (INSERT … DO NOTHING).
 *
 * memex defaults auto-linking OFF because its single
 * flat vault has no page-type/source scoping to contain a bad match.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { normalizeAlias } from "./page-aliases.ts";
import { stripCodeBlocks, validateSlug } from "./links.ts";

/** Entity page types eligible for gazetteer matching (named entities only). */
const GAZETTEER_TYPES = ["person", "company"] as const;
/** Minimum phrase length in CODE POINTS — shorter names collide with prose. */
const MIN_PHRASE_LEN = 4;
/** Maximum phrase length — an unbounded TEXT title would bloat the scan regex. */
const MAX_PHRASE_LEN = 200;
/** Upper bound on gazetteer entries (defence vs an unbounded scan regex). */
const MAX_ENTRIES = 5000;
/** Upper bound on the body scanned (chars) — matches the indexer's file cap intent. */
const MAX_BODY_LEN = 1_000_000;
/**
 * Common words a person/company title might equal but which routinely appear
 * in prose — a single-token title in this set is never auto-linked. Best-effort
 * (a stop-list is inherently incomplete); the structural defenses are the
 * proper-noun (capitalized-in-source) heuristic, the named-entity type filter,
 * the ambiguity drop, and DEFAULT-OFF.
 */
const STOP_PHRASES = new Set([
  "note", "page", "idea", "meeting", "company", "person", "team", "group",
  "project", "task", "event", "today", "test", "draft", "inbox",
  // common English words that are also frequent names/brands
  "mark", "will", "summer", "april", "june", "apple", "next", "square",
  "amber", "hope", "grace", "rose", "ray", "art", "max", "sky", "dawn",
  "story", "field", "river", "stone", "frank", "drew", "major", "case",
]);

/**
 * Gazetteer auto-linking is OPT-IN: `MEMEX_GAZETTEER=1` enables it. Default
 * OFF — a wrong auto-link silently pollutes the graph, so the operator turns
 * it on only after confirming it behaves on their vault.
 */
export function gazetteerEnabled(
  env: string | undefined = process.env.MEMEX_GAZETTEER,
): boolean {
  return env === "1";
}

export interface GazetteerEntry {
  /** Normalized lowercase phrase (a page title or alias). */
  phrase: string;
  /** Canonical slug the phrase resolves to. */
  slug: string;
}

/** Count code points up to a cap (avoids walking a pathological long string). */
function codePointLen(s: string, cap: number): number {
  let n = 0;
  for (const _ of s) {
    if (++n > cap) break;
  }
  return n;
}

/** A normalized phrase is usable iff in the length band, not purely numeric,
 *  not a stop-word. Length is counted in CODE POINTS. */
function isUsablePhrase(phrase: string): boolean {
  if (STOP_PHRASES.has(phrase)) return false;
  if (/^[0-9\s]+$/.test(phrase)) return false;
  const n = codePointLen(phrase, MAX_PHRASE_LEN + 1);
  return n >= MIN_PHRASE_LEN && n <= MAX_PHRASE_LEN;
}

/**
 * Build the gazetteer for one sync: every person/company page's title +
 * declared aliases, normalized, filtered, EXCLUDING the source page (a page
 * never auto-mentions itself). Sorted longest-phrase-first so the scan does
 * maximal munch. Capped at MAX_ENTRIES.
 */
export async function buildGazetteer(
  storage: Storage,
  sourceSlug: string,
  sourceIds?: string[],
): Promise<GazetteerEntry[]> {
  const typeList = GAZETTEER_TYPES.map((t) => `'${t}'`).join(", ");
  // Tenant scope (mig047): when a write source is present, the entry table is
  // built ONLY from that source's entity pages, so a per-tenant auto-link never
  // matches (and edges to) another tenant's person/company. Unscoped (the
  // corpus-wide sweep / local caller) stays whole-brain. GAZETTEER_TYPES is a
  // hardcoded const (no injection); slug is bound via $1, sources via $2.
  const scope = sourceIds && sourceIds.length > 0 ? sourceIds : undefined;
  const pageParams: unknown[] = [sourceSlug];
  let pageScope = "";
  if (scope) {
    pageParams.push(scope);
    pageScope = ` AND source_id = ANY($${pageParams.length}::text[])`;
  }
  // LIMIT bounds the load on a large vault, preferring longer (more specific)
  // titles/aliases.
  const r = await storage.engine().query<{ slug: string; title: string | null }>(
    `SELECT slug, title FROM pages
      WHERE deleted_at IS NULL AND slug <> $1 AND type IN (${typeList})${pageScope}
      ORDER BY length(title) DESC NULLS LAST
      LIMIT ${MAX_ENTRIES}`,
    pageParams,
  );
  const aliasParams: unknown[] = [sourceSlug];
  let aliasScope = "";
  if (scope) {
    aliasParams.push(scope);
    aliasScope = ` AND p.source_id = ANY($${aliasParams.length}::text[])`;
  }
  const aliasRows = await storage.engine().query<{ slug: string; alias_norm: string }>(
    `SELECT pa.slug, pa.alias_norm
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.deleted_at IS NULL
      WHERE p.slug <> $1 AND p.type IN (${typeList})${aliasScope}
      ORDER BY length(pa.alias_norm) DESC
      LIMIT ${MAX_ENTRIES}`,
    aliasParams,
  );

  // A phrase claimed by two DIFFERENT pages is ambiguous → drop it entirely
  // (same safe posture as the canonicalizer). `null` marks an ambiguous key.
  const byPhrase = new Map<string, string | null>();
  const add = (raw: string | null, slug: string) => {
    const phrase = normalizeAlias(raw);
    if (!isUsablePhrase(phrase)) return;
    const prior = byPhrase.get(phrase);
    if (prior === undefined) {
      byPhrase.set(phrase, slug);
    } else if (prior !== null && prior !== slug) {
      byPhrase.set(phrase, null); // collision → ambiguous
    }
  };
  for (const row of r.rows) add(row.title, row.slug);
  for (const row of aliasRows.rows) add(row.alias_norm, row.slug);

  const entries: GazetteerEntry[] = [];
  for (const [phrase, slug] of byPhrase) {
    if (slug === null) continue; // ambiguous
    entries.push({ phrase, slug });
    if (entries.length >= MAX_ENTRIES) break;
  }
  // Longest first → maximal munch (a regex alternation tries branches left to right).
  entries.sort(
    (a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase),
  );
  return entries;
}

/** Escape a literal phrase for safe inclusion in a RegExp (no injection / ReDoS). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the alternation branch for one phrase: each whitespace-separated token
 *  escaped, joined by `\s+` so multiple spaces / newlines in the body still match
 *  (the phrase was whitespace-collapsed by normalizeAlias, the body is raw). */
function phraseToPattern(phrase: string): string {
  return phrase.split(" ").map(escapeRegExp).join("\\s+");
}

const WIKILINK_SPAN_RE = /\[\[[^\]\n]*\]\]/g;

/**
 * Scan `body` for first-mention matches of the gazetteer, returning the
 * distinct target slugs (in first-appearance order). The body is NFKC-folded
 * (to match the normalized phrases) and its `[[wikilink]]` spans are masked
 * (replaced with same-length spaces) so the gazetteer never double-links what
 * the wikilink sync already owns. Matching is case-insensitive, whitespace-
 * flexible, and anchored on UNICODE word boundaries; longest phrase wins; a
 * lowercase-in-prose match (common-word sense) is skipped.
 */
export function scanMentions(
  body: string,
  entries: GazetteerEntry[],
): string[] {
  if (typeof body !== "string" || body.length === 0 || entries.length === 0) {
    return [];
  }
  // NFKC so the body matches the NFKC-normalized phrases; blank code spans
  // (a name inside a fence is a sample, not a mention) then mask wikilink spans
  // — both replacements are offset-preserving so the positional scan stays valid.
  const text = stripCodeBlocks(body.slice(0, MAX_BODY_LEN).normalize("NFKC"));
  const masked = text.replace(WIKILINK_SPAN_RE, (m) => " ".repeat(m.length));
  // One alternation, longest-first (entries pre-sorted) so the engine prefers
  // the longest phrase at each start offset. Unicode-aware boundaries via
  // lookaround on letters/numbers/underscore — `\b` is ASCII-only and would
  // mis-anchor an accented name (José, Müller); the `u` flag + `\p{L}` fix that.
  const alternation = entries.map((e) => phraseToPattern(e.phrase)).join("|");
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  const phraseToSlug = new Map(entries.map((e) => [e.phrase, e.slug]));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of masked.matchAll(re)) {
    const surface = match[0]!;
    // Proper-noun heuristic: a real entity mention in prose is capitalized
    // (`Alice`, `Acme`). A match whose first letter is LOWERCASE is almost
    // always the common-word sense (`mark the date`, `apple pie`) — skip it.
    if (/^\p{Ll}/u.test(surface)) continue;
    // normalizeAlias collapses the matched whitespace back to the phrase key.
    const slug = phraseToSlug.get(normalizeAlias(surface));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/**
 * Replace the gazetteer-derived (`link_kind='plain'`) `mentions` edge set for
 * `sourceSlug` with the entities named in `body`. No-op unless
 * `MEMEX_GAZETTEER=1`. Runs in one transaction. NEVER clobbers an explicit
 * `mentions` edge: the delete is scoped to `link_kind='plain'` and the insert
 * is `ON CONFLICT DO NOTHING`, so an operator-asserted mention always wins.
 */
export async function syncMentionsForPage(
  storage: Storage,
  sourceSlug: string,
  body: string,
  sourceId?: string,
): Promise<{ added: number; removed: number }> {
  if (!gazetteerEnabled()) return { added: 0, removed: 0 };
  validateSlug(sourceSlug);
  // Tenant scope (mig047): stamp source_id on derived edges only when given,
  // else let the column DEFAULT 'default' apply (never pass NULL).
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;

  const entries = await buildGazetteer(
    storage,
    sourceSlug,
    scope !== null ? [scope] : undefined,
  );
  const targets = scanMentions(body, entries).filter((s) => s !== sourceSlug);

  const engine: Engine = storage.engine();
  // When scoped, the delete + insert confine to this source so a per-tenant
  // re-put never clears another tenant's mention edges. Unscoped (NULL) keeps
  // the original whole-source behavior.
  const delScope = scope !== null ? ` AND source_id = $2` : "";
  const insCol = scope !== null ? ", source_id" : "";
  const insVal = scope !== null ? ", $3" : "";
  return engine.transaction(async (tx) => {
    // Scope the delete to the gazetteer's OWN edges: type='mentions' with
    // link_kind='plain'. An explicit `link` mention carries link_kind NULL (or
    // typed_ner), so it is never deleted here. NOTE: an enrichment caller that
    // ever writes a 'mentions' edge with link_kind='plain' would make that edge
    // gazetteer-owned (re-swept each put) — keep 'plain' for the gazetteer only.
    const delParams: unknown[] = [sourceSlug];
    if (scope !== null) delParams.push(scope);
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE source_slug = $1 AND type = 'mentions' AND link_kind = 'plain'${delScope}
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      delParams,
    );
    let added = 0;
    for (const target of targets) {
      // DO NOTHING preserves an existing explicit mention (link_kind NULL) —
      // the gazetteer never overwrites an operator-asserted edge.
      const insParams: unknown[] = [sourceSlug, target];
      if (scope !== null) insParams.push(scope);
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence,
            link_kind, resolution_type, link_source${insCol})
         VALUES ($1, $2, 'mentions', 1.0, 'plain', 'qualified', 'mentions'${insVal})
         ON CONFLICT (source_slug, target_slug, type, source_id, link_source) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        insParams,
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}
