/**
 * Emptying the brain between bench fixtures.
 *
 * Every family in the bench replays a corpus of independent fixtures on ONE
 * Storage — a fresh PGLite database per fixture pays the whole migration cost
 * each time. That only works if the reset between fixtures is total, and
 * "total" is not what `TRUNCATE … CASCADE` off `pages` gives you.
 *
 * WHAT CASCADE ACTUALLY REACHES. Four tables carry a foreign key to
 * `pages(slug)`, so truncating `pages` sweeps them for free:
 *
 *   page_aliases.slug      (034_page_aliases.sql:33)
 *   page_versions.slug     (015_pages.sql:63)
 *   links.source_slug      (016_links_typed.sql:47)
 *   timeline_events.slug + .event_slug
 *                          (017_timeline.sql:23, 096_timeline_event_projection.sql:31)
 *
 * And that is the whole list. `documents` hangs off `sources`, never off
 * `pages` (001_initial.sql:10, 004_sources.sql:29), so the entire document
 * side of the brain — `documents`, its `chunks` (001_initial.sql:23) and the
 * `embeddings` / `entity_mentions` / `code_edges_symbol` rows that cascade off
 * those — survives a `pages`-only truncate untouched. So do `entities`, and so
 * does `entity_facts`, whose only foreign keys are `source_id` to `sources`
 * and a self-reference for supersession (085_entity_facts_lifecycle.sql:51).
 * Nothing in the schema connects a fact to the page it is about.
 *
 * That was harmless while the only corpus seeded pages and read them back. It
 * stops being harmless the moment a fixture WRITES: continuity drives
 * `add_fact` through dispatch and fidelity drives the extraction pipeline, and
 * both land rows in exactly the tables the cascade misses. Fixture N's facts
 * would still be in the ledger when fixture N+1 counts what it recalled. Every
 * such table is therefore named explicitly below, and the ones that do cascade
 * are named too — an FK is a migration away from being dropped, and a reset
 * that silently narrows is the failure this list exists to prevent.
 *
 * WHAT MUST NOT BE TRUNCATED. `sources` is a parent of `pages.source_id`, and
 * `seedFixture` relies on a tenant registration surviving the reset. The
 * migration bookkeeping table is likewise off-limits: emptying it makes the
 * next `init` re-run a hundred migrations or fail outright.
 *
 * WHAT NO TRUNCATE CAN REACH. Three in-process caches and a queue singleton
 * outlive any SQL — see `resetProcessGlobals`.
 */

import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { clearCache } from "../search/query-cache.ts";
import { __resetFactsQueueForTests } from "../facts-queue.ts";
import { __resetHotMemoryMetaCacheForTests } from "../hot-memory-meta.ts";
import { _resetPendingVolunteerEventWritesForTests } from "../context/volunteer-events.ts";

/**
 * Every table a fixture can dirty. Grouped by which write path fills it, so a
 * new path that needs a new table has an obvious place to declare itself.
 */
export const RESET_TABLES: readonly string[] = [
  // Seeded by putPage. `page_versions` and `timeline_events` ride the CASCADE
  // off `pages`; so does `links`, named anyway because a link is a write a
  // fixture makes deliberately and should not depend on someone else's FK.
  "pages",
  "page_aliases",
  "slug_aliases",
  "links",
  // The document side and the fact ledger. NONE of these hang off `pages` —
  // without these names a fact written by one fixture is read by the next.
  // `chunks` is reached through `documents`, `entity_mentions` through both
  // `chunks` and `entities`; named so a dropped FK cannot narrow the reset.
  "documents",
  "chunks",
  "entities",
  "entity_mentions",
  "entity_facts",
  // Volunteer + ingest telemetry.
  "context_volunteer_events",
  "ingest_log",
  // Ranking freshness. `query_cache` is here AND in `resetProcessGlobals`
  // on purpose: migration 031 gates a cached row on a per-document
  // `generation` (031_two_layer_query_cache.sql:17-23), so dropping the clocks
  // without dropping the cache leaves fixture N+1 servable from fixture N's
  // ranking.
  "query_cache",
  "document_generation_clock",
  "page_generation_clock",
];

/**
 * Empty the brain between fixtures. One statement, so no fixture can observe a
 * half-reset brain through a concurrent read.
 */
export async function resetBrain(storage: Storage): Promise<void> {
  await storage
    .engine()
    .query(`TRUNCATE TABLE ${RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/**
 * Clear the state that lives in the process rather than in the database.
 *
 * Also used WITHOUT a truncate, as the "later session" boundary in the
 * continuity family: a probe served out of a warm query cache is not a recall
 * across sessions, it is a cache hit wearing one. That is why `clearCache`
 * belongs here even though `query_cache` is already in `RESET_TABLES` — the
 * two callers want different halves of this, and the overlap costs one DELETE
 * over an empty table.
 */
export async function resetProcessGlobals(engine: Engine): Promise<void> {
  await clearCache(engine);
  __resetFactsQueueForTests();
  __resetHotMemoryMetaCacheForTests();
  _resetPendingVolunteerEventWritesForTests();
}

/** A table that still held rows after a reset, and how many. */
export interface BrainResidue {
  table: string;
  rows: number;
}

/**
 * Assert the reset actually emptied every table, by counting them.
 *
 * A no-op reset passes an A/B agreement test — mutation testing proved exactly
 * that against the push corpus, where stubbing out the truncate left
 * "replays identically on a reused Storage" green. Comparing the harness to
 * itself cannot detect contamination that both runs share. So this counts, and
 * throws with the names, and every family calls it after a reset.
 */
export async function assertBrainEmpty(storage: Storage): Promise<void> {
  const counts = RESET_TABLES.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM ${t}`).join(
    " UNION ALL ",
  );
  const r = await storage.engine().query<{ t: string; n: number }>(counts);
  const residue: BrainResidue[] = r.rows
    .filter((row) => Number(row.n) > 0)
    .map((row) => ({ table: row.t, rows: Number(row.n) }));
  if (residue.length > 0) {
    const detail = residue.map((x) => `${x.table}=${x.rows}`).join(", ");
    throw new Error(`bench reset left rows behind: ${detail}`);
  }
}
