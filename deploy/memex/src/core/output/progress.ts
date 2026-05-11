/**
 * Progress events — sequenced status updates for long-running operations
 * (sweep, cycle phases, migrate-engine). Cycle phases emit them today;
 * a future SSE endpoint will stream them to MCP clients (Claude Desktop,
 * openclaw, etc.) for live progress UIs.
 */

export type ProgressEvent =
  | { kind: "started"; op: string; ts: number }
  | { kind: "phase"; op: string; phase: string; pct?: number; ts: number }
  | { kind: "log"; op: string; level: "info" | "warn" | "error"; message: string; ts: number }
  | { kind: "completed"; op: string; result: unknown; ts: number }
  | { kind: "failed"; op: string; error: string; ts: number };

export type ProgressSink = (e: ProgressEvent) => void;

export const NOOP_PROGRESS: ProgressSink = () => {};

export function consoleProgress(prefix: string): ProgressSink {
  return (e) => {
    if (e.kind === "log") {
      const fn =
        e.level === "error" ? console.error : e.level === "warn" ? console.warn : console.log;
      fn(`[${prefix}/${e.op}] ${e.message}`);
    } else if (e.kind === "phase") {
      console.log(
        `[${prefix}/${e.op}] ${e.phase}${e.pct !== undefined ? ` ${e.pct.toFixed(0)}%` : ""}`,
      );
    } else if (e.kind === "failed") {
      console.error(`[${prefix}/${e.op}] FAILED: ${e.error}`);
    }
  };
}
