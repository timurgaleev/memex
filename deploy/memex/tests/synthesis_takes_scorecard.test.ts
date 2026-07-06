/**
 * Takes scorecard + calibration curve (backing takes_scorecard / takes_calibration).
 * Offline PGLite; migration 045 creates synth_takes / synth_take_grades, mig 047
 * registers the 'default' source. Tenant scope is via synth_takes.source_ref →
 * documents.source_id, so we seed per-tenant document rows the takes point at.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import {
  getTakesScorecard,
  getTakesCalibration,
} from "../src/core/synthesis/reads.ts";

const dbDir = mkdtempSync(join(tmpdir(), "tb-takes-scorecard-"));
let storage: Storage;

const A = "tenantA";
const B = "tenantB";

async function seedGradedTake(
  docId: string,
  source: string,
  weight: number,
  verdict: "correct" | "incorrect" | "partial" | "unresolvable",
  key: string,
) {
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
    [docId, `/${source}/${docId}.md`, docId, source],
  );
  const r = await e.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
     VALUES ($1, $2, 'h', 'v1', $1, 'bet', $3, 'queued', 'fake') RETURNING id`,
    [key, docId, weight],
  );
  const takeId = r.rows[0]!.id;
  await e.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1', $2, $3, 0.9, 'fake')`,
    [takeId, `sig-${key}`, verdict],
  );
  return takeId;
}

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  // Tenant A: one correct bet at weight 0.8.
  await seedGradedTake("doc-a", A, 0.8, "correct", "t/a");
  // Tenant B: one incorrect bet at weight 0.2.
  await seedGradedTake("doc-b", B, 0.2, "incorrect", "t/b");
  // A partial (unresolved-for-accuracy) take, tenant A.
  await seedGradedTake("doc-a2", A, 0.5, "partial", "t/a2");
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("getTakesScorecard", () => {
  it("aggregates counts, accuracy, partial_rate, and Brier across all tenants", async () => {
    const s = await getTakesScorecard(storage.engine());
    expect(s.total_takes).toBe(3);
    expect(s.graded).toBe(3);
    expect(s.resolved).toBe(3); // correct + incorrect + partial
    expect(s.correct).toBe(1);
    expect(s.incorrect).toBe(1);
    expect(s.partial).toBe(1);
    expect(s.unresolvable).toBe(0);
    expect(s.accuracy).toBeCloseTo(0.5, 5); // 1 / (1 + 1)
    expect(s.partial_rate).toBeCloseTo(1 / 3, 5);
    // Brier over the 2 decided bets: ((0.8-1)^2 + (0.2-0)^2)/2 = (0.04+0.04)/2 = 0.04
    expect(s.brier).toBeCloseTo(0.04, 5);
  });

  it("scopes to one tenant's takes (fail-closed via source document)", async () => {
    const a = await getTakesScorecard(storage.engine(), { sourceIds: [A] });
    expect(a.total_takes).toBe(2); // doc-a + doc-a2
    expect(a.correct).toBe(1);
    expect(a.incorrect).toBe(0);
    expect(a.accuracy).toBe(1); // 1 / 1

    const b = await getTakesScorecard(storage.engine(), { sourceIds: [B] });
    expect(b.total_takes).toBe(1);
    expect(b.incorrect).toBe(1);
    expect(b.accuracy).toBe(0); // 0 / 1
  });

  it("returns a zero scorecard when a tenant has no takes", async () => {
    const s = await getTakesScorecard(storage.engine(), { sourceIds: ["ghost"] });
    expect(s.total_takes).toBe(0);
    expect(s.accuracy).toBeNull();
    expect(s.brier).toBeNull();
  });
});

describe("getTakesCalibration", () => {
  it("bins decided bets by weight with observed vs predicted", async () => {
    const buckets = await getTakesCalibration(storage.engine());
    // Two decided bets: weight 0.2 (bucket [0.2,0.3), miss) + 0.8 (bucket [0.8,0.9), hit).
    // The partial take is excluded (not correct∨incorrect).
    expect(buckets.length).toBe(2);
    const lo = buckets.find((b) => b.bucket_lo > 0.15 && b.bucket_lo < 0.25);
    const hi = buckets.find((b) => b.bucket_lo > 0.75 && b.bucket_lo < 0.85);
    expect(lo?.n).toBe(1);
    expect(lo?.observed).toBe(0); // incorrect
    expect(lo?.predicted).toBeCloseTo(0.2, 5);
    expect(hi?.n).toBe(1);
    expect(hi?.observed).toBe(1); // correct
    expect(hi?.predicted).toBeCloseTo(0.8, 5);
  });

  it("scopes to one tenant", async () => {
    const a = await getTakesCalibration(storage.engine(), { sourceIds: [A] });
    // Only tenant A's decided bet (0.8, correct); the partial is not decided.
    expect(a.length).toBe(1);
    expect(a[0]?.observed).toBe(1);
  });
});

describe("getTakesScorecard holder filter (fail-closed)", () => {
  it("filters by holder and stays fail-closed against the allow-list", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
      ["doc-h", "/tenant-a/doc-h.md", "doc-h", A],
    );
    const r = await e.query<{ id: number }>(
      `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id, holder)
       VALUES ('t/h', 'doc-h', 'h', 'v1', 't/h', 'bet', 0.7, 'queued', 'fake', 'brain') RETURNING id`,
    );
    await e.query(
      `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
       VALUES ($1, 'v1', 'sig-h', 'correct', 0.9, 'fake')`,
      [r.rows[0]!.id],
    );

    const brain = await getTakesScorecard(e, { holder: "brain" });
    expect(brain.total_takes).toBe(1); // only the brain-held take

    // Fail-closed: asking for a holder outside the token allow-list → empty.
    const denied = await getTakesScorecard(e, {
      holder: "brain",
      holderAllowList: ["world"],
    });
    expect(denied.total_takes).toBe(0);
  });
});
