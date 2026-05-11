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
      const arr = (fm[lastListKey] as unknown[] | undefined) ?? [];
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
      lastListKey = key;
      fm[key] = [];
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
