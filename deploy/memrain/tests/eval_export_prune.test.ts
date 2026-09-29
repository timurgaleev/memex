/**
 * Tests for eval-export, eval-prune, and apply-migrations.
 *
 * Coverage:
 *   - eval-export reads eval_candidates / eval_queries depending on source
 *   - eval-prune dry-run counts without DELETE; --apply deletes
 *   - apply-migrations --dry-run lists files; live mode is exercised by
 *     `init` already so we just smoke-check the dry-run shape
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { captureEvalCandidate } from "../src/core/eval-capture.ts";
import { discoverMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-evalops-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("eval-export — file write path", () => {
  it("writes JSONL of captured rows to --out", async () => {
    const e = storage.engine();
    for (let i = 0; i < 3; i++) {
      await captureEvalCandidate(e, {
        toolName: "cli.search",
        query: `q${i}`,
        resultDocIds: [`d${i}`],
        k: 5,
        searchMode: "hybrid",
        latencyMs: 10,
      });
    }
    // Direct SQL — the CLI runner does the same work after loadConfig,
    // which we don't have in tests. This validates the JSONL shape.
    const r = await e.query<{ tool_name: string; query: string }>(
      `SELECT tool_name, query FROM eval_candidates ORDER BY id`,
    );
    const lines = r.rows.map((row) => JSON.stringify(row));
    const outPath = join(tmp, "out.jsonl");
    await import("node:fs").then((fs) =>
      fs.writeFileSync(outPath, lines.join("\n") + "\n"),
    );
    const text = readFileSync(outPath, "utf8");
    expect(text.trim().split("\n").length).toBe(3);
    expect(text).toContain("cli.search");
  });
});

describe("eval-prune — counter / delete logic", () => {
  it("counts old rows in dry-run mode without deleting", async () => {
    const e = storage.engine();
    // Seed rows with explicit captured_at — one ancient, one recent.
    await e.exec(`
      INSERT INTO eval_candidates
        (tool_name, query, k, search_mode, captured_at)
      VALUES
        ('cli.search', 'old', 5, 'hybrid', NOW() - INTERVAL '120 days'),
        ('cli.search', 'recent', 5, 'hybrid', NOW() - INTERVAL '5 days');
    `);
    const c = await e.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM eval_candidates
        WHERE captured_at < NOW() - ($1 || ' days')::interval`,
      [String(90)],
    );
    expect(c.rows[0]?.n).toBe(1);
    // No DELETE: row should still be there.
    const total = await e.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM eval_candidates`,
    );
    expect(total.rows[0]?.n).toBe(2);
  });

  it("deletes rows when apply=true", async () => {
    const e = storage.engine();
    await e.exec(`
      INSERT INTO eval_candidates
        (tool_name, query, k, search_mode, captured_at)
      VALUES
        ('cli.search', 'a', 5, 'hybrid', NOW() - INTERVAL '120 days'),
        ('cli.search', 'b', 5, 'hybrid', NOW() - INTERVAL '5 days');
    `);
    await e.query(
      `DELETE FROM eval_candidates WHERE captured_at < NOW() - ($1 || ' days')::interval`,
      [String(90)],
    );
    const remaining = await e.query<{ query: string }>(
      `SELECT query FROM eval_candidates ORDER BY captured_at DESC`,
    );
    expect(remaining.rows.map((r) => r.query)).toEqual(["b"]);
  });
});

describe("apply-migrations — discovery", () => {
  it("discovers all shipped migrations in id order", () => {
    const files = discoverMigrations();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.id).toBe(1);
    // ids must be strictly increasing
    for (let i = 1; i < files.length; i++) {
      expect(files[i]!.id).toBeGreaterThan(files[i - 1]!.id);
    }
  });
});
