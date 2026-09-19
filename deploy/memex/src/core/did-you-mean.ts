/**
 * "Did you mean" for a typo — the closest candidate at most two edits away.
 *
 * The distance is Levenshtein, but it bails out before building the table when
 * the lengths differ by more than 2: such a pair can never be within the cap,
 * and the early exit is what keeps a hostile, very long input from costing
 * length × length work against every candidate.
 */
export function nearest(input: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const known of candidates) {
    const d = editDistance(input, known);
    if (d < bestD) {
      bestD = d;
      best = known;
    }
  }
  return best;
}

export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from<number>({ length: b.length + 1 }).fill(0);
  const cur = Array.from<number>({ length: b.length + 1 }).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}
