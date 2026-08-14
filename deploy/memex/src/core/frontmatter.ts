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

    // Measured linear through parseFrontmatter: 0.29 ms on a 256 K frontmatter
    // line of spaces, ratio 2.0 on a doubling (0.10 ms for `- ` + a 256 K
    // space run). The trailing `(.*)$` cannot fail — `line` comes from a split
    // on `\r?\n`, so it holds no newline for `.` to stop at and `$` is always
    // reachable — which leaves no rejecting suffix for `\s+` to backtrack
    // against. A line that never reaches the `-` fails once per position.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
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

    // Measured linear through parseFrontmatter: 0.27 ms on a 256 K line of
    // `a-` with no colon, 0.10 ms on `k:` + a 256 K space run, ratio 2.0 on a
    // doubling. Same reason as the list pattern above: `(.*)$` on a
    // newline-free line always succeeds, so the `\s*` never has a failing
    // suffix to backtrack against.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const kv = trimmed.match(/^([\w-]+):\s*(.*)$/);
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
