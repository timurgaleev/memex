/**
 * Code call-graph reads over `entity_mentions` — the engine-level core behind
 * the `code_callers` / `code_callees` MCP tools. Deterministic, no LLM.
 *
 * Mirrors the call-graph entity model from commands/code.ts: a symbol's
 * mentions are keyed by `entityId(<type>, <name>)`, where the type is
 * `code-caller` (who calls NAME) or `code-callee` (what the symbol at
 * file:line calls). `code_callees` is two-phase: resolve the innermost
 * code-def covering file:line, then look up that symbol's callees.
 *
 * ponytail: the SQL is duplicated from commands/code.ts rather than shared —
 * runCode is a console-printing CLI with its own exitCode side effects and a
 * dedicated test; lifting it would churn that tested surface for ~25 lines.
 * Unify if a third caller appears.
 */
import type { Engine } from "./engine/interface.ts";
import { entityId, type EntityType } from "./entities.ts";

export interface CodeMention {
  surface_form: string;
  chunk_id: string;
  document_id: string;
  source_path: string;
}

export interface CodeGraphResult {
  query: { type: EntityType; name: string };
  count: number;
  mentions: CodeMention[];
}

export interface CodeCalleesResult extends CodeGraphResult {
  /** The code-def symbol resolved at the requested file:line (null = none). */
  resolved_symbol: string | null;
}

/** "<path>:<line>" — line is the LAST numeric segment so a colon in the path
 *  (rare, Windows) doesn't poison the parse. */
export function parsePathLine(
  target: string,
): { file: string; line: number } | null {
  const lastColon = target.lastIndexOf(":");
  if (lastColon < 0) return null;
  const file = target.slice(0, lastColon);
  const lineStr = target.slice(lastColon + 1);
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 1) return null;
  if (file.length === 0) return null;
  return { file, line };
}

function clampLimit(limit: number | undefined): number {
  return typeof limit === "number" && limit >= 1 && limit <= 1000
    ? Math.floor(limit)
    : 200;
}

async function mentionsFor(
  engine: Engine,
  type: EntityType,
  name: string,
  limit: number,
): Promise<CodeGraphResult> {
  const eid = entityId(type, name);
  const r = await engine.query<CodeMention>(
    `SELECT em.surface_form, em.chunk_id, c.document_id, d.source_path
       FROM entity_mentions em
       JOIN chunks c ON c.id = em.chunk_id
       JOIN documents d ON d.id = c.document_id
      WHERE em.entity_id = $1
      ORDER BY d.source_path, c.start_line NULLS FIRST
      LIMIT $2`,
    [eid, limit],
  );
  return { query: { type, name }, count: r.rows.length, mentions: r.rows };
}

/** Who calls `name` — the `code-caller` mentions for a symbol. */
export async function codeCallers(
  engine: Engine,
  name: string,
  limit?: number,
): Promise<CodeGraphResult> {
  return mentionsFor(engine, "code-caller", name, clampLimit(limit));
}

/** Resolve the innermost-enclosing code-def symbol covering file:line. */
export async function resolveSymbolAt(
  engine: Engine,
  file: string,
  line: number,
): Promise<string | null> {
  const r = await engine.query<{ name: string }>(
    `SELECT e.name
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN entity_mentions em ON em.chunk_id = c.id
       JOIN entities e ON e.id = em.entity_id
      WHERE d.source_path = $1
        AND $2 BETWEEN c.start_line AND c.end_line
        AND e.type = 'code-def'
      ORDER BY (c.end_line - c.start_line) ASC
      LIMIT 1`,
    [file, line],
  );
  return r.rows[0]?.name ?? null;
}

/** What the symbol at `<path>:<line>` calls — the `code-callee` mentions. */
export async function codeCallees(
  engine: Engine,
  target: string,
  limit?: number,
): Promise<CodeCalleesResult> {
  const parsed = parsePathLine(target);
  if (!parsed) {
    throw new Error(
      `code_callees: invalid target '${target}' — expected '<path>:<line>'`,
    );
  }
  const sym = await resolveSymbolAt(engine, parsed.file, parsed.line);
  if (!sym) {
    return {
      query: { type: "code-callee", name: target },
      count: 0,
      mentions: [],
      resolved_symbol: null,
    };
  }
  const res = await mentionsFor(engine, "code-callee", sym, clampLimit(limit));
  return { ...res, resolved_symbol: sym };
}
