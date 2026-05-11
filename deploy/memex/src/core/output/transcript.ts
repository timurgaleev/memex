/**
 * Per-call transcripts — record the full request/response trace of one
 * MCP tools/call so we can replay them later (eval-replay, friction
 * triage). stub; (friction) adds real persistence.
 */

export interface Transcript {
  id: string;
  startedAt: string; // ISO
  finishedAt?: string;
  tool: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  events: { ts: number; kind: string; data: unknown }[];
}

export interface TranscriptSink {
  begin(t: Omit<Transcript, "events" | "finishedAt">): void;
  event(id: string, kind: string, data: unknown): void;
  end(id: string, result: unknown): void;
  fail(id: string, error: string): void;
}

export const NOOP_TRANSCRIPT: TranscriptSink = {
  begin: () => {},
  event: () => {},
  end: () => {},
  fail: () => {},
};
