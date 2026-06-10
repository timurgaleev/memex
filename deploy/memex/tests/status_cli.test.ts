/**
 * `memex status` — one-shot snapshot. Runs against a fresh PGLite + temp
 * config; asserts the bundled stats/health/cache shape.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../src/commands/status.ts";

const tmp = mkdtempSync(join(tmpdir(), "memex-status-test-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("memex status", () => {
  it("bundles stats + health + cache into one snapshot", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      await runStatus({ configPath: cfgPath });
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(lines.join("\n")) as {
      ok: boolean;
      version: string;
      stats: { documents: number; chunks: number; embeddings: number };
      health: { embed_coverage_pct: number; queue_depth: number; failed_jobs_24h: number };
      cache: { total: number; fresh: number; stale: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toMatch(/\d+\.\d+\.\d+/);
    // Fresh brain: empty everywhere; coverage defaults to 1.0 (nothing to embed).
    expect(parsed.stats.documents).toBe(0);
    expect(parsed.health.embed_coverage_pct).toBe(1);
    expect(parsed.health.failed_jobs_24h).toBe(0);
    expect(parsed.cache.total).toBe(0);
  });
});
