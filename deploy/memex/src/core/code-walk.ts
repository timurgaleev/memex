/**
 * Recursive code call-graph walks over `code_edges_symbol` (migration 041) —
 * the engine core behind the `code_blast` (transitive callers / blast radius)
 * and `code_flow` (transitive callees / execution flow) MCP tools.
 * Deterministic, no LLM.
 *
 * Single-hop reads (`code_callers`/`code_callees`) live in code-graph.ts over
 * `entity_mentions`; this module walks the chunk-anchored, qualified-name edge
 * table so a multi-hop traversal resolves a SPECIFIC caller symbol per hop
 * rather than aliasing same-named methods. BFS bounded by depth + max_nodes
 * caps with cycle detection via a visited-set.
 *
 * ponytail: no language gate — memex `chunks` carry no `language` column, so
 * the sink classifier matches on the bare callee name with a combined
 * TS+Python pattern set. Add a per-language gate if a language column lands.
 */
import type { Engine } from "./engine/interface.ts";

export type WalkDirection = "callers" | "callees";

export type SinkKind =
  | "db_call"
  | "http_call"
  | "file_io"
  | "process_exec"
  | "unknown";

export interface WalkNode {
  symbol: string;
  /**
   * Origin chunk of the edge — direction-dependent:
   *   callers: the caller's own chunk (navigable to the calling symbol).
   *   callees: the CALL-SITE chunk in the parent symbol, NOT the callee's
   *     definition chunk (the edge table has no resolved to_chunk_id), so
   *     callees at one depth share their parent's chunk_id. Use `code_def`
   *     to locate a callee's definition.
   */
  chunk_id?: string;
  sink_kind?: SinkKind;
}

export interface DepthGroup {
  depth: number;
  nodes: WalkNode[];
  /** confidence = 1 / (1 + 0.3 * depth), clamped to [0.05, 1.0] */
  confidence: number;
}

export type WalkResult =
  | {
      result: "ok";
      depth_groups: DepthGroup[];
      cycles_detected: boolean;
      truncation: "none" | "max_nodes" | "depth_cap" | "both";
      terminal_nodes?: { symbol: string; sink_kind: SinkKind }[];
    }
  | { result: "not_found"; did_you_mean: { symbol_qualified: string }[] }
  | { result: "ambiguous"; candidates: { symbol_qualified: string }[] };

export interface WalkOpts {
  direction: WalkDirection;
  /** Hop cap. Default 5 (callers), 8 (callees). */
  depth?: number;
  /** Total-node cap. Default 200. */
  maxNodes?: number;
  /** Optional tenant scope — fail-closed against `code_edges_symbol.source_id`. */
  sourceIds?: string[];
  /** Skip bare-name disambiguation; treat `symbol` as an exact qualified name. */
  exact?: boolean;
}

// --- sink classification (combined TS + Python; glob `*` → `.*`) ---

// Patterns match the bare last segment of a qualified name. Memex code symbols
// are qualified with `::` (and occasionally `.`); the classifier looks at the
// final segment, so a plain verb covers `db.query`, `Repo::save`, `cursor.exec`.
const SINK_PATTERNS: Record<Exclude<SinkKind, "unknown">, string[]> = {
  db_call: [
    "query", "execute", "transaction", "insert", "update",
    "delete", "select", "findOne", "findMany", "save", "commit",
  ],
  http_call: [
    "fetch", "axios", "request", "get", "post", "put", "patch", "urlopen",
  ],
  file_io: [
    "readFile", "readFileSync", "writeFile", "writeFileSync",
    "createReadStream", "createWriteStream", "open", "read", "write",
  ],
  process_exec: [
    "spawn", "spawnSync", "exec", "execSync", "execFile", "system",
  ],
};

/** Bare last segment of a qualified symbol — split on `::` then `.`. */
function lastSegment(callee: string): string {
  const afterColons = callee.includes("::")
    ? (callee.split("::").pop() ?? callee)
    : callee;
  return afterColons.includes(".")
    ? (afterColons.split(".").pop() ?? afterColons)
    : afterColons;
}

/** Classify a callee qualified name to a sink kind (or 'unknown'). */
export function classifySink(callee: string): SinkKind {
  const bare = lastSegment(callee);
  for (const kind of [
    "db_call",
    "http_call",
    "file_io",
    "process_exec",
  ] as const) {
    if (SINK_PATTERNS[kind].includes(bare)) return kind;
  }
  return "unknown";
}

function clampConfidence(depth: number): number {
  const c = 1.0 / (1 + 0.3 * depth);
  return Math.max(0.05, Math.min(1.0, c));
}

function normalizeSourceIds(
  sourceIds: string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) return undefined;
  const cleaned = sourceIds.filter((s) => typeof s === "string" && s.length > 0);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : undefined;
}

interface EdgeRow {
  next_symbol: string | null;
  chunk_id: string;
}

/** One hop over `code_edges_symbol` in the requested direction. */
async function hop(
  engine: Engine,
  sym: string,
  direction: WalkDirection,
  limit: number,
  sources: string[] | undefined,
): Promise<EdgeRow[]> {
  const params: unknown[] = [sym];
  let sourceFilter = "";
  if (sources) {
    params.push(sources);
    sourceFilter = ` AND e.source_id = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const limitPos = params.length;
  // callers: edges INTO sym → the caller is from_symbol_qualified.
  // callees: edges OUT of sym → the callee is to_symbol_qualified.
  const sql =
    direction === "callers"
      ? `SELECT DISTINCT e.from_symbol_qualified AS next_symbol, e.from_chunk_id AS chunk_id
           FROM code_edges_symbol e
          WHERE e.to_symbol_qualified = $1
            AND e.from_symbol_qualified IS NOT NULL${sourceFilter}
          LIMIT $${limitPos}`
      : `SELECT DISTINCT e.to_symbol_qualified AS next_symbol, e.from_chunk_id AS chunk_id
           FROM code_edges_symbol e
          WHERE e.from_symbol_qualified = $1${sourceFilter}
          LIMIT $${limitPos}`;
  const r = await engine.query<EdgeRow>(sql, params);
  return r.rows;
}

/** Resolve a bare name to qualified candidate symbols via `chunks`. */
async function disambiguate(
  engine: Engine,
  bare: string,
  sources: string[] | undefined,
): Promise<string[]> {
  const params: unknown[] = [bare];
  let sourceFilter = "";
  let join = "";
  if (sources) {
    join = " JOIN documents d ON d.id = c.document_id";
    params.push(sources);
    sourceFilter = ` AND d.source_id = ANY($${params.length}::text[])`;
  }
  const r = await engine.query<{ symbol_name_qualified: string }>(
    `SELECT DISTINCT c.symbol_name_qualified
       FROM chunks c${join}
      WHERE c.symbol_name_qualified IS NOT NULL
        AND (c.symbol_name = $1 OR c.symbol_name_qualified = $1)${sourceFilter}
      LIMIT 25`,
    params,
  );
  return r.rows.map((row) => row.symbol_name_qualified);
}

/**
 * BFS recursive walk over the code edge graph. Returns the depth-grouped
 * envelope shared by `code_blast` (callers) and `code_flow` (callees).
 */
export async function runRecursiveWalk(
  engine: Engine,
  symbol: string,
  opts: WalkOpts,
): Promise<WalkResult> {
  const depthCap = opts.depth ?? (opts.direction === "callers" ? 5 : 8);
  const maxNodes = opts.maxNodes ?? 200;
  const sources = normalizeSourceIds(opts.sourceIds);

  let start = symbol;
  if (!opts.exact && !symbol.includes("::")) {
    const matches = await disambiguate(engine, symbol, sources);
    if (matches.length === 0) {
      // No qualified def — fall back to the bare name as-is (edges may be
      // written bare at top level) rather than a hard not_found.
      const bareHop = await hop(engine, symbol, opts.direction, 1, sources);
      if (bareHop.length === 0) {
        return { result: "not_found", did_you_mean: [] };
      }
    } else if (matches.length > 1) {
      return {
        result: "ambiguous",
        candidates: matches.map((m) => ({ symbol_qualified: m })),
      };
    } else {
      start = matches[0]!;
    }
  }

  const visited = new Set<string>([start]);
  const depthGroups: DepthGroup[] = [];
  let cyclesDetected = false;
  let truncation: "none" | "max_nodes" | "depth_cap" | "both" = "none";
  let totalNodes = 0;
  const terminalNodes: { symbol: string; sink_kind: SinkKind }[] = [];

  let frontier = [start];
  for (let d = 1; d <= depthCap; d++) {
    const nextFrontier: string[] = [];
    const nodesThisDepth: WalkNode[] = [];

    let capHit = false;
    for (const sym of frontier) {
      // Fetch only the remaining node budget, not the full cap — near the cap a
      // wide frontier would otherwise fetch and discard maxNodes rows per symbol.
      const remaining = Math.max(1, maxNodes - totalNodes);
      const edges = await hop(engine, sym, opts.direction, remaining, sources);
      for (const e of edges) {
        const next = e.next_symbol;
        if (!next || next === sym) continue;
        if (visited.has(next)) {
          cyclesDetected = true;
          continue;
        }
        if (totalNodes >= maxNodes) {
          truncation = truncation === "depth_cap" ? "both" : "max_nodes";
          capHit = true;
          break;
        }
        visited.add(next);
        totalNodes += 1;
        const node: WalkNode = { symbol: next, chunk_id: e.chunk_id };
        if (opts.direction === "callees") {
          const kind = classifySink(next);
          if (kind !== "unknown") {
            node.sink_kind = kind;
            terminalNodes.push({ symbol: next, sink_kind: kind });
          }
        }
        nodesThisDepth.push(node);
        nextFrontier.push(next);
      }
      if (capHit) break;
    }

    if (nodesThisDepth.length > 0) {
      depthGroups.push({
        depth: d,
        nodes: nodesThisDepth,
        confidence: clampConfidence(d),
      });
    }
    if (truncation === "max_nodes" || truncation === "both") break;
    if (nextFrontier.length === 0) break;
    // Past the max_nodes break, truncation is "none" here.
    if (d === depthCap && nextFrontier.length > 0) {
      truncation = "depth_cap";
    }
    frontier = nextFrontier;
  }

  const result: Extract<WalkResult, { result: "ok" }> = {
    result: "ok",
    depth_groups: depthGroups,
    cycles_detected: cyclesDetected,
    truncation,
  };
  if (opts.direction === "callees" && terminalNodes.length > 0) {
    result.terminal_nodes = terminalNodes;
  }
  return result;
}
