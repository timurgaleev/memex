/**
 * Entity-slug canonicalization — a deterministic, LLM-free resolver that
 * maps a loose `[[wikilink]]` mention to an EXISTING canonical page slug.
 *
 * Today the wikilink scanner (`syncWikilinksForPage`) slugifies a mention
 * and writes the edge to whatever slug falls out — so `[[Alice Smith]]`
 * mints a dangling `alice-smith` target even when the page actually lives
 * at `people/alice-smith`. This resolver closes that gap with a cascade
 * ordered by DESCENDING CONFIDENCE — structurally-exact matches first,
 * the fuzzy approximate match last and only when unambiguous:
 *
 *   1. exact       — the slugified mention IS an existing page slug.
 *   2. alias       — exactly one live page DECLARES the mention as an alias
 *                    (`compiled_truth.aliases`, migration 034). Authoritative
 *                    (`[[Robert]]` → `people/bob`); a collision falls through.
 *   3. exact-tail  — exactly one live page whose slug basename equals the
 *                    slugified mention (`[[Acme]]` → `companies/acme`).
 *   4. prefix      — exactly one live page whose basename STARTS WITH the
 *                    mention (`[[alice]]` → `people/alice-smith`).
 *   5. trgm fuzzy  — pg_trgm `similarity()` on title + slug basename, above
 *                    a threshold AND clear of the runner-up by a margin
 *                    (catches typos / title↔slug drift).
 *   6. slugify     — fall back to the legacy slugified target. Always
 *                    returns a slug so an edge is still created; the caller
 *                    stamps it `unqualified`.
 *
 * SAFE-BY-DEFAULT (security-engineer / ai-engineer review). The reference
 * resolver earned its safety from source-scoping + dir/page-type hints,
 * which memex's single flat vault does not have. To compensate for the
 * lost scoping this resolver:
 *   - runs the fuzzy stage LAST (a structurally-exact tail/prefix never
 *     loses to an approximate title match);
 *   - resolves tail/prefix ONLY when the match is UNIQUE — genuine
 *     ambiguity (two `acme` basenames, two `alice-...` prefixes) falls to the
 *     slugify floor rather than being silently arbitrated;
 *   - gates the fuzzy stage on both a conservative threshold (default
 *     0.7) AND a margin over the runner-up, so near-ties don't coin-flip;
 *   - deliberately does NOT use connection_count to break ties: it is a
 *     rich-get-richer bias (a new page always loses to an established
 *     same-prefix page) and arbitrating real ambiguity is the worst
 *     failure mode for graph integrity. A wrong `qualified` edge would
 *     also feed future resolutions, compounding the error.
 *
 * No GIN trigram index: stage 4 filters on an explicit `similarity() >= t`
 * threshold (not the `%` operator), so the function alone suffices at this
 * vault's scale. See migration 033 for the scale note.
 */
import type { Storage } from "./storage.ts";
import { slugifyTarget } from "./links.ts";
import { normalizeAlias, resolveAliasUnique } from "./page-aliases.ts";

/** Resolution outcome — `slug` is never null (stage 5 always yields one). */
export interface CanonicalizeResult {
  /** The resolved canonical slug, or the slugified fallback. */
  slug: string;
  /** True when a real existing page was matched (stages 1–5). */
  resolved: boolean;
  /** Which cascade stage produced the slug. */
  stage: "exact" | "alias" | "exact_tail" | "prefix" | "trgm" | "slugify";
}

export interface SlugResolver {
  /** Resolve one raw mention to a canonical (or fallback) slug. Cached. */
  resolve(name: string): Promise<CanonicalizeResult>;
}

const DEFAULT_TRGM_THRESHOLD = 0.7;
/**
 * Minimum gap between the best and second-best trigram score for the
 * fuzzy stage to commit. Near-ties (distinct entities with similar names)
 * fall through to slugify rather than being arbitrarily linked.
 */
const TRGM_MARGIN = 0.1;
/** Don't tail/prefix-match from a sliver — too ambiguous below this length. */
const MIN_TAIL_LEN = 2;

/**
 * Canonicalization is on by default (faithful to the reference). Set
 * `MEMEX_WIKILINK_CANONICALIZE=0` to fall straight through to the legacy
 * slugify behavior — a kill switch for a corpus where fuzzy resolution
 * would mis-link.
 */
export function canonicalizeEnabled(
  env: string | undefined = process.env.MEMEX_WIKILINK_CANONICALIZE,
): boolean {
  return env !== "0";
}

/**
 * Stage-4 trigram acceptance threshold. Override with
 * `MEMEX_WIKILINK_TRGM` (a float in [0, 1]); a malformed value throws so a
 * typo fails loud rather than silently reverting to the default.
 */
export function resolveTrgmThreshold(
  env: string | undefined = process.env.MEMEX_WIKILINK_TRGM,
): number {
  const v = env?.trim();
  if (v === undefined || v === "") return DEFAULT_TRGM_THRESHOLD;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(
      `MEMEX_WIKILINK_TRGM must be a float in [0, 1] (got ${JSON.stringify(v)})`,
    );
  }
  return n;
}

async function pageExists(storage: Storage, slug: string): Promise<boolean> {
  const r = await storage.engine().query<{ one: number }>(
    `SELECT 1 AS one FROM pages WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
    [slug],
  );
  return r.rows.length > 0;
}

/**
 * Stage 2 — UNIQUE NAMESPACED live page whose slug basename equals the
 * slugified mention (`[[Acme]]` → `companies/acme`). Two candidates
 * (`acme` in two namespaces) is real ambiguity: return null so the caller
 * falls through. Restricted to namespaced slugs (`a/b`) — a top-level
 * page matching exactly is already stage 1's job. Skips namespaced
 * mentions (already qualified) and slivers.
 */
async function exactTailUnique(
  storage: Storage,
  slugified: string,
  sourceSlug: string,
): Promise<string | null> {
  if (slugified.length < MIN_TAIL_LEN || slugified.includes("/")) return null;
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT p.slug AS slug
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.slug <> $2
        AND p.slug LIKE '%/%'
        AND regexp_replace(p.slug, '^.*/', '') = $1
      LIMIT 2`,
    [slugified, sourceSlug],
  );
  return r.rows.length === 1 ? r.rows[0]!.slug : null;
}

/**
 * Stage 3 — UNIQUE NAMESPACED live page whose basename STARTS WITH the
 * mention (a strict expansion: `alice` → `people/alice-smith`). Excludes
 * exact-tail matches (stage 2 owns those) so a vault with both `acme` and
 * `acme-corp` doesn't double-count. Restricted to namespaced slugs so a
 * bare mention can't sprawl onto an unrelated top-level page. Ambiguous
 * (>1 expansion) falls through.
 */
async function prefixExpansionUnique(
  storage: Storage,
  slugified: string,
  sourceSlug: string,
): Promise<string | null> {
  // slugifyTarget only emits [a-z0-9/-]; none are LIKE metacharacters, so
  // `slugified || '%'` needs no escaping.
  if (slugified.length < MIN_TAIL_LEN || slugified.includes("/")) return null;
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT p.slug AS slug
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.slug <> $2
        AND p.slug LIKE '%/%'
        AND regexp_replace(p.slug, '^.*/', '') LIKE $1 || '%'
        AND regexp_replace(p.slug, '^.*/', '') <> $1
      LIMIT 2`,
    [slugified, sourceSlug],
  );
  return r.rows.length === 1 ? r.rows[0]!.slug : null;
}

/**
 * Stage 4 — fuzzy trigram match on title + slug basename. Commits only
 * when the best score clears `threshold` AND beats the runner-up by
 * `TRGM_MARGIN` (or is the sole candidate). Otherwise null.
 */
async function trgmUnambiguous(
  storage: Storage,
  name: string,
  slugified: string,
  sourceSlug: string,
  threshold: number,
): Promise<string | null> {
  const r = await storage.engine().query<{ slug: string; sim: number }>(
    `SELECT p.slug AS slug,
            GREATEST(
              similarity(lower(COALESCE(p.title, '')), lower($1)),
              similarity(regexp_replace(p.slug, '^.*/', ''), $2)
            ) AS sim
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND p.slug <> $3
      ORDER BY sim DESC, p.slug ASC
      LIMIT 2`,
    [name, slugified, sourceSlug],
  );
  const top = r.rows[0];
  if (!top || Number(top.sim) < threshold) return null;
  const second = r.rows[1];
  if (second && Number(top.sim) - Number(second.sim) < TRGM_MARGIN) {
    return null; // near-tie → ambiguous, fall through
  }
  return top.slug;
}

/**
 * Build a resolver for one wikilink-sync pass. The per-instance cache means
 * a mention repeated across a body costs one DB round-trip total. Excludes
 * `sourceSlug` from every candidate set so a page never canonicalizes a
 * mention onto itself via similarity.
 */
export function makeSlugResolver(
  storage: Storage,
  sourceSlug: string,
): SlugResolver {
  const cache = new Map<string, CanonicalizeResult>();
  const enabled = canonicalizeEnabled();
  const threshold = resolveTrgmThreshold();

  return {
    async resolve(name: string): Promise<CanonicalizeResult> {
      const trimmed = typeof name === "string" ? name.trim() : "";
      const fallbackSlug = slugifyTarget(trimmed);
      const cached = cache.get(trimmed);
      if (cached) return cached;

      const finish = (r: CanonicalizeResult): CanonicalizeResult => {
        cache.set(trimmed, r);
        return r;
      };
      const fallback = (): CanonicalizeResult =>
        finish({ slug: fallbackSlug, resolved: false, stage: "slugify" });

      // Unresolvable mention (empty / all-stripped) or canonicalization off:
      // hand back the legacy slugified target untouched.
      if (!enabled || fallbackSlug === "unknown") return fallback();

      // Stage 1 — exact: the slugified mention is itself a live page.
      // Skip a self-match so the resolver never reports a qualified
      // self-resolution (its contract excludes sourceSlug from every set).
      if (fallbackSlug !== sourceSlug && (await pageExists(storage, fallbackSlug))) {
        return finish({ slug: fallbackSlug, resolved: true, stage: "exact" });
      }

      // Stage 2 — declared alias (authoritative): a page that names this
      // mention in `compiled_truth.aliases`. Unique match only — a
      // collision falls through.
      const alias = await resolveAliasUnique(
        storage,
        normalizeAlias(trimmed),
        sourceSlug,
      );
      if (alias) return finish({ slug: alias, resolved: true, stage: "alias" });

      // Stage 3 — unique exact-tail match.
      const tail = await exactTailUnique(storage, fallbackSlug, sourceSlug);
      if (tail) return finish({ slug: tail, resolved: true, stage: "exact_tail" });

      // Stage 4 — unique prefix expansion.
      const prefix = await prefixExpansionUnique(storage, fallbackSlug, sourceSlug);
      if (prefix) return finish({ slug: prefix, resolved: true, stage: "prefix" });

      // Stage 5 — fuzzy trigram, threshold + margin gated.
      const fuzzy = await trgmUnambiguous(
        storage,
        trimmed,
        fallbackSlug,
        sourceSlug,
        threshold,
      );
      if (fuzzy) return finish({ slug: fuzzy, resolved: true, stage: "trgm" });

      // Stage 6 — slugify fallback (legacy behavior; edge still created).
      return fallback();
    },
  };
}
