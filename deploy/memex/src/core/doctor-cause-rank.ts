/**
 * Cause-ranked doctor issues.
 *
 * `memex doctor` is the single health truth. When several checks fail at once
 * the operator wants to read the ROOT first, not scroll a flat list where the
 * one true cause is buried among its downstream symptoms.
 *
 * HONESTY CONTRACT: two checks both failing does NOT prove one caused the
 * other. `tier` is an ORDERING bucket only ('root' = on the designated
 * root-cause list; 'symptom' = not on it). The only causal claim this module
 * makes is `downstream_of`, and it is set ONLY for a KNOWN causal edge AND
 * ONLY when the named root is itself failing — so the annotation never invents
 * a cause that isn't actually broken.
 *
 * memex's checks mostly cascade by SKIPPING (a failed `config` means `pglite`
 * never runs), so co-failures are rarer than in a fan-out system — but the
 * ranking still surfaces config/DB roots ahead of independent ops checks, and
 * the cause graph is future-proof as more independent checks are added.
 */

export interface RankableCheck {
  name: string;
  ok: boolean;
}

export interface RankedIssue {
  name: string;
  /** 'root' = a designated root-cause check; 'symptom' = everything else. */
  tier: "root" | "symptom";
  /**
   * Set ONLY for a known causal edge whose root is ALSO failing. Absent
   * otherwise — never a speculative claim.
   */
  downstream_of?: string;
}

/**
 * Checks that, when they fail, are a likely upstream root cause. `config`
 * (missing/invalid config) and `pglite` (the storage engine won't open) gate
 * everything downstream of them.
 */
export const ROOT_CAUSE_CHECKS: ReadonlySet<string> = new Set([
  "config",
  "pglite",
]);

/**
 * KNOWN causal edges (downstream check → its root). `downstream_of` is set
 * from this map ONLY when the named root is itself failing. Each edge is a
 * real dependency: the storage engine needs a valid config; the data checks
 * need an open engine.
 */
const DOWNSTREAM_EDGES: Readonly<Record<string, string>> = Object.freeze({
  pglite: "config",
  stats: "pglite",
  "index-spread": "pglite",
});

// Note: `pglite` wears both hats — it is a root (ROOT_CAUSE_CHECKS) AND a
// downstream of `config` (DOWNSTREAM_EDGES). That is consistent: `tier` is the
// ordering bucket (pglite sorts as a root), while `downstream_of` is the
// causal edge (set to 'config' only when config is also failing).
function tierOf(name: string): "root" | "symptom" {
  return ROOT_CAUSE_CHECKS.has(name) ? "root" : "symptom";
}

/**
 * Rank the non-ok checks: root before symptom, then alphabetical by name.
 * Returns only the failing checks. Ordering only — not a causal claim beyond
 * the `downstream_of` edges, which are gated on the root also failing.
 */
export function rankIssues(checks: readonly RankableCheck[]): RankedIssue[] {
  const failing = checks.filter((c) => !c.ok);
  const failingNames = new Set(failing.map((c) => c.name));

  const issues: RankedIssue[] = failing.map((c) => {
    const root = DOWNSTREAM_EDGES[c.name];
    const downstream_of = root && failingNames.has(root) ? root : undefined;
    return {
      name: c.name,
      tier: tierOf(c.name),
      ...(downstream_of ? { downstream_of } : {}),
    };
  });

  const tierRank = (t: "root" | "symptom"): number => (t === "root" ? 0 : 1);
  return issues.sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name),
  );
}
