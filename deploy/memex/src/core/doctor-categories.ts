/**
 * Doctor check categorization — single source of truth.
 *
 * Every `memex doctor` check belongs to exactly one category so the report
 * answers the question the operator is actually asking:
 *
 *   - brain : data-integrity signals — "is the brain's actual data healthy?"
 *             (index counts, index-freshness spread)
 *   - ops   : infrastructure / setup — "can the brain even run here?"
 *             (config present + parses, DB engine opens, vault path readable)
 *   - meta  : the doctor / runtime itself; the fallthrough bucket.
 *
 * memex is brain-only, so the reference's fourth `skill` category (agent skill
 * dispatcher) is intentionally absent — there is no skill layer to diagnose.
 *
 * Drift contract: every check name that ships in `commands/doctor.ts` MUST
 * appear in exactly one set below. `tests/doctor_categories.test.ts` enforces
 * this. If you add a doctor check, add its name here too — `categorize()`
 * falls through to 'meta' for an unknown name and emits a once-per-process
 * stderr warning so a missing addition surfaces in dev runs before CI.
 */

export type CheckCategory = "brain" | "ops" | "meta";

/** Data-integrity signals — "is the brain's actual data healthy?" */
export const BRAIN_CHECK_NAMES: ReadonlySet<string> = new Set([
  "stats",
  "index-spread",
  "source-health",
  "links-extraction-lag",
  "chunker-version-lag",
  "cycle-freshness",
  "per-source-embed-coverage",
]);

/** Infrastructure / setup — "can the brain run here at all?" */
export const OPS_CHECK_NAMES: ReadonlySet<string> = new Set([
  "config",
  "pglite",
  "vault",
]);

/** The doctor / runtime itself. Empty today; the fallthrough bucket. */
export const META_CHECK_NAMES: ReadonlySet<string> = new Set<string>([]);

/** Union of every categorized name — the drift-guard comparison set. */
export const KNOWN_CHECK_NAMES: ReadonlySet<string> = new Set<string>([
  ...BRAIN_CHECK_NAMES,
  ...OPS_CHECK_NAMES,
  ...META_CHECK_NAMES,
]);

// Once-per-process guard so an uncategorized check warns once, not per call.
const warned = new Set<string>();

/**
 * Map a check name to its category. Unknown names fall through to 'meta'
 * and warn once per process (a missing drift-set addition).
 */
export function categorize(name: string): CheckCategory {
  if (BRAIN_CHECK_NAMES.has(name)) return "brain";
  if (OPS_CHECK_NAMES.has(name)) return "ops";
  if (META_CHECK_NAMES.has(name)) return "meta";
  if (!warned.has(name)) {
    warned.add(name);
    console.error(
      `[memex doctor] check '${name}' is uncategorized — add it to ` +
        `core/doctor-categories.ts (defaulting to 'meta')`,
    );
  }
  return "meta";
}

/** Test-only: reset the once-per-process warn guard. */
export function _resetCategoryWarnings(): void {
  warned.clear();
}
