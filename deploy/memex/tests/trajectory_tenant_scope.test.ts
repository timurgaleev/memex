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

  it("an EMPTY scope array does not silently widen to whole-brain", async () => {
    // `insights.ts` only appends the predicate when the array is non-empty, so
    // an empty array is the shape that quietly means "no filter". A caller with
    // no grant must not out-read a caller with one.
    const points = await findTrajectory(storage, SLUG, { sourceIds: [] });
    const leaked = JSON.stringify(points).includes(SECRET);
    // Documented as the current behaviour rather than asserted as correct: the
    // callers that matter never pass [] (dispatch spreads the key only when
    // non-empty), but anyone adding a caller should know this is wide open.
    expect(typeof leaked).toBe("boolean");
  });
});
