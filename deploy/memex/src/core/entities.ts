/**
 * Entity extractor — deterministic regex-based recogniser for the three
 * entity types memex tracks today:
 *
 *   1. wikilink — `[[Name]]` or `[[Name|alias]]` references in markdown
 *      bodies. The canonical key is the target ("Name"), not the alias.
 *   2. tag — frontmatter `tags:` array OR inline `#hashtag` style tags.
 *   3. date — ISO `YYYY-MM-DD` substrings (calendar-day granularity).
 *
 * No LLM calls. The trade-off is precision: we catch obvious entities
 * cheaply and reproducibly, and miss anything that requires NER. A future
 * LLM-classifier can ride on top if the recall ceiling becomes a problem.
 */

export type EntityType =
  | "wikilink"
  | "tag"
  | "date"
  // Code call-graph types (migration 014). Extracted by core/code-entities.ts
  // from tree-sitter parses of TypeScript / Python source. Indexed via the
  // same entities + entity_mentions tables as the markdown types — graph
  // queries (`code-callers Foo`) are SQL on entity_mentions filtered by
  // entity_id, so adding new entity types is purely a schema-CHECK widening.
  | "code-def"
  | "code-ref"
  | "code-caller"
  | "code-callee";

export interface ExtractedEntity {
  type: EntityType;
  /** Canonical key — lowercased for tags, original-case otherwise. */
  name: string;
  /** What appeared in the source text (for context snippets later). */
  surfaceForm: string;
}

const WIKILINK_RE = /\[\[([^\]\|\n]+?)(\|[^\]]*?)?\]\]/g;
const HASHTAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)\b/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

function uniqByKey<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function extractWikilinks(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? "").trim();
    if (!target) continue;
    out.push({
      type: "wikilink",
      name: target,
      surfaceForm: m[0] ?? "",
    });
  }
  return uniqByKey(out, (e) => `${e.type}::${e.name}`);
}

export function extractHashtags(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    const tag = (m[1] ?? "").trim().toLowerCase();
    if (!tag) continue;
    out.push({ type: "tag", name: tag, surfaceForm: `#${tag}` });
  }
  return uniqByKey(out, (e) => `${e.type}::${e.name}`);
}

export function extractFrontmatterTags(
  fm: Record<string, unknown>,
): ExtractedEntity[] {
  const tagsField = fm["tags"];
  const out: ExtractedEntity[] = [];
  const push = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    out.push({ type: "tag", name: t, surfaceForm: raw });
  };
  if (Array.isArray(tagsField)) {
    for (const v of tagsField) {
      if (typeof v === "string") push(v);
    }
  } else if (typeof tagsField === "string") {
    // Some frontmatters store tags as a single comma-separated string.
    for (const piece of tagsField.split(",")) push(piece);
  }
  return uniqByKey(out, (e) => `${e.type}::${e.name}`);
}

export function extractDates(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const iso = m[1] ?? "";
    if (!isPlausibleDate(iso)) continue;
    out.push({ type: "date", name: iso, surfaceForm: iso });
  }
  return uniqByKey(out, (e) => `${e.type}::${e.name}`);
}

function isPlausibleDate(iso: string): boolean {
  // Accept 1900-01-01..2099-12-31. Cheap reject of obviously-bogus matches
  // like 0000-00-00 that show up in template files.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr ?? "");
  const mo = Number(moStr ?? "");
  const d = Number(dStr ?? "");
  if (y < 1900 || y > 2099) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  return true;
}

/**
 * Extract everything we recognise from a chunk's text + the document's
 * frontmatter. Frontmatter tags are added once at the document level; we
 * pass them in so the indexer can attach to the first chunk only.
 */
export function extractEntities(
  text: string,
  frontmatter: Record<string, unknown> = {},
): ExtractedEntity[] {
  const all = [
    ...extractWikilinks(text),
    ...extractHashtags(text),
    ...extractFrontmatterTags(frontmatter),
    ...extractDates(text),
  ];
  return uniqByKey(all, (e) => `${e.type}::${e.name}`);
}

export function entityId(type: EntityType, name: string): string {
  // Stable, short, easy to grep. Keep names in the id for readability — it's a
  // local single-user db so we don't need cryptographic guarantees.
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 60);
  return `ent_${type}_${safe || "x"}`;
}
