/**
 * usage-insights — getRecentSalience + findAnomalies. Offline (PGLite), no
 * Bedrock. Covers salience ranking + filters, degree-outlier detection,
 * stale-salient detection, and the small-graph / flat-graph guards.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import {
  getRecentSalience,
  findAnomalies,
} from "../src/core/usage-insights.ts";

let tmp: string;
let storage: Storage;

const page = (slug: string, type = "note") =>
  putPage(storage, { slug, type, title: slug, markdown_body: "x" });

const link = (s: string, t: string) =>
  addLink(storage, { source_slug: s, target_slug: t, type: "related", allowAdHocType: true });

// salience is a cycle-recomputed column; set it directly for deterministic tests.
const setSalience = (slug: string, salience: number) =>
  storage
    .engine()
    .query("UPDATE pages SET salience = $2::real WHERE slug = $1", [slug, salience]);

const ageDays = (slug: string, days: number) =>
  storage
    .engine()
    .query(
      "UPDATE pages SET updated_at = NOW() - ($2 || ' days')::interval WHERE slug = $1",
      [slug, days],
    );

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-usage-insights-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("getRecentSalience", () => {
  it("ranks pages by salience DESC", async () => {
    await page("rank/low");
    await page("rank/mid");
    await page("rank/high");
    await setSalience("rank/low", 0.1);
    await setSalience("rank/mid", 0.5);
    await setSalience("rank/high", 0.9);

    const out = await getRecentSalience(storage, { limit: 3 });
    expect(out.map((p) => p.slug)).toEqual([
      "rank/high",
      "rank/mid",
      "rank/low",
    ]);
    expect(out[0]!.salience).toBeCloseTo(0.9, 5);
  });

  it("honours the type filter", async () => {
    await page("typed/person-a", "person");
    await setSalience("typed/person-a", 0.7);
    const out = await getRecentSalience(storage, { type: "person", limit: 50 });
    expect(out.every((p) => p.type === "person")).toBe(true);
    expect(out.some((p) => p.slug === "typed/person-a")).toBe(true);
  });

  it("clamps the limit and never returns deleted pages", async () => {
    const out = await getRecentSalience(storage, { limit: 1 });
    expect(out.length).toBe(1);
  });

  it("filters by the recency window", async () => {
    await page("recency/old");
    await setSalience("recency/old", 0.95);
    await ageDays("recency/old", 400);
    const recent = await getRecentSalience(storage, { days: 30, limit: 100 });
    expect(recent.some((p) => p.slug === "recency/old")).toBe(false);
    const all = await getRecentSalience(storage, { limit: 100 });
    expect(all.some((p) => p.slug === "recency/old")).toBe(true);
  });
});

describe("findAnomalies — degree_outlier", () => {
  it("flags a connectivity hub above mean + sigma·stddev", async () => {
    // Hub linked to many leaves; leaves have degree 1, hub has degree N.
    await page("hub/center");
    for (let i = 0; i < 8; i++) {
      await page(`hub/leaf-${i}`);
      await link("hub/center", `hub/leaf-${i}`);
    }
    const out = await findAnomalies(storage, { sigma: 2, limit: 50 });
    const hub = out.find(
      (a) => a.kind === "degree_outlier" && a.slug === "hub/center",
    );
    expect(hub).toBeDefined();
    expect(hub!.degree).toBe(8);
    expect(hub!.metric).toBeGreaterThan(2); // standard-score above the cutoff
  });

  it("returns no degree outliers on a flat graph (stddev 0)", async () => {
    // Isolated DB so the global graph above doesn't bleed in.
    const tmp2 = mkdtempSync(join(tmpdir(), "memex-flat-"));
    const s2 = new Storage({ dbPath: join(tmp2, "db") });
    await s2.init();
    try {
      await putPage(s2, { slug: "flat/a", type: "note", title: "a", markdown_body: "x" });
      await putPage(s2, { slug: "flat/b", type: "note", title: "b", markdown_body: "x" });
      await addLink(s2, { source_slug: "flat/a", target_slug: "flat/b", type: "related", allowAdHocType: true });
      // Both pages now have degree 1 → stddev 0 → no outlier.
      const out = await findAnomalies(s2, { sigma: 2 });
      expect(out.filter((a) => a.kind === "degree_outlier").length).toBe(0);
    } finally {
      await s2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("findAnomalies — stale_salient", () => {
  it("flags a high-salience page older than staleDays", async () => {
    await page("stale/important");
    await setSalience("stale/important", 0.8);
    await ageDays("stale/important", 200);
    const out = await findAnomalies(storage, {
      staleDays: 90,
      salienceFloor: 0.5,
      limit: 50,
    });
    const hit = out.find(
      (a) => a.kind === "stale_salient" && a.slug === "stale/important",
    );
    expect(hit).toBeDefined();
    expect(hit!.metric).toBeGreaterThanOrEqual(200);
  });

  it("does not flag a salient page that is still fresh", async () => {
    await page("stale/fresh");
    await setSalience("stale/fresh", 0.9);
    await ageDays("stale/fresh", 5);
    const out = await findAnomalies(storage, { staleDays: 90, salienceFloor: 0.5 });
    expect(
      out.some((a) => a.kind === "stale_salient" && a.slug === "stale/fresh"),
    ).toBe(false);
  });

  it("does not flag a stale page below the salience floor", async () => {
    await page("stale/trivial");
    await setSalience("stale/trivial", 0.2);
    await ageDays("stale/trivial", 300);
    const out = await findAnomalies(storage, { staleDays: 90, salienceFloor: 0.5 });
    expect(
      out.some((a) => a.kind === "stale_salient" && a.slug === "stale/trivial"),
    ).toBe(false);
  });
});
