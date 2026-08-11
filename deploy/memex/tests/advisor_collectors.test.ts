/**
 * Advisor collectors against a real PGLite brain. Seeds a known mix and asserts
 * each deterministic finding: low embed coverage, stalled + failed jobs, version
 * drift, and the internal-token setup smell. No LLM, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import {
  collectEmbedCoverage,
  collectStalledJobs,
  collectVersion,
  collectSetupSmells,
  collectMigration,
  collectUsageShape,
} from "../src/core/advisor/collectors.ts";
import type { AdvisorContext } from "../src/core/advisor/types.ts";

const dir = mkdtempSync(join(tmpdir(), "memex-advisor-"));
let storage: Storage;
const NOW = new Date("2026-06-22T00:00:00.000Z");

function ctx(version = "1.2.3"): AdvisorContext {
  return { engine: storage.raw(), version, now: NOW };
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dir, "db") });
  await storage.init();
  const e = storage.raw();

  // Two embeddable markdown chunks, none embedded → 0% coverage.
  await e.query(
    `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
     VALUES ('d1','notes/a.md','A','{}'::jsonb, NOW())`,
  );
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('d1c0','d1',0,'alpha')`);
  await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('d1c1','d1',1,'beta')`);

  // A stalled running job (lock lapsed) + a recent failed job.
  await e.query(
    `INSERT INTO jobs (id, kind, status, lock_until) VALUES ('js','sweep','running', NOW() - INTERVAL '1 hour')`,
  );
  await e.query(
    `INSERT INTO jobs (id, kind, status, finished_at) VALUES ('jf','sweep','failed', NOW() - INTERVAL '1 hour')`,
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("collectEmbedCoverage", () => {
  it("flags low coverage when embeddable chunks have no embedding", async () => {
    const out = await collectEmbedCoverage.collect(ctx());
    expect(out.length).toBe(1);
    const finding = out[0];
    expect(finding?.id).toBe("low_embed_coverage");
    expect(finding?.severity).toBe("medium");
    expect(finding?.fix_command).toBe("memex embed");
  });
});

describe("collectStalledJobs", () => {
  it("flags a lock-lapsed running job and a recent failure", async () => {
    const out = await collectStalledJobs.collect(ctx());
    const ids = out.map((x) => x.id);
    expect(ids).toContain("stalled_job:sweep");
    expect(ids).toContain("failed_jobs_24h");
  });
});

describe("collectMigration", () => {
  it("reports no pending migrations on a freshly migrated brain", async () => {
    // Storage.init() applied the full set, so nothing is pending.
    const out = await collectMigration.collect(ctx());
    expect(out.length).toBe(0);
  });
});

describe("collectVersion", () => {
  it("flags drift when the running version differs from the built package", async () => {
    const out = await collectVersion.collect(ctx("0.0.0-drift"));
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe("version_drift");
    expect(out[0]?.severity).toBe("low");
  });
});

describe("collectUsageShape", () => {
  it("flags an islanded page and a dead link", async () => {
    // alice → bob (both connected); carol is islanded; dave → ghost (dead target).
    // alice → dave keeps dave connected so it isn't itself counted as an orphan.
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "people/bob", type: "person" });
    await putPage(storage, { slug: "people/carol", type: "person" });
    await putPage(storage, { slug: "people/dave", type: "person" });
    await addLink(storage, { source_slug: "people/alice", target_slug: "people/bob", type: "knows" });
    await addLink(storage, { source_slug: "people/alice", target_slug: "people/dave", type: "knows" });
    await addLink(storage, { source_slug: "people/dave", target_slug: "people/ghost", type: "knows" });

    const out = await collectUsageShape.collect(ctx());
    const byId = new Map(out.map((f) => [f.id, f]));
    expect(byId.get("orphan_pages")?.title).toContain("1 page has");
    // Both fix_commands used to name the wrong thing: `memex orphans` purges
    // orphaned DB rows rather than listing islanded pages, and `memex doctor`
    // has no dead-link check at all, so following either printed success while
    // the condition stayed.
    expect(byId.get("orphan_pages")?.fix_command).toBe("find_orphans");
    expect(byId.get("dead_links")?.title).toContain("1 link point");
    expect(byId.get("dead_links")?.fix_command).toBe("memex reconcile-links");

    // Soft-delete adaptation: deleting bob turns alice → bob into a dead link
    // (target no longer live), while carol stays the sole orphan (alice keeps a
    // live edge to dave, dave keeps a live inbound from alice).
    await deletePage(storage, "people/bob");
    const out2 = await collectUsageShape.collect(ctx());
    const byId2 = new Map(out2.map((f) => [f.id, f]));
    expect(byId2.get("orphan_pages")?.title).toContain("1 page has");
    expect(byId2.get("dead_links")?.title).toContain("2 links point");
  });
});

describe("collectSetupSmells", () => {
  it("flags an unset MEMEX_INTERNAL_TOKEN", async () => {
    const prev = process.env["MEMEX_INTERNAL_TOKEN"];
    delete process.env["MEMEX_INTERNAL_TOKEN"];
    try {
      const out = await collectSetupSmells.collect(ctx());
      expect(out.map((x) => x.id)).toContain("internal_token_unset");
    } finally {
      if (prev !== undefined) process.env["MEMEX_INTERNAL_TOKEN"] = prev;
    }
  });

  it("is silent when the token is set", async () => {
    const prev = process.env["MEMEX_INTERNAL_TOKEN"];
    process.env["MEMEX_INTERNAL_TOKEN"] = "secret-token";
    try {
      const out = await collectSetupSmells.collect(ctx());
      expect(out.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env["MEMEX_INTERNAL_TOKEN"];
      else process.env["MEMEX_INTERNAL_TOKEN"] = prev;
    }
  });
});
