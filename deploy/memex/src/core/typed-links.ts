/**
 * Typed-link inference -- derive TYPED relationship edges (`works_at`,
 * `founded`, `attended`, ...) from an entity page's `compiled_truth` frontmatter
 * fields, beyond the generic `wikilink` / `mentions` edges.
 *
 * This is the deterministic, LLM-free "schema-pack": a fixed table maps a
 * (page-type, field) pair to a relation type + direction. E.g. a person page's
 * `company: [Acme]` becomes a `works_at` edge person->company; a meeting page's
 * `attendees: [Alice, Bob]` becomes `attended` edges Alice->meeting, Bob->meeting.
 * Names are resolved to canonical slugs via the slug resolver (#1), so a field
 * value may be a slug or a display name.
 *
 * Faithful adaptation of the reference's FRONTMATTER_FIELD_MAPPINGS. Two
 * deliberate divergences for safety on memex's flat vault:
 *   - DEFAULT OFF (`MEMEX_TYPED_LINKS=1` to enable) -- a wrong inferred relation
 *     silently pollutes the graph, same posture as the gazetteer.
 *   - RESOLVED-ONLY -- an edge is written only when the value resolves to a real
 *     existing page (high precision); an unresolved value is skipped rather
 *     than creating an edge to a slugified guess.
 *
 * Edges are stamped `link_kind='typed_ner'` + `origin_slug=<the page whose
 * frontmatter declared them>`. On re-put the page's prior typed_ner edges are
 * deleted (scoped by `origin_slug`) and re-derived -- so editing the frontmatter
 * is the single source of truth. Insertion is `ON CONFLICT (source, target,
 * type) DO NOTHING`, so an explicit operator-asserted edge of the same
 * (source, target, type) wins on insert -- typed-NER inference only fills gaps.
 *
 * SINGLE-ORIGIN INVARIANT (required by the single-row model): the FIELD_MAPPINGS
 * are chosen so NO (source, target, type) triple can be declared by two
 * different pages' frontmatter -- e.g. `works_at` is derived only from the
 * person side (`person.company`), never the company side. Were two pages able
 * to declare the same triple, the `origin_slug`-scoped cleanup of one would
 * drop an edge the other still declares (only one origin can own a single row).
 *
 * KNOWN LIMITATIONS (deferred to the `link_kind` UNIQUE-coexistence migration,
 * #145 -- until typed_ner edges can be SEPARATE rows from plain/explicit ones):
 *   - An explicit `link` asserted ON TOP of an already-inferred triple does not
 *     transfer row ownership away from typed_ner, so a later frontmatter
 *     retraction (removing the field) cleans up that row. This is narrow (the
 *     operator both inferred-and-explicitly-asserted, then retracted the
 *     frontmatter) and arguably correct (frontmatter is the declared truth).
 *   - Enabling the flag (or making a previously-unresolved target resolvable)
 *     backfills only on the NEXT change-bearing put of the declaring page -- a
 *     no-op re-put does not re-derive. Re-index / re-put to backfill, same as
 *     the gazetteer.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { validateSlug } from "./links.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";

type Direction = "outgoing" | "incoming";
interface FieldRule {
  /** Relation type written to links.type (a KNOWN_LINK_TYPE). */
  type: string;
  /** outgoing: page->value. incoming: value->page. */
  direction: Direction;
}

/**
 * (page type) -> (compiled_truth FIELD name) -> relation rule. The KEY is the
 * frontmatter field name the author writes (matched case-insensitively), NOT
 * the relation. Some fields share their name with the relation they imply
 * (`founded: [...]`, `advises: [...]`) -- that's intentional, not a typo; the
 * `company`/`companies` field is the one whose name differs from its relation
 * (`works_at`). Conservative high-precision set -- only unambiguous relations;
 * prose-window NER (regex pack) is a deferred follow-on.
 */
const FIELD_MAPPINGS: Record<string, Record<string, FieldRule>> = {
  person: {
    company: { type: "works_at", direction: "outgoing" },
    companies: { type: "works_at", direction: "outgoing" },
    founded: { type: "founded", direction: "outgoing" },
    advises: { type: "advises", direction: "outgoing" },
    invested_in: { type: "invested_in", direction: "outgoing" },
    knows: { type: "knows", direction: "outgoing" },
  },
  // NB: a company's `key_people`/`team` is DELIBERATELY not mapped -- it would
  // re-derive the same `works_at` triple the person side already owns, and two
  // origins for one row breaks the origin-scoped cleanup (single-origin
  // invariant above). It belongs with the #145 link_kind-coexistence work.
  meeting: {
    attendees: { type: "attended", direction: "incoming" },
    attended_by: { type: "attended", direction: "incoming" },
    location: { type: "located_at", direction: "outgoing" },
  },
};

/**
 * Resolver stages precise enough to stamp a FACTUAL typed relation. Excludes
 * `trgm` (fuzzy near-name) and `slugify` (floor guess) -- both fine for a
 * generic wikilink target but a precision hazard for a typed edge.
 */
const PRECISE_STAGES: ReadonlySet<string> = new Set([
  "exact",
  "alias",
  "exact_tail",
  "prefix",
]);

/** Confidence stamped on an inferred edge (below an explicit 1.0). */
const INFERRED_CONFIDENCE = 0.8;
/** Hard cap on inferred edges per page (defence vs a pathological field list). */
const MAX_EDGES = 500;
/** Hard cap on resolver calls per page -- bounds work even when most values are
 *  unresolved (unresolved values don't count toward MAX_EDGES). */
const MAX_RESOLVE_ATTEMPTS = 1000;

const FENCE_WRITER_KIND = "typed_ner";

/**
 * Typed-link inference is OPT-IN: `MEMEX_TYPED_LINKS=1` enables it. Default OFF
 * -- a wrong inferred relation pollutes the graph, so the operator turns it on
 * only after confirming it behaves on their vault.
 */
export function typedLinksEnabled(
  env: string | undefined = process.env.MEMEX_TYPED_LINKS,
): boolean {
  return env === "1";
}

/** Normalize a compiled_truth field value to a list of non-empty strings. */
function fieldValues(raw: unknown): string[] {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t ? [t] : [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  }
  return [];
}

interface InferredEdge {
  source: string;
  target: string;
  type: string;
  field: string;
}

/**
 * Replace the typed_ner edge set this page's frontmatter declares. No-op unless
 * `MEMEX_TYPED_LINKS=1`. Runs the delete + re-insert in one transaction.
 */
export async function syncTypedLinksForPage(
  storage: Storage,
  pageSlug: string,
  pageType: string,
  compiledTruth: Record<string, unknown> | null | undefined,
): Promise<{ added: number; removed: number }> {
  if (!typedLinksEnabled()) return { added: 0, removed: 0 };
  validateSlug(pageSlug);

  const edges = await collectEdges(storage, pageSlug, pageType, compiledTruth);

  const engine: Engine = storage.engine();
  return engine.transaction(async (tx) => {
    // Scope the wipe to THIS page's frontmatter-owned typed_ner edges. Edges
    // may have source_slug != pageSlug (incoming direction), so origin_slug --
    // the declaring page -- is the ownership key, not source_slug. Wikilink /
    // gazetteer edges have NULL origin_slug, so they are never touched.
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM links
          WHERE origin_slug = $1 AND link_kind = '${FENCE_WRITER_KIND}'
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      [pageSlug],
    );
    let added = 0;
    for (const e of edges) {
      // DO NOTHING: an existing edge of this (source, target, type) -- explicit
      // or plain -- always wins; typed-NER inference only fills gaps.
      // `context` left as the DB default (''): the declaring field is already
      // recorded in `origin_field`, so duplicating it into `context` would
      // pollute any context-display path. `link_kind` is a hardcoded const
      // (no user value reaches the interpolation).
      const ins = await tx.query<{ inserted: boolean }>(
        `INSERT INTO links
           (source_slug, target_slug, type, inferred_confidence,
            link_kind, origin_slug, origin_field, resolution_type)
         VALUES ($1, $2, $3, $4, '${FENCE_WRITER_KIND}', $5, $6, 'qualified')
         ON CONFLICT (source_slug, target_slug, type) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        [e.source, e.target, e.type, INFERRED_CONFIDENCE, pageSlug, e.field],
      );
      if (ins.rows[0]?.inserted) added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added };
  });
}

/**
 * Resolve the page's mapped frontmatter fields into a deduped edge list.
 * RESOLVED-ONLY: a value that doesn't match a real page is skipped. Self-edges
 * are dropped.
 */
async function collectEdges(
  storage: Storage,
  pageSlug: string,
  pageType: string,
  compiledTruth: Record<string, unknown> | null | undefined,
): Promise<InferredEdge[]> {
  const rules = FIELD_MAPPINGS[pageType];
  if (!rules || !compiledTruth || typeof compiledTruth !== "object") return [];

  // Lower-case field index of the page's compiled_truth for case-insensitive
  // field matching.
  const fieldIndex = new Map<string, unknown>();
  for (const [k, v] of Object.entries(compiledTruth)) {
    fieldIndex.set(k.toLowerCase(), v);
  }

  const resolver = makeSlugResolver(storage, pageSlug);
  const seen = new Set<string>();
  const edges: InferredEdge[] = [];
  let attempts = 0;

  for (const [field, rule] of Object.entries(rules)) {
    const raw = fieldIndex.get(field);
    if (raw === undefined) continue;
    for (const value of fieldValues(raw)) {
      if (++attempts > MAX_RESOLVE_ATTEMPTS) return edges;
      const res = await resolver.resolve(value);
      // RESOLVED-ONLY + EXACT-ish: accept only the deterministic, high-precision
      // stages. The `trgm` fuzzy stage is fine for a generic wikilink target but
      // too loose for stamping a FACTUAL typed relation -- `company: [Acme]`
      // must not fuzzy-match `acme-consulting` and mint a wrong `works_at`. The
      // slugify floor (resolved=false) is already excluded.
      if (!res.resolved || !PRECISE_STAGES.has(res.stage)) continue;
      const other = res.slug;
      if (other === pageSlug) continue; // no self-edge
      const source = rule.direction === "outgoing" ? pageSlug : other;
      const target = rule.direction === "outgoing" ? other : pageSlug;
      const key = `${source}|${target}|${rule.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source, target, type: rule.type, field });
      if (edges.length >= MAX_EDGES) return edges;
    }
  }
  return edges;
}
