/**
 * Shared primitives for HTML-comment-delimited markdown fences.
 *
 * A "fence" is a pipe-separated markdown table wrapped in begin/end HTML
 * comments, embedded in a page's markdown body. The page is the
 * system-of-record; a cycle phase reconciles a derived DB table from it. These
 * helpers are the row-level shape (cells, the header separator, strikethrough
 * for inactive rows, escape-on-write for embedded pipes) shared by every
 * fence; the domain-specific column parsing lives in each fence's own module
 * (today: `facts-fence.ts`).
 *
 * These primitives are model-agnostic — pure row-shape parsing, no domain
 * coupling.
 */

/**
 * Split a markdown table row into its trimmed cells (outer pipes stripped).
 * Returns `null` when the line is not a table row (no leading `|`, or no
 * second `|`).
 *
 * Splits on UNESCAPED pipes only and unescapes `\|` → `|`, so it is the exact
 * inverse of `escapeFenceCell`: a cell whose text contains a literal `|`
 * survives the round-trip intact instead of fracturing the row. (Making the
 * read/write pair symmetric is a small correctness improvement — escaping on
 * write is otherwise pointless if the read splits on the escaped pipe anyway.)
 */
export function parseRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.includes("|", 1)) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  // Character scan (not a lookbehind regex) so the unescape is a true inverse
  // of escapeFenceCell for ALL inputs — including a literal trailing backslash,
  // where `\\|` (escaped-backslash + boundary) must split but `\|` (escaped
  // pipe) must not. A lookbehind can't tell those apart; the scanner can,
  // because it consumes the backslash-escape and resumes cleanly.
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === "|" || next === "\\") {
        cur += next; // unescape \| → | and \\ → \
        i++;
        continue;
      }
    }
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Markdown table separator detector — a row like `|---|---|` (colons allowed
 * for alignment). Used to skip the header separator when iterating rows.
 */
export function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^[-:\s]+$/.test(c));
}

/**
 * Detect strikethrough wrapping on a cell.
 *   `~~text~~` → `{ text: 'text', struck: true }`
 *   `text`     → `{ text: 'text', struck: false }`
 * Both fences use it to mark a row inactive (retracted / forgotten).
 */
export function stripStrikethrough(s: string): { text: string; struck: boolean } {
  const m = s.match(/^~~(.+?)~~$/);
  if (m && m[1] !== undefined) return { text: m[1].trim(), struck: true };
  return { text: s, struck: false };
}

/**
 * Trim a cell and collapse empty / whitespace-only to `undefined` — the shape
 * callers want for optional string fields.
 */
export function parseStringCell(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/**
 * Escape a value for safe placement in a pipe-separated cell: any literal `|`
 * becomes `\|` so the table layout survives. Also flattens newlines (a cell is
 * single-line) so a multi-line claim can't break the row.
 */
export function escapeFenceCell(s: string): string {
  // Order matters: escape the backslash FIRST, then the pipe, so the inverse
  // (parseRowCells) can unambiguously unescape. Newlines are flattened — a
  // cell is single-line.
  return s
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

export type FenceKind = "facts" | "takes";
export type FenceBrand = "memrain" | "memex";

/** Every marker brand a fence may carry. `memex:` fences written by earlier
 *  releases stay valid forever — a page's existing marker is never rewritten. */
export const FENCE_BRANDS: readonly FenceBrand[] = ["memrain", "memex"];

/** The begin/end HTML-comment markers of one fence kind under one brand. */
export function fenceMarkers(kind: FenceKind, brand: FenceBrand): { begin: string; end: string } {
  return { begin: `<!--- ${brand}:${kind}:begin -->`, end: `<!--- ${brand}:${kind}:end -->` };
}

/**
 * Pick the brand of a body's `kind` fence by testing for each brand's begin
 * marker. Returns that brand's markers, `{ brand: "both" }` when begin markers
 * of both brands are present (callers refuse to project or rewrite such a
 * page — an asymmetric match there could wipe derived rows), or `null` when no
 * begin marker is present. Each call site keeps its own matching rule (line
 * trim equality or `indexOf`) with the returned markers.
 */
export function fenceBounds(
  body: string,
  kind: FenceKind,
): { brand: FenceBrand; begin: string; end: string } | { brand: "both" } | null {
  const present = FENCE_BRANDS.filter((b) => body.includes(fenceMarkers(kind, b).begin));
  const brand = present[0];
  if (brand === undefined) return null;
  if (present.length > 1) return { brand: "both" };
  return { brand, ...fenceMarkers(kind, brand) };
}

/** True when the body carries a `kind` begin marker of any brand. */
export function hasFenceMarker(body: string, kind: FenceKind): boolean {
  return fenceBounds(body, kind) !== null;
}
