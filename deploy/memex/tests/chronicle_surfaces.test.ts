/**
 * Life Chronicle operational surfaces — the doctor projection-health check, the
 * advisor chronicle collector, the search recency lift, and the capture
 * diary/event routing. All run against a fresh in-memory PGLite (no gateway;
 * capture uses the deterministic embed seam).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage, deletePage } from "../src/core/pages.ts";
import { getTimelineForDate } from "../src/core/chronicle.ts";
import { runChronicleExtract, type ChronicleJudge } from "../src/core/chronicle/extract-events.ts";
import { valueHash } from "../src/core/chronicle/ontology.ts";
import { runDoctor } from "../src/commands/doctor.ts";
import { collectChronicle } from "../src/core/advisor/collectors.ts";
import type { AdvisorContext } from "../src/core/advisor/types.ts";
import { chronicleBoostMultiplier } from "../src/core/search/chronicle-boost.ts";
import { runCapture, capturePrefix, defaultCaptureSlug, buildEventBlock } from "../src/commands/capture.ts";
import { deterministicEmbed } from "./det-embed.ts";

const LONG_BODY = "x".repeat(120);
const stubJudge = (when: string, what: string, who: string[] = ["people/alice"]): ChronicleJudge =>
  async () => ({ events: [{ when, who, what, kind: "meeting" }] });

// ── Doctor: chronicle-projection-health ────────────────────────────────────
describe("doctor chronicle-projection-health", () => {
  const tmp = mkdtempSync(join(tmpdir(), "memex-chron-doctor-"));
  const cfgDir = join(tmp, ".memex");
  const dbPath = join(cfgDir, "brain.pglite");
  const cfgPath = join(cfgDir, "config.json");
  let vaultPrev: string | undefined;

  beforeAll(() => {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        database: { type: "pglite", path: dbPath },
        embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
        storage: {},
      }),
    );
    vaultPrev = process.env.MEMEX_VAULT_PATH;
    delete process.env.MEMEX_VAULT_PATH;
  });

  afterAll(() => {
    if (vaultPrev !== undefined) process.env.MEMEX_VAULT_PATH = vaultPrev;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function runAndFindCheck(): Promise<{ ok: boolean; detail?: string }> {
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    process.exitCode = 0;
    try {
      await runDoctor({ configPath: cfgPath });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(captured.join("\n")) as {
      checks: { name: string; ok: boolean; detail?: string }[];
    };
    return parsed.checks.find((c) => c.name === "chronicle-projection-health")!;
  }

  it("is ok with no orphaned projections on a fresh brain", async () => {
    const check = await runAndFindCheck();
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("no orphaned timeline projections");
  });

  it("detects a projection whose event page was soft-deleted", async () => {
    const storage = new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));
    await storage.init();
    try {
      await putPage(storage, {
        slug: "meetings/2026-04-01", type: "meeting", title: "Sync",
        compiled_truth: { date: "2026-04-01", attendees: ["people/alice"] },
        markdown_body: LONG_BODY,
      });
      await runChronicleExtract(storage, {
        slug: "meetings/2026-04-01", sourceId: "default",
        judge: stubJudge("2026-04-01", "Sync call"),
      });
      const rows = await getTimelineForDate(storage, "2026-04-01", { sourceIds: ["default"] });
      expect(rows.length).toBe(1);
      // Soft-delete the projecting event page → the timeline row now dangles.
      await deletePage(storage, rows[0]!.event_slug!);
    } finally {
      await storage.close();
    }
    const check = await runAndFindCheck();
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("1 timeline projection");
    expect(check.detail).toContain("default: 1");
  });
});

// ── Advisor: collectChronicle ───────────────────────────────────────────────
describe("advisor collectChronicle", () => {
  const dir = mkdtempSync(join(tmpdir(), "memex-chron-advisor-"));
  let storage: Storage;
  const NOW = new Date("2026-06-22T00:00:00.000Z");
  const ctx = (sourceIds?: readonly string[]): AdvisorContext => ({
    engine: storage.raw(), version: "1.2.3", now: NOW, ...(sourceIds ? { sourceIds } : {}),
  });

  async function ensureSource(id: string) {
    await storage.raw().query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT DO NOTHING`,
      [id, `tenant:${id}`],
    );
  }

  async function seedOpen(entity: string, value: string, source: string, sourceId = "default") {
    await storage.raw().query(
      `INSERT INTO entity_facts
         (entity_slug, fact, kind, visibility, dimension, value, value_hash, confidence, source_slug, valid_from, source_id)
       VALUES ($1, $2, 'fact', 'private', 'role', $3, $4, 0.8, $5, '2026-06-01'::date, $6)`,
      [entity, `role: ${value}`, value, valueHash(value), source, sourceId],
    );
  }

  beforeAll(async () => {
    storage = new Storage({ dbPath: join(dir, "db") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is silent on a fresh brain", async () => {
    expect((await collectChronicle.collect(ctx(["default"]))).length).toBe(0);
  });

  it("resolves whole-brain scope for the unscoped operator", async () => {
    // advisor is operator-only, so the operator arrives with no explicit scope;
    // the collector must resolve the whole brain and still surface the conflict.
    await seedOpen("people/x", "advisor", "meetings/a");
    await seedOpen("people/x", "founder", "meetings/b");
    const out = await collectChronicle.collect(ctx());
    expect(out.some((f) => f.id === "ontology_conflicts")).toBe(true);
  });

  it("emits the conflict signal for a standing 2-source disagreement", async () => {
    const out = await collectChronicle.collect(ctx(["default"]));
    const conflict = out.find((f) => f.id === "ontology_conflicts");
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe("medium");
    expect(conflict!.fix_command).toBe("ontology_conflicts");
  });

  it("does not surface another tenant's conflict", async () => {
    await ensureSource("tenant-b");
    await seedOpen("people/y", "advisor", "meetings/c", "tenant-b");
    await seedOpen("people/y", "founder", "meetings/d", "tenant-b");
    const out = await collectChronicle.collect(ctx(["default"]));
    // people/y conflict belongs to tenant-b — the default scope must not see it.
    const conflict = out.find((f) => f.id === "ontology_conflicts")!;
    expect(conflict.title).toContain("1 entity");
  });

  it("emits the coverage signal for a recent meeting with no projection", async () => {
    await putPage(storage, {
      slug: "meetings/uncovered", type: "meeting", title: "Uncovered",
      compiled_truth: { date: "2026-06-20" }, markdown_body: LONG_BODY,
    });
    const out = await collectChronicle.collect(ctx(["default"]));
    const gap = out.find((f) => f.id === "chronicle_coverage_gap");
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("info");
    expect(gap!.fix_command).toBe("chronicle_backfill");
    expect(gap!.title).toContain("1 recent conversation");
  });

  it("stops counting a meeting once it has a timeline projection", async () => {
    await runChronicleExtract(storage, {
      slug: "meetings/uncovered", sourceId: "default",
      judge: stubJudge("2026-06-20", "Now covered"),
    });
    const out = await collectChronicle.collect(ctx(["default"]));
    expect(out.find((f) => f.id === "chronicle_coverage_gap")).toBeUndefined();
  });
});

// ── Search: chronicle recency lift ──────────────────────────────────────────
describe("chronicleBoostMultiplier", () => {
  it("lifts life/events + life/diary hits only on a temporal search", () => {
    expect(chronicleBoostMultiplier("life/events/2026-01-01-x", "on")).toBe(1.15);
    expect(chronicleBoostMultiplier("life/events/2026-01-01-x", "strong")).toBe(1.25);
    expect(chronicleBoostMultiplier("life/diary/2026-01-01", "on")).toBe(1.15);
    // page:// mirror matches the same prefix as its page twin.
    expect(chronicleBoostMultiplier("page://life/events/x", "strong")).toBe(1.25);
  });

  it("is neutral off-prefix and off-mode (non-temporal is unchanged)", () => {
    expect(chronicleBoostMultiplier("notes/x", "on")).toBe(1);
    expect(chronicleBoostMultiplier("life/events/x", "off")).toBe(1);
    expect(chronicleBoostMultiplier(null, "strong")).toBe(1);
  });

  it("reorders two equal-score hits only when the mode is on", () => {
    const hits = [
      { path: "notes/a", base: 0.5 },
      { path: "life/events/b", base: 0.5 },
    ];
    const on = hits
      .map((h) => ({ ...h, score: h.base * chronicleBoostMultiplier(h.path, "on") }))
      .sort((x, y) => y.score - x.score);
    expect(on[0]!.path).toBe("life/events/b");

    const off = hits.map((h) => ({ ...h, score: h.base * chronicleBoostMultiplier(h.path, "off") }));
    // Off mode: both keep their base score — order (and equality) is unchanged.
    expect(off[0]!.score).toBe(off[1]!.score);
  });
});

// ── Capture: diary/event routing + event block ──────────────────────────────
describe("capture chronicle routing", () => {
  it("routes types to the right slug prefix", () => {
    expect(capturePrefix("diary")).toBe("life/diary");
    expect(capturePrefix("event")).toBe("life/events");
    expect(capturePrefix("note")).toBe("capture");
    expect(capturePrefix(undefined)).toBe("capture");
  });

  it("defaults the slug under the type's prefix", () => {
    const d = new Date("2026-07-06T10:00:00Z");
    expect(defaultCaptureSlug("Coffee with Alice", d, "life/diary")).toBe(
      "life/diary/2026-07-06-coffee-with-alice",
    );
  });

  it("assembles an event block from declared keys only", () => {
    expect(buildEventBlock({ who: ["people/alice"], what: "lunch" })).toEqual({
      who: ["people/alice"], what: "lunch",
    });
    expect(buildEventBlock({})).toBeNull();
  });

  describe("runCapture integration", () => {
    const tmp = mkdtempSync(join(tmpdir(), "memex-chron-capture-"));
    const cfgDir = join(tmp, ".memex");
    const cfgPath = join(cfgDir, "config.json");

    beforeAll(() => {
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        cfgPath,
        JSON.stringify({
          database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
          embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
          storage: {},
        }),
      );
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it("writes a diary page under life/diary/ with a merged event block", async () => {
      const code = await runCapture({
        text: "Quiet morning, then a long walk.",
        type: "diary",
        who: ["people/alice"],
        what: "morning walk",
        kind: "solo",
        configPath: cfgPath,
        embedFn: (t) => Promise.resolve(deterministicEmbed(t)),
      });
      expect(code).toBe(0);

      const storage = new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));
      await storage.init();
      try {
        const page = await storage.raw().query<{ slug: string; compiled_truth: Record<string, unknown> }>(
          "SELECT slug, compiled_truth FROM pages WHERE slug LIKE 'life/diary/%' AND deleted_at IS NULL",
        );
        expect(page.rows.length).toBe(1);
        expect(page.rows[0]!.slug).toMatch(/^life\/diary\/\d{4}-\d{2}-\d{2}-quiet-morning/);
        const event = page.rows[0]!.compiled_truth.event as Record<string, unknown>;
        expect(event).toEqual({ who: ["people/alice"], what: "morning walk", kind: "solo" });
        const got = await getPage(storage, page.rows[0]!.slug);
        expect(got!.type).toBe("diary");
      } finally {
        await storage.close();
      }
    }, 15000);
  });
});
