/**
 * param-redaction.ts — turn an MCP tool call's params into a REDACTED summary
 * safe for logs, and an opt-in per-request log line.
 *
 * The brain never logs request params raw: a search `q`, a `page_put` body, a
 * slug, or a path is private note content. This summary keeps only the shape —
 * which DECLARED parameter names were present, how many UNKNOWN keys came
 * along, and a coarse size bucket — never any value.
 *
 * Size is bucketed UP to the nearest 1 KB on purpose. Publishing the exact
 * byte length would let a caller who can submit a known prefix binary-search
 * the length of secret content via repeated probes; 1 KB resolution destroys
 * that side channel while keeping a useful "roughly how big" signal.
 *
 * Logging is OFF by default and emits nothing unless `MEMEX_LOG_REQUESTS` is
 * `1`/`true`. Even then it writes only the redacted summary.
 */
import { TOOL_DEFS } from "./tool_defs.ts";

export interface ParamSummary {
  redacted: true;
  kind: "array" | "object" | string;
  /** Param names present that the tool's schema declares (sorted). */
  declared_keys?: string[];
  /** Count of submitted keys NOT in the tool's schema. */
  unknown_key_count?: number;
  /** Array length, for array params. */
  length?: number;
  /** JSON byte size rounded UP to the nearest 1 KB (coarse, side-channel-safe). */
  approx_bytes?: number;
}

// Declared param names per tool, derived once from the JSON-Schema tool defs.
const DECLARED_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  TOOL_DEFS.map((t) => {
    const schema = t.inputSchema as { properties?: Record<string, unknown> };
    return [t.name, new Set(Object.keys(schema.properties ?? {}))] as const;
  }),
);

/** Round a byte count UP to the nearest 1 KB. Returns undefined on bad input. */
function bucketBytes(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n <= 0) return 0;
  const KB = 1024;
  return Math.ceil(n / KB) * KB;
}

/**
 * Summarize a tool call's params for logging — names + counts + coarse size,
 * never any value. Returns null for null/undefined params.
 */
export function summarizeMcpParams(
  toolName: string,
  params: unknown,
): ParamSummary | null {
  if (params == null) return null;

  let approxBytes: number | undefined;
  try {
    // True UTF-8 byte length (not UTF-16 code units) before bucketing.
    approxBytes = bucketBytes(Buffer.byteLength(JSON.stringify(params), "utf8"));
  } catch {
    approxBytes = undefined;
  }
  const bytes = approxBytes !== undefined ? { approx_bytes: approxBytes } : {};

  if (Array.isArray(params)) {
    return { redacted: true, kind: "array", length: params.length, ...bytes };
  }

  if (typeof params === "object") {
    const allow = DECLARED_KEYS.get(toolName) ?? new Set<string>();
    const declared: string[] = [];
    let unknown = 0;
    for (const k of Object.keys(params as Record<string, unknown>)) {
      if (allow.has(k)) declared.push(k);
      else unknown += 1;
    }
    declared.sort();
    return {
      redacted: true,
      kind: "object",
      declared_keys: declared,
      unknown_key_count: unknown,
      ...bytes,
    };
  }

  return { redacted: true, kind: typeof params, ...bytes };
}

/** Whether per-request logging is enabled (`MEMEX_LOG_REQUESTS=1|true`). */
export function requestLoggingEnabled(): boolean {
  const v = process.env["MEMEX_LOG_REQUESTS"];
  return v === "1" || v === "true";
}

/** True when `toolName` is one of the brain's declared MCP tools. */
export function isKnownTool(toolName: string): boolean {
  return DECLARED_KEYS.has(toolName);
}

/**
 * Emit a single redacted log line for one tool call — no-op unless
 * `MEMEX_LOG_REQUESTS` is set. The line carries the tool name, the ingress
 * class, the ok flag, and the param SUMMARY (never raw params).
 *
 * Self-protecting: it runs on the request path AFTER the tool already
 * completed, so a logging failure must never turn a successful call into an
 * error — every fault is swallowed.
 */
export function logToolCall(
  toolName: string,
  isPublic: boolean,
  params: unknown,
  ok: boolean,
): void {
  if (!requestLoggingEnabled()) return;
  try {
    // An UNKNOWN tool name is caller-controlled input — never echo it raw
    // (log-injection / value-smuggling). Only declared tool names pass through.
    const known = isKnownTool(toolName);
    console.log(
      JSON.stringify({
        mcp_request: {
          tool: known ? toolName : "unknown",
          known_tool: known,
          ingress: isPublic ? "public" : "internal",
          ok,
          params: summarizeMcpParams(toolName, params),
        },
      }),
    );
  } catch {
    /* logging is best-effort; never break request handling */
  }
}
