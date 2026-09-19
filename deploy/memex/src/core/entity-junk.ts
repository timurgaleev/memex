/**
 * Junk entity names — the one gate every entity-creation path shares.
 *
 * Extractors and frontmatter hand us names like "team", "meeting", "unknown",
 * "the user", "N/A", "42" or "x". None of them names a real person or company,
 * but written through they mint an entity page (or resolve onto one someone
 * already created) and every later mention hangs another edge on it, until one
 * placeholder is the best-connected node in the graph and drags unrelated
 * pages together in traversal and relational recall.
 *
 * The gate is an EXACT-NAME check, not a substring one: "Team Rocket" and
 * "Acme Meeting Rooms" pass. Names that are real words but also real names
 * ("Mark", "Grace") are not junk here — whether prose may auto-link them is
 * the gazetteer's own call.
 */

/** Longer inputs are sentences, not placeholder names; bounding the input also
 *  bounds every scan below. */
const MAX_NAME_LEN = 120;

/** Normalized (lowercase, single-spaced) names that never identify an entity. */
const JUNK_NAMES: ReadonlySet<string> = new Set([
  // placeholders for "we don't know who"
  "unknown", "unnamed", "untitled", "anonymous", "anon", "someone", "somebody",
  "anyone", "anybody", "everyone", "everybody", "nobody", "no one", "none",
  "null", "nil", "undefined", "n/a", "na", "tbd", "tba", "todo", "other",
  "others", "misc", "various", "etc", "placeholder",
  // roles and pronouns standing in for a name
  "user", "users", "guest", "guests", "speaker", "participant", "participants",
  "attendee", "attendees", "member", "members", "customer", "customers",
  "client", "clients", "admin", "author", "owner", "me", "myself", "i", "you",
  "we", "us", "they", "them", "he", "she", "it", "self", "all",
  // generic nouns an extractor echoes back as the "entity"
  "team", "teams", "meeting", "meetings", "group", "person", "people",
  "company", "companies", "organization", "org", "project", "task", "event",
  "note", "page", "idea", "draft", "inbox", "test", "today",
]);

const LEADING_ARTICLE = /^(?:the|a|an) /;

/** Lowercase, strip markdown/quote decoration, fold `-`/`_` and whitespace
 *  runs to one space. */
function normalizeName(raw: string): string {
  return raw
    .slice(0, MAX_NAME_LEN)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[*`"'[\]]/g, "")
    .replace(/[-_\s]+/g, " ")
    .trim();
}

function isJunkKey(key: string): boolean {
  if (!key) return true;
  // Pure numbers, punctuation, "???", "---": nothing a name is made of.
  if (!/\p{L}/u.test(key)) return true;
  if ([...key.replace(/ /g, "")].length <= 1) return true;
  if (JUNK_NAMES.has(key)) return true;
  const bare = key.replace(LEADING_ARTICLE, "");
  return bare !== key && JUNK_NAMES.has(bare);
}

/**
 * True when `raw` (a display name or a slug) is a placeholder rather than an
 * entity. A slug is judged by its last segment too, so `people/unknown` is
 * junk while `people/unknown-mortal-orchestra` is not.
 */
export function isJunkEntityName(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return true;
  if (raw.length > MAX_NAME_LEN) return false;
  const key = normalizeName(raw);
  if (isJunkKey(key)) return true;
  const slash = key.lastIndexOf("/");
  // "n/a" is judged whole above; only a real path has a tail worth judging.
  if (slash > 0 && slash < key.length - 1) {
    return isJunkKey(key.slice(slash + 1).trim());
  }
  return false;
}
