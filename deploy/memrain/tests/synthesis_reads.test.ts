/**
 * Synthesis read accessors (list_concepts / list_takes / get_calibration_profile
 * backing). Offline PGLite; migration 045 creates the synth_* tables.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  listConcepts,
  listTakes,
  getCalibrationProfile,
} from "../src/core/synthesis/reads.ts";

const dbDir = mkdtempSync(join(tmpdir(), "tb-synth-reads-"));
let storage: Storage;

beforeAll(async () => {
  storage = new Storage({ dbPath: join(dbDir, "brain.pglite") });
  await storage.init();
  const e = storage.engine();
  await e.query(
    `INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, model_id)
     VALUES ('c/alpha','Alpha','about alpha','T1',5,'fake'),
            ('c/beta','Beta','about beta','T3',2,'fake')`,
  );
  await e.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
     VALUES ('t/1','doc_1','h','v1','alpha is good','judgment',0.7,'queued','fake'),
            ('t/2','doc_2','h','v1','beta is bad','judgment',0.3,'accepted','fake')`,
  );
  await e.query(
    `INSERT INTO synth_calibration_profile (total_graded, correct, incorrect, partial, unresolvable, accuracy, model_id)
     VALUES (10, 7, 2, 1, 0, 0.7, 'fake')`,
  );
});

afterAll(async () => {
  await storage.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("listConcepts", () => {
  it("returns concepts ordered by atom_count DESC", async () => {
    const c = await listConcepts(storage.engine());
    expect(c.length).toBe(2);
    expect(c[0]?.concept_slug).toBe("c/alpha"); // atom_count 5 > 2
    expect(c[0]?.tier).toBe("T1");
  });
  it("clamps the limit", async () => {
    const c = await listConcepts(storage.engine(), 1);
    expect(c.length).toBe(1);
  });
});

describe("listTakes", () => {
  it("lists all takes", async () => {
    const t = await listTakes(storage.engine());
    expect(t.length).toBe(2);
  });
  it("filters by status", async () => {
    const t = await listTakes(storage.engine(), { status: "accepted" });
    expect(t.length).toBe(1);
    expect(t[0]?.take_key).toBe("t/2");
  });
});

describe("getCalibrationProfile", () => {
  it("returns the latest profile", async () => {
    const p = await getCalibrationProfile(storage.engine());
    expect(p?.total_graded).toBe(10);
    expect(p?.accuracy).toBeCloseTo(0.7, 5);
  });
});
