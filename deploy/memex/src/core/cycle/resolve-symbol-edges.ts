/**
 * resolve-symbol-edges phase — links unresolved code call edges to a defining
 * chunk WITHIN the same document, disambiguating same-named symbols.
 *
 * A `code_edges_symbol` row is written at index time with the callee name and
 * no resolved target. This phase, per document, matches each edge's callee
 * against the document's defining symbols (by bare `symbol_name` AND by
 * `symbol_name_qualified`, so a bare or a qualified callee both resolve),
 * excluding the calling chunk itself:
 *   * exactly 1 match → `edge_metadata.resolved_chunk_id`
 *   * 2+ matches      → `edge_metadata.ambiguous = true` + `candidates[]`
 *   * 0 matches       → left untouched (cross-file / external; reader resolves)
 * Incremental via the `chunks.edges_backfilled_at` watermark: a document is
 * processed once, then stamped, until a re-index clears the stamp on its chunks.
 */
import type { Engine } from "../engine/interface.ts";

export interface ResolveSymbolEdgesResult {
  documents: number;
  resolved: number;
  ambiguous: number;
  errors: string[];
}

export async function resolveSymbolEdgesPhase(
  engine: Engine,
  opts: { maxDocsPerRun?: number } = {},
): Promise<ResolveSymbolEdgesResult> {
  const docLimit = opts.maxDocsPerRun ?? 200;
  const result: ResolveSymbolEdgesResult = {
    documents: 0,
    resolved: 0,
    ambiguous: 0,
    errors: [],
  };

  const docs = await engine.query<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM chunks
      WHERE symbol_name_qualified IS NOT NULL AND edges_backfilled_at IS NULL
      LIMIT $1`,
    [docLimit],
  );

  for (const { document_id } of docs.rows) {
    result.documents++;
    try {
      // Defining symbols in this document: bare name AND qualified name →
      // chunk ids (a callee may be written either way).
      const syms = await engine.query<{
        id: string;
        symbol_name: string;
        symbol_name_qualified: string | null;
      }>(
        `SELECT id, symbol_name, symbol_name_qualified FROM chunks
          WHERE document_id = $1 AND symbol_name IS NOT NULL`,
        [document_id],
      );
      const byName = new Map<string, string[]>();
      const addKey = (key: string | null, id: string) => {
        if (!key) return;
        const arr = byName.get(key) ?? [];
        if (!arr.includes(id)) arr.push(id);
        byName.set(key, arr);
      };
      for (const s of syms.rows) {
        addKey(s.symbol_name, s.id);
        addKey(s.symbol_name_qualified, s.id);
      }

      // Unresolved edges originating from this document's chunks.
      const edges = await engine.query<{
        id: number;
        to_symbol_qualified: string;
        from_chunk_id: string;
      }>(
        `SELECT e.id, e.to_symbol_qualified, e.from_chunk_id
           FROM code_edges_symbol e
           JOIN chunks c ON c.id = e.from_chunk_id
          WHERE c.document_id = $1
            AND NOT (e.edge_metadata ? 'resolved_chunk_id')
            AND NOT (e.edge_metadata ? 'ambiguous')`,
        [document_id],
      );

      for (const edge of edges.rows) {
        // Exclude the calling chunk itself — never resolve an edge to its own
        // source (a same-named local / recursion would otherwise self-link).
        const candidates = (byName.get(edge.to_symbol_qualified) ?? []).filter(
          (cid) => cid !== edge.from_chunk_id,
        );
        if (candidates.length === 0) continue;
        if (candidates.length === 1) {
          await engine.query(
            `UPDATE code_edges_symbol
                SET edge_metadata = edge_metadata || $2::text::jsonb
              WHERE id = $1`,
            [edge.id, JSON.stringify({ resolved_chunk_id: candidates[0] })],
          );
          result.resolved++;
        } else {
          await engine.query(
            `UPDATE code_edges_symbol
                SET edge_metadata = edge_metadata || $2::text::jsonb
              WHERE id = $1`,
            [edge.id, JSON.stringify({ ambiguous: true, candidates })],
          );
          result.ambiguous++;
        }
      }

      // Stamp the whole document's code chunks so it isn't re-processed until a
      // re-index clears the watermark.
      await engine.query(
        `UPDATE chunks SET edges_backfilled_at = NOW()
          WHERE document_id = $1 AND symbol_name_qualified IS NOT NULL`,
        [document_id],
      );
    } catch (e) {
      result.errors.push(
        `${document_id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}
