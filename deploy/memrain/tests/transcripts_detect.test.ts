import { describe, expect, it } from "bun:test";
import {
  checkTranscriptFileSize,
  detectFormat,
  parseTranscriptExport,
  transcriptMaxFileBytes,
} from "../src/core/transcripts/detect.ts";

const chatgpt = {
  id: "g1",
  title: "t",
  mapping: {
    a: { id: "a", parent: null, children: [], message: { id: "a", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } } },
  },
  current_node: "a",
};
const claude = { uuid: "c1", name: "n", chat_messages: [{ uuid: "m", sender: "human", text: "hello" }] };

describe("detectFormat", () => {
  it("recognises each export by shape, in order", () => {
    expect(detectFormat([chatgpt])).toBe("chatgpt");
    expect(detectFormat([claude])).toBe("claude-ai");
    // An item carrying both shapes resolves to the first adapter in order.
    expect(detectFormat([{ ...claude, ...chatgpt }])).toBe("chatgpt");
    expect(detectFormat([{ hello: "world" }])).toBeNull();
  });

  it("lets an explicit --format win over detection", () => {
    const r = parseTranscriptExport([claude], 100, "chatgpt");
    expect(r.diagnostics.detected_by).toBe("override");
    expect(r.diagnostics.format).toBe("chatgpt");
    // Read as the wrong format, nothing comes out — which is drift.
    expect(r.sessions).toHaveLength(0);
    expect(r.diagnostics.format_drift).toBe(true);
  });

  it("finds the conversation list under a wrapping object", () => {
    const r = parseTranscriptExport({ conversations: [claude] }, 100);
    expect(r.diagnostics.format).toBe("claude-ai");
    expect(r.sessions).toHaveLength(1);
  });
});

describe("format drift", () => {
  it("reports non-empty unknown JSON as drift with zero sessions", () => {
    const r = parseTranscriptExport({ some: "other export" }, 30);
    expect(r.sessions).toHaveLength(0);
    expect(r.diagnostics).toMatchObject({ format: null, detected_by: "none", format_drift: true });
    const items = parseTranscriptExport([{ x: 1 }, { y: 2 }], 20);
    expect(items.diagnostics).toMatchObject({ items: 2, sessions: 0, format_drift: true });
  });

  it("does not call an empty export drift", () => {
    expect(parseTranscriptExport([], 2).diagnostics.format_drift).toBe(false);
    expect(parseTranscriptExport({ conversations: [] }, 20).diagnostics.format_drift).toBe(false);
  });
});

describe("size cap", () => {
  it("rejects a file over the cap instead of truncating it", () => {
    expect(checkTranscriptFileSize(10, 10)).toBeNull();
    expect(checkTranscriptFileSize(11, 10)).toContain("over the 10-byte cap");
  });

  it("reads the cap from MEMEX_TRANSCRIPT_MAX_FILE_BYTES, ignoring junk", () => {
    expect(transcriptMaxFileBytes({ MEMEX_TRANSCRIPT_MAX_FILE_BYTES: "4096" })).toBe(4096);
    const fallback = transcriptMaxFileBytes({});
    expect(transcriptMaxFileBytes({ MEMEX_TRANSCRIPT_MAX_FILE_BYTES: "-3" })).toBe(fallback);
    expect(transcriptMaxFileBytes({ MEMEX_TRANSCRIPT_MAX_FILE_BYTES: "lots" })).toBe(fallback);
  });
});
