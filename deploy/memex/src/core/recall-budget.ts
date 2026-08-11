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
 * whatever it does not use flows to the others, so a thin page does not waste
 * the budget an entity with many facts could have used.
 *
 * Facts get the largest share deliberately: they ARE the answer to the
 * question, and they are the densest per token. The page body is the easiest
 * thing to over-read and the easiest to re-fetch with `page_get` when the
 * caller decides it wants the whole thing.
 */
import { estTokens } from "./search/token-budget.ts";

/** Starting shares. They sum to 1; unused allocation is redistributed. */
const FACT_SHARE = 0.5;
const TIMELINE_SHARE = 0.2;
/** The page takes the remainder (0.3) plus anything the other arms leave. */

export interface RecallArms<F, T> {
  page: { markdown_body?: string | null } | null;
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
      report: { facts_dropped: 0, timeline_dropped: 0, page_truncated: false },
    };
  }

  const facts = takeWhileFits(arms.facts, Math.floor(budget * FACT_SHARE), rowCost);
  const timeline = takeWhileFits(
    arms.timeline,
    Math.floor(budget * TIMELINE_SHARE),
    rowCost,
  );

  // Whatever the fact and timeline arms left over belongs to the page. The page
  // is charged serialized too, so its own metadata competes with its body.
  const pageRoom = Math.max(0, budget - facts.spent - timeline.spent);
  let page = arms.page;
  let pageTruncated = false;
  const body = arms.page?.markdown_body;
  if (arms.page !== null && rowCost(arms.page) > pageRoom) {
    if (typeof body === "string" && body.length > 0) {
      // Room for the body is what is left after the rest of the row is paid
      // for. The ellipsis costs a character, so slice one short of the budget
      // rather than one over it.
      const overhead = rowCost({ ...arms.page, markdown_body: "" });
      const bodyChars = Math.max(0, (pageRoom - overhead) * 4 - 1);
      page = {
        ...arms.page,
        markdown_body: bodyChars > 0 ? `${body.slice(0, bodyChars).trimEnd()}…` : "",
      };
    }
    pageTruncated = true;
  }

  return {
    page,
    facts: facts.kept,
    timeline: timeline.kept,
    report: {
      facts_dropped: facts.dropped,
      timeline_dropped: timeline.dropped,
      page_truncated: pageTruncated,
    },
  };
}
