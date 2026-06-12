/**
 * Parser / renderer for the `## Facts` markdown fence.
 *
 * A `## Facts` fence on an entity's page is the system-of-record for facts
 * about that entity; the `entity_facts` DB table (migration 018) is a derived
 * index a future `extract_facts` cycle phase reconciles from it. This module is
 * the pure markdown <-> structured-rows boundary — no DB, no LLM, no I/O — so
 * it can run in the chunker strip path and in a CI invariant check without
 * pulling a DB-shaped dependency graph.
 *
 * INERT until `extract_facts` lands: nothing writes/reads these rows to the DB
 * yet. Shipped now as the stable format so facts stop being DB-only and
 * reset-fragile (the markdown becomes the source-of-truth).
 *
 * Adapted from the reference's `facts-fence.ts`. The reference carries a 10–14
 * column schema (kind / visibility / notability / valid_from / typed-claims)
 * tied to its richer fact model; memex's `entity_facts` is simpler
 * (claim / confidence / source), so the fence is the 4-column projection of
 * that table. The generic row primitives are shared via `fence-shared.ts`
 * (faithful port); only the column layout is memex-specific. Markers are
 * memex-namespaced.
 *
 *   ## Facts
 *
 *   <!--- memex:facts:begin -->
 *   | # | claim | confidence | source |
 *   |---|-------|------------|--------|
 *   | 1 | Founded Acme in 2017  | 1   | linkedin     |
 *   | 2 | ~~Moved to Berlin~~   | 0.9 | email/x9f2   |
 *   <!--- memex:facts:end -->
 *
 * A `~~struck~~` claim marks the fact inactive (retracted / forgotten) — the
 * markdown stays the record, and `extract_facts` will drop/expire it in the DB.
 */

import {
  parseRowCells,
  isSeparatorRow,
  stripStrikethrough,
  parseStringCell,
  escapeFenceCell,
} from "./fence-shared.ts";

export const FACTS_FENCE_BEGIN = "<!--- memex:facts:begin -->";
export const FACTS_FENCE_END = "<!--- memex:facts:end -->";

/** One parsed fence row. Mirrors the `entity_facts` projection. */
export interface ParsedFact {
  /** Append-only row number from the `#` column (1-based; sequential fallback). */
  rowNum: number;
  /** Fact text; strikethrough markers stripped on parse. */
  claim: string;
  /** Evidence strength, clamped to 0..1 (default 1.0 on empty/invalid). */
  confidence: number;
  /** Provenance slug, or undefined. */
  source?: string;
  /** False when the claim was wrapped in `~~ ~~` (retracted / forgotten). */
  active: boolean;
}

function clampConfidence(raw: string | undefined): number {
  if (raw === undefined) return 1.0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Parse the `## Facts` fence out of a markdown body. Returns the rows in
 * source order. A missing or malformed fence yields `[]` (never throws — the
 * markdown is hand-editable and must degrade gracefully).
 */
export function parseFactsFence(markdown: string): ParsedFact[] {
  if (!markdown.includes(FACTS_FENCE_BEGIN)) return [];
  const lines = markdown.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === FACTS_FENCE_BEGIN);
  const end = lines.findIndex((l) => l.trim() === FACTS_FENCE_END);
  if (begin === -1 || end === -1 || end <= begin) return [];

  const out: ParsedFact[] = [];
  let seq = 0;
  for (let i = begin + 1; i < end; i++) {
    const cells = parseRowCells(lines[i] ?? "");
    if (!cells || isSeparatorRow(cells)) continue;
    // Skip the header row (`| # | claim | confidence | source |`).
    if ((cells[1] ?? "").toLowerCase() === "claim") continue;
    if (cells.length < 2) continue;

    const { text: claim, struck } = stripStrikethrough(cells[1] ?? "");
    if (!claim.trim()) continue; // a row with no claim is not a fact

    seq += 1;
    const rowNumRaw = Number.parseInt((cells[0] ?? "").trim(), 10);
    out.push({
      rowNum: Number.isInteger(rowNumRaw) && rowNumRaw > 0 ? rowNumRaw : seq,
      claim: claim.trim(),
      confidence: clampConfidence(cells[2]),
      source: parseStringCell(cells[3] ?? ""),
      active: !struck,
    });
  }
  return out;
}

/** Render facts into the fenced markdown block (markers + table). */
export function renderFactsFence(facts: readonly ParsedFact[]): string {
  const header = "| # | claim | confidence | source |";
  const sep = "|---|-------|------------|--------|";
  const rows = facts.map((f, idx) => {
    const claimCell = escapeFenceCell(f.claim);
    const claim = f.active ? claimCell : `~~${claimCell}~~`;
    const n = Number.isInteger(f.rowNum) && f.rowNum > 0 ? f.rowNum : idx + 1;
    const conf = clampConfidence(String(f.confidence));
    return `| ${n} | ${claim} | ${conf} | ${escapeFenceCell(f.source ?? "")} |`;
  });
  return [FACTS_FENCE_BEGIN, header, sep, ...rows, FACTS_FENCE_END].join("\n");
}

/**
 * Remove the `## Facts` fence block (markers + table, and the immediately
 * preceding `## Facts` heading if present) from a markdown body — so the
 * fenced table is not re-indexed as ordinary body text by the chunker. Leaves
 * the rest of the document untouched; a body with no fence is returned as-is.
 */
export function stripFactsFence(markdown: string): string {
  if (!markdown.includes(FACTS_FENCE_BEGIN)) return markdown;
  const lines = markdown.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === FACTS_FENCE_BEGIN);
  const end = lines.findIndex((l) => l.trim() === FACTS_FENCE_END);
  if (begin === -1 || end === -1 || end <= begin) return markdown;

  // Also drop a `## Facts` heading directly above the fence (and one blank
  // line between them), so stripping doesn't leave a dangling header.
  let from = begin;
  let probe = begin - 1;
  while (probe >= 0 && (lines[probe] ?? "").trim() === "") probe--;
  if (probe >= 0 && /^#{1,6}\s+facts\s*$/i.test((lines[probe] ?? "").trim())) {
    from = probe;
  }
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  return kept.join("\n");
}
