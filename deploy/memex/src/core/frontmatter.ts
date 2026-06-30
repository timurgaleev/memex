/**
 * Lightweight YAML frontmatter parser — recognises `key: value` lines and
 * `key:` followed by `- item` lists, strips surrounding quotes. Anything
 * more complex (nested maps, multi-line scalars) falls back to raw strings.
 *
 * Lives in its own module because 's `frontmatter-inference` cycle
 * phase imports it without dragging in the chunker.
 */

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(md: string): ParsedFrontmatter {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) {
    return { frontmatter: {}, body: md };
  }
  const after = md.replace(/^---\r?\n/, "");
  const end = after.search(/\r?\n---\r?\n/);
  if (end < 0) {
    return { frontmatter: {}, body: md };
  }
  const fmRaw = after.slice(0, end);
  const body = after.slice(end).replace(/^\r?\n---\r?\n/, "");

  const fm: Record<string, unknown> = {};
  let lastListKey: string | null = null;
  for (const line of fmRaw.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;

    const listMatch = trimmed.match(/^\s*-\s+(.*)$/);
    if (listMatch && lastListKey !== null) {
      // The pending key was seeded with "" (empty scalar); the first list item
      // promotes it to an array. A re-entry keeps the existing array.
      const existing = fm[lastListKey];
      const arr = Array.isArray(existing) ? existing : [];
      arr.push(stripQuotes(listMatch[1] ?? ""));
      fm[lastListKey] = arr;
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      lastListKey = null;
      continue;
    }
    const key = kv[1] ?? "";
    const rawVal = (kv[2] ?? "").trim();
    if (rawVal === "") {
      // A bare `key:` is an empty scalar until a `- item` proves it a list.
      // Default to "" (not []) so `typeof fm[key] === "string"` readers of
      // blank date:/source:/title: see a string, not a mistyped array.
      lastListKey = key;
      fm[key] = "";
    } else {
      lastListKey = null;
      fm[key] = stripQuotes(rawVal);
    }
  }

  return { frontmatter: fm, body };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
