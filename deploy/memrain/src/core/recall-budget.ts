/**
 * Splitting one token budget across the arms of an entity recall.
 *
 * `entity_recall` answers "what do I know about X?" with three things at once:
 * the entity's page, its facts, and its recent timeline. A caller working under
 * a context budget could cap none of them — `search.token_budget` covers chunk
 * content only — so it had to guess the split itself, fetch, measure, and call
 * again. Guessing is the part worth removing: the server knows the sizes.
 *
 * The split is a starting allocation, not a quota. Each arm gets a share, and
 * whatever it does not use flows to the arms that do have content, so an entity
 * that is all facts — the common shape — spends the whole budget on facts
 * instead of stranding the page and timeline allocations it has no use for.
 *
 * Facts get the largest share deliberately: they ARE the answer to the
 * question, and they are the densest per token. The page body is the easiest
 * thing to over-read and the easiest to re-fetch with `page_get` when the
 * caller decides it wants the whole thing.
 *
 * The cap is enforced, not estimated: every arm is charged what it serializes
 * to, and the page is measured after trimming rather than predicted before it,
 * so the number the caller sized its context window around holds.
 */
import { estTokens } from "./search/token-budget.ts";

/** Starting shares — floors, not quotas. Slack is redistributed below. */
const FACT_SHARE = 0.5;
const TIMELINE_SHARE = 0.2;
/** The page takes the remainder (0.3) plus anything the other arms leave. */

/** The part of the page row this module has to reason about. */
type PageArm = { markdown_body?: string | null };

export interface RecallArms<F, T> {
  page: PageArm | null;
  facts: F[];
  timeline: T[];
}

export interface RecallBudgetReport {
  /** Facts dropped to fit. */
  facts_dropped: number;
  /** Timeline events dropped to fit. */
  timeline_dropped: number;
  /** True when the page body was cut short. */
  page_truncated: boolean;
  /**
   * True when the page did not fit at all and was left out. `page: null` then
   * means "did not fit", not "this entity has no page yet" — a caller reading
   * only `page_truncated` would take a budget casualty for a soft-stub.
   */
  page_dropped: boolean;
}

/**
 * What a row costs the caller: its SERIALIZED size, not just its headline text.
 *
 * Charging only `fact` / `event` made the cap a promise the code could not
 * keep — a fact carries an unbounded `context`, a timeline row a `detail`, and
 * those ride along uncharged. A 10-token budget could return a one-character
 * fact with a 100k-character context attached.
 */
const rowCost = (row: unknown): number => estTokens(JSON.stringify(row) ?? "");

/** Take whole items in order while they fit; report what did not. */
function takeWhileFits<T>(
  items: readonly T[],
  budget: number,
  cost: (item: T) => number,
): { kept: T[]; spent: number; dropped: number } {
  const kept: T[] = [];
  let spent = 0;
  for (const item of items) {
    const c = cost(item);
    if (spent + c > budget) break;
    kept.push(item);
    spent += c;
  }
  return { kept, spent, dropped: items.length - kept.length };
}

/** The first `chars` of the body, marked as cut when it really was cut. */
const cutBody = (body: string, chars: number): string => {
  if (chars <= 0) return "";
  if (chars >= body.length) return body;
  return `${body.slice(0, chars).trimEnd()}…`;
};

interface FittedPage {
  page: PageArm | null;
  spent: number;
  truncated: boolean;
  dropped: boolean;
}

/**
 * Fit the page row into `room`, MEASURING the result instead of predicting it.
 *
 * Deriving a character count from the token budget is not enough: JSON escaping
 * is not 1:1, so a body of quotes or newlines serializes to twice the
 * characters it was charged for and the cap silently breaks on exactly the
 * documents most likely to be pages. Binary-search the longest prefix whose
 * serialized row fits instead — cost is monotone in the prefix length, so the
 * search lands on the exact answer.
 */
function fitPage(page: PageArm | null, room: number): FittedPage {
  if (page === null) {
    return { page: null, spent: 0, truncated: false, dropped: false };
  }
  const whole = rowCost(page);
  if (whole <= room) {
    return { page, spent: whole, truncated: false, dropped: false };
  }

  const body = page.markdown_body;
  const withBody = (b: string): PageArm => ({ ...page, markdown_body: b });
  // The stripped row is the floor: if the row's own metadata already overflows,
  // no prefix of the body can rescue it.
  if (typeof body === "string" && body.length > 0 && rowCost(withBody("")) <= room) {
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (rowCost(withBody(cutBody(body, mid))) <= room) lo = mid;
      else hi = mid - 1;
    }
    const trimmed = withBody(cutBody(body, lo));
    return { page: trimmed, spent: rowCost(trimmed), truncated: true, dropped: false };
  }

  // Nothing left to cut and it still does not fit — a redacted page, or a
  // budget smaller than the row's own metadata. Leave it out and say so rather
  // than overshooting: unlike `applyTokenBudget`'s always-return-one-hit rule
  // for search, this cap is advertised as covering the WHOLE response, and the
  // other two arms usually still carry the answer.
  return { page: null, spent: 0, truncated: false, dropped: true };
}

/**
 * Trim the three arms to fit `budget` total tokens.
 *
 * Returns the trimmed arms and a report of what was cut — a caller that cannot
 * see the difference between "this is everything" and "this is what fit" would
 * treat a partial answer as complete, which is the failure this exists to
 * prevent.
 */
export function applyRecallBudget<
  F extends Record<string, unknown>,
  T extends Record<string, unknown>,
>(
  arms: RecallArms<F, T>,
  budget: number,
): { page: RecallArms<F, T>["page"]; facts: F[]; timeline: T[]; report: RecallBudgetReport } {
  if (!Number.isFinite(budget) || budget <= 0) {
    return {
      page: arms.page,
      facts: arms.facts,
      timeline: arms.timeline,
      report: {
        facts_dropped: 0,
        timeline_dropped: 0,
        page_truncated: false,
        page_dropped: false,
      },
    };
  }

  // Pass 1 — each item arm inside its own share.
  let facts = takeWhileFits(arms.facts, Math.floor(budget * FACT_SHARE), rowCost);
  let timeline = takeWhileFits(
    arms.timeline,
    Math.floor(budget * TIMELINE_SHARE),
    rowCost,
  );

  // The page absorbs the slack the item arms left, because it is the arm that
  // degrades gracefully: a shorter body is still a body, where an item arm can
  // only drop whole rows. It is charged serialized too, so its own metadata
  // competes with its body.
  const page = fitPage(arms.page, Math.max(0, budget - facts.spent - timeline.spent));

  // Pass 2 — whatever the page could not use flows back, facts first. Without
  // this an entity that is all facts answers with half the budget the caller
  // paid for and strands the other half in arms that have no content.
  let free = budget - facts.spent - timeline.spent - page.spent;
  if (free > 0 && facts.dropped > 0) {
    facts = takeWhileFits(arms.facts, facts.spent + free, rowCost);
    free = budget - facts.spent - timeline.spent - page.spent;
  }
  if (free > 0 && timeline.dropped > 0) {
    timeline = takeWhileFits(arms.timeline, timeline.spent + free, rowCost);
  }

  return {
    page: page.page,
    facts: facts.kept,
    timeline: timeline.kept,
    report: {
      facts_dropped: facts.dropped,
      timeline_dropped: timeline.dropped,
      page_truncated: page.truncated,
      page_dropped: page.dropped,
    },
  };
}
