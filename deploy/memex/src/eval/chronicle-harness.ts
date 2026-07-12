/**
 * Life Chronicle feature eval — deterministic, CI-safe, zero-LLM.
 *
 * Builds a small synthetic month corpus with a KNOWN gold chronology, a planted
 * ontology supersession, and a planted standing conflict, then asserts the
 * chronicle layer answers the temporal/longitudinal questions correctly. The
 * extractor runs with an injected stub judge, so no gateway is touched. A raw
 * meeting corpus structurally cannot order intra-day events or time-travel a
 * dimension; the chronicle ops can — and a perfect score is the proof they do.
 *
 * The caller supplies a migrated Storage (an in-memory PGLite for both the CLI
 * command and the Bun test), so the harness owns only the seed + the scoring.
 */
import type { Storage } from "../core/storage.ts";
import { putPage } from "../core/pages.ts";
import {
  runChronicleExtract,
  type ChronicleJudge,
} from "../core/chronicle/extract-events.ts";
import { valueHash } from "../core/chronicle/ontology.ts";
import { mergeOntologyFact } from "../core/ontology-facts.ts";
import {
  getTimelineForDate,
  getLastSeen,
} from "../core/chronicle.ts";
import { getOntology, findOntologyConflicts } from "../core/ontology-facts.ts";

export interface ChronicleEvalTask {
  id: string;
  passed: boolean;
  detail: string;
}
export interface ChronicleEvalResult {
  tasks: ChronicleEvalTask[];
  passed: number;
  total: number;
  /** passed / total, in [0,1]. */
  score: number;
}

const ALICE = "people/alice-example";
const BOB = "people/bob-example";
const LONG_BODY = "x".repeat(120);

/** A judge that emits one fixed event, ignoring its input (no gateway). */
function fixedJudge(when: string, what: string): ChronicleJudge {
  return async () => ({
    events: [{ when, who: [ALICE], what, kind: "meeting" }],
  });
}

/** Insert a genuine open observation directly. The merge path supersedes a
 *  different value forward (one open row survives), so a *standing* conflict —
 *  two open values from two sources — is seeded at the row level, matching how
 *  the ontology unit tests exercise the conflict detector. */
async function seedOpenObservation(
  storage: Storage,
  entity: string,
  value: string,
  sourceSlug: string,
): Promise<void> {
  await storage.engine().query(
    `INSERT INTO entity_facts
       (entity_slug, fact, kind, visibility, dimension, value, value_hash,
        confidence, source_slug, valid_from, source_id)
     VALUES ($1, $2, 'fact', 'private', 'role', $3, $4, 0.8, $5, '2026-06-01'::date, 'default')`,
    [entity, `role: ${value}`, value, valueHash(value), sourceSlug],
  );
}

/** Seed the synthetic corpus into a fresh, migrated Storage. */
export async function seedChronicleEvalCorpus(storage: Storage): Promise<void> {
  // Two same-day meetings → two events; gold intra-day order is AM then PM.
  await putPage(storage, {
    slug: "meetings/2026-03-02-am",
    type: "meeting",
    title: "Morning standup",
    compiled_truth: { date: "2026-03-02", attendees: [ALICE] },
    markdown_body: LONG_BODY,
  });
  await putPage(storage, {
    slug: "meetings/2026-03-02-pm",
    type: "meeting",
    title: "Afternoon review",
    compiled_truth: { date: "2026-03-02", attendees: [ALICE] },
    markdown_body: LONG_BODY,
  });
  // Extract AM before PM so the equal-day projections order by insertion id.
  await runChronicleExtract(storage, {
    slug: "meetings/2026-03-02-am",
    sourceId: "default",
    judge: fixedJudge("2026-03-02T09:00:00Z", "Morning standup"),
  });
  await runChronicleExtract(storage, {
    slug: "meetings/2026-03-02-pm",
    sourceId: "default",
    judge: fixedJudge("2026-03-02T15:00:00Z", "Afternoon review"),
  });

  // Ontology: alice was a founder, then became an advisor (forward supersession).
  await mergeOntologyFact(storage, {
    entitySlug: ALICE, dimension: "role", value: "founder",
    source_slug: "meetings/2024-01-10", sourceId: "default", validFrom: "2024-01-01",
  });
  await mergeOntologyFact(storage, {
    entitySlug: ALICE, dimension: "role", value: "advisor",
    source_slug: "meetings/2026-03-02-pm", sourceId: "default", validFrom: "2026-03-01",
  });

  // Planted standing conflict: bob has two open role values from two sources.
  await seedOpenObservation(storage, BOB, "advisor", "meetings/a");
  await seedOpenObservation(storage, BOB, "founder", "meetings/b");
}

/** Run the six chronicle tasks against a seeded corpus. */
export async function runChronicleEval(
  storage: Storage,
): Promise<ChronicleEvalResult> {
  await seedChronicleEvalCorpus(storage);
  const tasks: ChronicleEvalTask[] = [];
  const check = (id: string, ok: boolean, detail: string) =>
    tasks.push({ id, passed: ok, detail });
  const scope = { sourceIds: ["default"] as const };

  // 1. Day reconstruction, correct intra-day order.
  const day = await getTimelineForDate(storage, "2026-03-02", scope);
  const order = day.map((r) => r.summary);
  check(
    "day_order",
    JSON.stringify(order) === JSON.stringify(["Morning standup", "Afternoon review"]),
    `order=${JSON.stringify(order)}`,
  );

  // 2. Last-seen exact date.
  const ls = await getLastSeen(storage, ALICE, { sourceIds: ["default"] });
  check("last_seen", ls.last_date === "2026-03-02", `last_date=${ls.last_date}`);

  // 3. Supersession: the current value is the new one.
  const now = await getOntology(storage, ALICE, scope);
  const roleNow = now.find((v) => v.dimension === "role")?.value;
  check("supersession_now", roleNow === "advisor", `role_now=${roleNow}`);

  // 4. Valid-time travel: as-of before the change returns the prior value.
  const past = await getOntology(storage, ALICE, { ...scope, asof: "2025-01-01" });
  const rolePast = past.find((v) => v.dimension === "role")?.value;
  check("supersession_asof", rolePast === "founder", `role_asof=${rolePast}`);

  // 5. Contradiction surfaced (genuine disagreement, not supersession).
  const conflicts = await findOntologyConflicts(storage, { sourceIds: ["default"] });
  check(
    "conflict_surfaced",
    conflicts.some((c) => c.entity_slug === BOB && c.dimension === "role"),
    `conflicts=${conflicts.length}`,
  );

  // 6. Source isolation: another tenant sees nothing of tenant A.
  const otherOntology = await getOntology(storage, ALICE, { sourceIds: ["tenant-b"] });
  const otherDay = await getTimelineForDate(storage, "2026-03-02", { sourceIds: ["tenant-b"] });
  check(
    "source_isolation",
    otherOntology.length === 0 && otherDay.length === 0,
    `leaked_ontology=${otherOntology.length} leaked_timeline=${otherDay.length}`,
  );

  const passed = tasks.filter((t) => t.passed).length;
  return { tasks, passed, total: tasks.length, score: tasks.length ? passed / tasks.length : 0 };
}
