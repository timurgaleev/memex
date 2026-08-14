/**
 * Push-bench harness — replays a labelled fixture against the real volunteer
 * path and hands back scoreable turns plus the evidence behind them.
 *
 * Per fixture: wipe the brain, seed the fixture's pages through `putPage` (the
 * same write path the vault sync uses, so aliases and tenancy behave exactly as
 * in production), then walk the conversation turn by turn, calling
 * `volunteerContext` with a rolling window of the last N turns. Nothing is
 * mocked and nothing is stubbed: the only inputs the harness invents are the
 * window boundary and the fixture's gate/cap/scope overrides.
 *
 * WHY THE PER-TURN DIAGNOSIS EXISTS. A "should stay silent" turn only proves
 * something if the brain actually reached the injection decision and declined.
 * A turn whose text contains no entity candidates at all makes
 * `volunteerContext` return on its first guard — no resolve, no confidence
 * gate, no decision — yet it still lands in the corpus as a silent turn and
 * flatters the false-fire rate under every configuration. That number cannot
 * fail, so it cannot detect a regression. Each turn therefore reports how far
 * it got:
 *
 *   candidates  -> entity surface-forms extracted from the window
 *   pointers    -> those that resolved to a real page in the caller's scope
 *   volunteered -> those that then cleared the confidence gate and the cap
 *
 * A meaningful silence has candidates > 0; a silence that also has
 * pointers > 0 is the strongest kind — the brain found pages and chose not to
 * push them. The test asserts on this, so a corpus that quietly decays into
 * zero-candidate silences fails instead of scoring well.
 *
 * `candidates` and `pointers` are computed by calling the same pure extractor
 * and the same resolver `volunteerContext` calls, with the same arguments. They
 * mirror its internals for diagnosis only — they never feed the score, which
 * comes solely from what `volunteerContext` returned.
 *
 * What this harness does NOT tell you: whether a volunteered page HELPED. It
 * replays text a human wrote as a stand-in for a conversation, against a brain
 * of a few hand-written pages, with the window boundary handed to it rather
 * than discovered. Real windows are longer, noisier, and full of entities that
 * exist in the brain for reasons the fixture author never imagined. A green run
 * says the injection decision still behaves as labelled; it does not say the
 * push reflex is good.
 */

import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { registerSource } from "../sources.ts";
import {
  volunteerContext,
  VOLUNTEER_MAX_PAGES_CAP,
  type VolunteeredPage,
} from "../context/volunteer.ts";
import {
  extractCandidatesFromWindow,
  type WindowTurn,
} from "../context/entity-salience.ts";
import { resolveEntitiesToPointers, type ResolveArm } from "../context/reflex.ts";
import type { ScoredTurn } from "./push-metrics.ts";
import type { PushFixture, FixtureTurn } from "./fixtures.ts";
import { resetBrain } from "./reset.ts";

// The reset moved to `reset.ts` when continuity and fidelity started sharing
// it; re-exported so existing callers keep importing it from the harness.
export { RESET_TABLES, resetBrain, resetProcessGlobals, assertBrainEmpty } from "./reset.ts";

/** Rolling window used when a fixture doesn't set `windowTurns`. */
export const DEFAULT_WINDOW_TURNS = 4;

/** A pointer the resolver produced, before the gate had its say. */
export interface DiagnosticPointer {
  slug: string;
  arm: ResolveArm;
}

/** One replayed turn: the label, what the brain did, and how far it got. */
export interface BenchTurnOutcome {
  /** `<fixture>#<index>` — matches ScoredTurn.id. */
  id: string;
  fixture: string;
  index: number;
  role: WindowTurn["role"];
  text: string;
  /** Turns in the window this call actually saw (>= 1). */
  windowSize: number;
  /** Candidate query forms extracted from that window, salience-ordered. */
  candidates: string[];
  /** Pointers the resolver returned for those candidates, in the caller's scope. */
  pointers: DiagnosticPointer[];
  /** What the brain volunteered — the only field that feeds the score. */
  volunteered: VolunteeredPage[];
  gold: string[];
  acceptable: string[];
}

export interface FixtureRun {
  fixture: string;
  description: string;
  turns: BenchTurnOutcome[];
  scored: ScoredTurn[];
}

export interface CorpusRun {
  runs: FixtureRun[];
  /** Every turn of every fixture, in corpus order. */
  turns: BenchTurnOutcome[];
  /** The same turns, reduced to what `scorePush` consumes. */
  scored: ScoredTurn[];
}

/**
 * Write a fixture's seed pages. Aliases go in as `compiled_truth.aliases`.
 *
 * Any non-default source a fixture names is registered first: `pages.source_id`
 * carries a foreign key to `sources`, so a tenancy fixture cannot seed its own
 * pages without the tenant existing. Registration is idempotent and survives
 * `resetBrain` (the truncate walks dependents of `pages`, and `sources` is a
 * parent), so re-running a fixture re-registers the same rows harmlessly.
 */
export async function seedFixture(storage: Storage, fixture: PushFixture): Promise<void> {
  const sources = new Set(
    fixture.pages.map((p) => p.source ?? "default").filter((s) => s !== "default"),
  );
  for (const id of [...sources].sort()) {
    await registerSource(storage.engine(), {
      id,
      kind: "other",
      pathPrefix: `/push-bench/${id}`,
      description: `push-bench fixture tenant (${fixture.name})`,
    });
  }
  for (const p of fixture.pages) {
    await putPage(storage, {
      slug: p.slug,
      type: p.type,
      title: p.title,
      markdown_body: p.body.endsWith("\n") ? p.body : `${p.body}\n`,
      compiled_truth: p.aliases?.length ? { aliases: p.aliases } : {},
      source_id: p.source ?? "default",
    });
  }
}

function windowFor(turns: FixtureTurn[], index: number, size: number): WindowTurn[] {
  const start = Math.max(0, index + 1 - size);
  return turns.slice(start, index + 1).map((t) => ({ role: t.role, text: t.text }));
}

/**
 * Seed one fixture into a freshly reset brain and replay its conversation.
 * Read-only against the volunteer path — no events are logged, because logging
 * is the caller's job in production and a bench run is not a caller.
 */
export async function runFixture(storage: Storage, fixture: PushFixture): Promise<FixtureRun> {
  await resetBrain(storage);
  await seedFixture(storage, fixture);

  const windowTurns = fixture.windowTurns ?? DEFAULT_WINDOW_TURNS;
  const scope =
    fixture.sourceIds && fixture.sourceIds.length > 0 ? { sourceIds: fixture.sourceIds } : {};

  const turns: BenchTurnOutcome[] = [];
  for (let i = 0; i < fixture.turns.length; i++) {
    const labelled = fixture.turns[i]!;
    const window = windowFor(fixture.turns, i, windowTurns);

    const volunteered = await volunteerContext(storage, {
      window,
      ...(fixture.maxPages !== undefined ? { maxPages: fixture.maxPages } : {}),
      ...(fixture.minConfidence !== undefined ? { minConfidence: fixture.minConfidence } : {}),
      ...scope,
    });

    // Diagnosis only — mirrors volunteerContext's first two stages with its
    // own arguments so a silent turn can be told apart from a turn that never
    // reached the decision. Neither value feeds `scored` below.
    const candidates = extractCandidatesFromWindow(window);
    const pointers = candidates.length
      ? await resolveEntitiesToPointers(storage, candidates, {
          maxPointers: VOLUNTEER_MAX_PAGES_CAP * 2,
          ...scope,
        })
      : [];

    turns.push({
      id: `${fixture.name}#${i}`,
      fixture: fixture.name,
      index: i,
      role: labelled.role,
      text: labelled.text,
      windowSize: window.length,
      candidates: candidates.map((c) => c.query),
      pointers: pointers.map((p) => ({ slug: p.slug, arm: p.arm })),
      volunteered,
      gold: labelled.gold,
      acceptable: labelled.acceptable ?? [],
    });
  }

  return {
    fixture: fixture.name,
    description: fixture.description,
    turns,
    scored: turns.map(toScoredTurn),
  };
}

/** Reduce a replayed turn to the three fields `scorePush` reads. */
export function toScoredTurn(t: BenchTurnOutcome): ScoredTurn {
  return {
    id: t.id,
    gold: t.gold,
    ...(t.acceptable.length ? { acceptable: t.acceptable } : {}),
    injected: t.volunteered.map((v) => v.slug),
  };
}

/** Replay a whole corpus on one Storage, in the order given. */
export async function runCorpus(
  storage: Storage,
  fixtures: readonly PushFixture[],
): Promise<CorpusRun> {
  const runs: FixtureRun[] = [];
  for (const f of fixtures) runs.push(await runFixture(storage, f));
  const turns = runs.flatMap((r) => r.turns);
  return { runs, turns, scored: turns.map(toScoredTurn) };
}
