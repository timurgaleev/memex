/**
 * Rerank failure audit JSONL (G22) — filesystem only, no Bedrock.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logRerankFailure,
  hashQueryForAudit,
} from "../src/core/search/rerank-audit.ts";

const savedDir = process.env.MEMEX_AUDIT_DIR;
afterEach(() => {
  if (savedDir === undefined) delete process.env.MEMEX_AUDIT_DIR;
  else process.env.MEMEX_AUDIT_DIR = savedDir;
});

describe("logRerankFailure", () => {
  it("appends an ISO-week-rotated JSONL record when MEMEX_AUDIT_DIR is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-rerank-audit-"));
    process.env.MEMEX_AUDIT_DIR = dir;
    const now = new Date("2026-07-01T12:00:00Z");
    logRerankFailure(
      {
        model: "test-model",
        reason: "timeout",
        query_hash: hashQueryForAudit("secret query"),
        doc_count: 7,
        error_summary: "deadline exceeded",
      },
      now,
    );
    const files = readdirSync(dir).filter((f) => f.startsWith("rerank-failures-"));
    expect(files).toHaveLength(1);
    const line = readFileSync(join(dir, files[0]!), "utf8").trim();
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec.reason).toBe("timeout");
    expect(rec.doc_count).toBe(7);
    expect(rec.model).toBe("test-model");
    // Privacy: the query text never lands in the trail — only its hash prefix.
    expect(line).not.toContain("secret query");
    expect((rec.query_hash as string).length).toBe(8);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op without MEMEX_AUDIT_DIR (and never throws)", () => {
    delete process.env.MEMEX_AUDIT_DIR;
    expect(() =>
      logRerankFailure({
        model: "m",
        reason: "unknown",
        query_hash: "deadbeef",
        doc_count: 0,
        error_summary: "x",
      }),
    ).not.toThrow();
  });
});
