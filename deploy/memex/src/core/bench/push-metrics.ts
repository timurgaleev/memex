/**
 * Scoring what the brain volunteers.
 *
 * The retrieval eval already answers "when asked, does search find it?".
 * Nothing answered the question an agent actually experiences: when nobody
 * asked, did the brain offer the right pages — and did it keep quiet when it
 * had nothing worth saying?
 *
 * Four numbers, and one of them exists to stop the others being gamed:
 *
 *   precision  of everything volunteered, how much was wanted
 *   recall     of everything wanted, how much was volunteered
 *   miss rate  of turns where something SHOULD have surfaced, how often
 *              nothing did
 *   false fire of turns where the brain should have stayed SILENT, how often
 *              it spoke anyway
 *
 * Without the last one, "volunteer everything, always" scores a perfect recall
 * and a perfect miss rate. It is the metric that makes the others mean
 * something, so it is not optional and it is reported next to them.
 *
 * Two deliberate asymmetries, both borrowed from how the push reflex itself is
 * tuned (push noise is worse than pull silence):
 *
 *   - `acceptable` slugs count for precision but NOT for recall. Volunteering
 *     a defensible-but-not-required page is not noise, yet it cannot be used
 *     to claim coverage nobody asked for.
 *   - Micro-averaging, not a mean of per-turn rates. A turn wanting three
 *     pages weighs three times a turn wanting one, because that is what a
 *     context budget actually pays.
 *
 * What a number here does NOT tell you: whether the volunteered page was
 * USEFUL. It measures agreement with a human's labels on a small corpus, so it
 * catches a regression in the injection decision — not the value of the answer
 * that followed.
 */

/** One replayed turn: what was labelled, and what the brain actually offered. */
export interface ScoredTurn {
  /** Fixture + index, for reporting which turn moved. */
  id: string;
  /** Slugs a human says MUST surface here. Empty means "stay silent". */
  gold: string[];
  /** Slugs that are defensible if offered, but not required. */
  acceptable?: string[];
  /** What the brain volunteered. */
  injected: string[];
}

export interface PushScores {
  turns: number;
  /** Turns whose gold set is non-empty. */
  shouldSpeak: number;
  /** Turns whose gold set is empty — the silence cases. */
  shouldStaySilent: number;
  precision: number | null;
  recall: number | null;
  /** Of shouldSpeak turns, the fraction where nothing gold or acceptable came. */
  missRate: number | null;
  /** Of shouldStaySilent turns, the fraction where anything was volunteered. */
  falseFireRate: number | null;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Score a set of replayed turns.
 *
 * A rate over zero turns is `null`, never 0 or 1: reporting "0% false fire"
 * for a corpus with no silence cases would read as a passing grade for a test
 * that was never run.
 */
export function scorePush(turns: readonly ScoredTurn[]): PushScores {
  let injectedTotal = 0;
  let injectedWanted = 0;
  let goldTotal = 0;
  let goldHit = 0;
  let shouldSpeak = 0;
  let missed = 0;
  let shouldStaySilent = 0;
  let falseFired = 0;

  for (const t of turns) {
    const gold = new Set(t.gold);
    const acceptable = new Set(t.acceptable ?? []);
    const injected = new Set(t.injected);

    injectedTotal += injected.size;
    for (const slug of injected) {
      if (gold.has(slug) || acceptable.has(slug)) injectedWanted += 1;
    }

    if (gold.size > 0) {
      shouldSpeak += 1;
      goldTotal += gold.size;
      let hits = 0;
      for (const slug of gold) if (injected.has(slug)) hits += 1;
      goldHit += hits;
      // A turn counts as missed only when NOTHING wanted came back. Partial
      // coverage is a recall shortfall, not a miss — recall already says so,
      // and counting it twice would make one failure look like two.
      const anyWanted =
        hits > 0 || [...injected].some((s) => acceptable.has(s));
      if (!anyWanted) missed += 1;
    } else {
      shouldStaySilent += 1;
      if (injected.size > 0) falseFired += 1;
    }
  }

  return {
    turns: turns.length,
    shouldSpeak,
    shouldStaySilent,
    precision: injectedTotal === 0 ? null : round(injectedWanted / injectedTotal),
    recall: goldTotal === 0 ? null : round(goldHit / goldTotal),
    missRate: shouldSpeak === 0 ? null : round(missed / shouldSpeak),
    falseFireRate:
      shouldStaySilent === 0 ? null : round(falseFired / shouldStaySilent),
  };
}

/** One line per run, for a human reading a diff between two runs. */
export function formatScores(label: string, s: PushScores): string {
  const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  return (
    `${label}: turns=${s.turns} speak=${s.shouldSpeak} silent=${s.shouldStaySilent} ` +
    `precision=${pct(s.precision)} recall=${pct(s.recall)} ` +
    `miss=${pct(s.missRate)} false_fire=${pct(s.falseFireRate)}`
  );
}
