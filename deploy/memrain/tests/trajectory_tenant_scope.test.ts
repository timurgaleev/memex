/**
 * Trajectory scope — the fence `think`'s trajectory gather now relies on.
 *
 * `findTrajectory` merges an entity's `entity_facts` ledger with its
 * `timeline_events`: free text, not just row existence. `think` renders that
 * straight into the synthesis prompt, so an unscoped gather hands one tenant
 * another tenant's actual words back inside the answer. The gather was the only
 * one of six in `synthesis/think.ts` that never received the caller's read set;
 * these tests pin the filter it now passes through.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { findTrajectory } from "../src/core/insights.ts";

const A = "tenant-a";
const B = "tenant-b";
const SLUG = "people/scope-victim";
const SECRET = "PANGOLIN-CONFIDENTIAL";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-traj-scope-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: A, kind: "other", pathPrefix: "tenant:a" });
  await registerSource(e, { id: B, kind: "other", pathPrefix: "tenant:b" });

  await putPage(storage, {
    slug: SLUG,
    type: "person",
    markdown_body: "victim page",
    source_id: A,
  });
  await addFact(storage, {
    entity_slug: SLUG,
    fact: `${SECRET} board compensation decision`,
    visibility: "world",
    source_id: A,
  } as never);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("findTrajectory tenant scope", () => {
  it("the owning tenant sees its own trajectory text", async () => {
    const points = await findTrajectory(storage, SLUG, { sourceIds: [A] });
    expect(JSON.stringify(points)).toContain(SECRET);
  });

  it("another tenant sees nothing for the same anchor", async () => {
    const points = await findTrajectory(storage, SLUG, { sourceIds: [B] });
    expect(JSON.stringify(points)).not.toContain(SECRET);
    expect(points).toEqual([]);
  });

  it("an unscoped caller (local CLI / operator) still sees everything", async () => {
    // Back-compat: `sourceIds` omitted means whole-brain, which is what the
    // operator path and every pre-tenancy caller expects.
    const points = await findTrajectory(storage, SLUG, {});
    expect(JSON.stringify(points)).toContain(SECRET);
  });

  it("an EMPTY scope array reads nothing, not everything", async () => {
    // A caller granted no source must not out-read a caller granted one.
    // `normalizeSourceIds` used to fold [] into "unscoped", so the predicate
    // was dropped and every insight surface answered from the whole brain.
    // Now the predicate stays on and `= ANY('{}')` matches no row.
    const points = await findTrajectory(storage, SLUG, { sourceIds: [] });
    expect(JSON.stringify(points)).not.toContain(SECRET);
    expect(points).toEqual([]);
  });
});
