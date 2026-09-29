/**
 * Helpers shared by the session-log adapters (Codex CLI rollouts, Claude Code
 * sessions): both write one JSON record per line and one file per session.
 */

export interface JsonlRecords {
  records: unknown[];
  /** Lines that were not valid JSON (a torn last line, a hand edit). */
  malformed: number;
}

/** Parse every non-blank line; a malformed line is counted, never fatal. */
export function parseJsonlRecords(raw: string): JsonlRecords {
  const records: unknown[] = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

const TITLE_FROM_TEXT_MAX = 80;

/**
 * Session logs carry no title of their own; the opening line of the first
 * user message names the session better than a generic placeholder does.
 */
export function titleFromText(text: string | undefined): string | null {
  const first = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return null;
  const chars = [...first];
  return chars.length > TITLE_FROM_TEXT_MAX ? `${chars.slice(0, TITLE_FROM_TEXT_MAX).join("").trimEnd()}…` : first;
}
