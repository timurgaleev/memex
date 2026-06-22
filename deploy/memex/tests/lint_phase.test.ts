/**
 * Lint core (core/lint.ts) + lint cycle phase (core/cycle/lint.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { lintFrontmatter, lintCorpus } from "../src/core/lint.ts";
import { lintPhase } from "../src/core/cycle/lint.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-lint-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("lintFrontmatter rules", () => {
  it("flags all four missing fields on an empty frontmatter", () => {
    expect(lintFrontmatter({})).toEqual([
      "title-missing",
      "tags-missing",
      "created-missing",
      "updated-missing",
    ]);
  });

  it("passes a fully-populated frontmatter", () => {
    expect(
      lintFrontmatter({ title: "ok", tags: ["x"], created: "2026-01-01", updated: "2026-02-02" }),
    ).toEqual([]);
  });
});

describe("lintCorpus + lint phase", () => {
  it("counts conforming vs non-conforming documents", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO documents (id, source_path, title, frontmatter) VALUES
        ('d_ok', '/ok.md', 'OK', '{"title":"OK","tags":["a"],"created":"2026-01-01","updated":"2026-01-02"}'::jsonb),
        ('d_bad', '/bad.md', 'Bad', '{}'::jsonb)`,
    );
    const report = await lintCorpus(e);
    expect(report.totalScanned).toBe(2);
    expect(report.issues.length).toBe(1);
    expect(report.issues[0]!.documentId).toBe("d_bad");
    expect(report.ok).toBe(false);

    const phase = await lintPhase(e);
    expect(phase.scanned).toBe(2);
    expect(phase.flagged).toBe(1);
    expect(phase.summary["title-missing"]).toBe(1);
  });
});
