/**
 * Rule judge for routing answers, plus the arithmetic of the validation gate.
 *
 * The model is asked for a bare slug, but model text is untrusted: it is
 * clipped, its first token is taken with indexOf, wrapping quotes and
 * punctuation are peeled off one character at a time, and the only pattern
 * that ever runs is the bounded slug grammar on a token of at most 64 chars.
 */
import type { RoutingCase } from "./benchmark.ts";
import { isSkillSlug } from "./benchmark.ts";

export type Verdict = "exact" | "ambiguous_alt" | "wrong" | "unparsed";

/** The answer for a request no skill fits: what a negative case expects. */
export const NO_SKILL = "none";

/** Far more than a 32-token answer can hold; the rest is never looked at. */
const MAX_ANSWER_SCAN = 512;
const WRAPPERS = new Set(["`", "'", '"', "*", "_", ".", ",", ":", ";", "!", "?", "(", ")", "[", "]", "<", ">"]);

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

function firstToken(text: string): { token: string; rest: string } {
  let start = 0;
  while (start < text.length && isSpace(text[start]!)) start++;
  let end = start;
  while (end < text.length && !isSpace(text[end]!)) end++;
  return { token: text.slice(start, end), rest: text.slice(end).trim() };
}

function peel(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && WRAPPERS.has(token[a]!)) a++;
  while (b > a && WRAPPERS.has(token[b - 1]!)) b--;
  return token.slice(a, b);
}

/**
 * The slug an answer names (or NO_SKILL), or null. A lone token that is not
 * a catalog slug is still returned (the model picked something that does not
 * exist); prose that does not open with a catalog slug is not an answer.
 */
export function parseAnswer(answer: string, catalogSlugs: ReadonlySet<string>): string | null {
  const { token, rest } = firstToken(answer.slice(0, MAX_ANSWER_SCAN));
  const slug = peel(token).toLowerCase();
  if (!isSkillSlug(slug)) return null;
  if (catalogSlugs.has(slug) || slug === NO_SKILL) return slug;
  return rest.length === 0 ? slug : null;
}

export function judge(
  answer: string,
  c: Pick<RoutingCase, "expected_skill" | "ambiguous_with">,
  catalogSlugs: ReadonlySet<string>,
): { verdict: Verdict; picked: string | null } {
  const picked = parseAnswer(answer, catalogSlugs);
  if (picked === null) return { verdict: "unparsed", picked };
  if (picked === (c.expected_skill ?? NO_SKILL)) return { verdict: "exact", picked };
  if (c.ambiguous_with.includes(picked)) return { verdict: "ambiguous_alt", picked };
  return { verdict: "wrong", picked };
}

/** Median of the per-repeat scores (mean of the middle two for an even count); 0 when empty. */
export function median3(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface GateResult {
  accept: boolean;
  delta: number;
  baselineMedian: number;
  candidateMedian: number;
}

/** Accept only an improvement strictly beyond epsilon on the medians. */
export function gate(
  baseline: readonly number[],
  candidate: readonly number[],
  epsilon: number,
): GateResult {
  const baselineMedian = median3(baseline);
  const candidateMedian = median3(candidate);
  const delta = candidateMedian - baselineMedian;
  // The tolerance keeps a float residue (0.55 - 0.5 = 0.05000000000000004)
  // from turning an improvement of exactly epsilon into an accept.
  return { accept: delta - epsilon > 1e-9, delta, baselineMedian, candidateMedian };
}
