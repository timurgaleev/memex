/**
 * Agent-context loader — zero-LLM composition over the chronicle reads. Hands a
 * caller the recent timeline plus the validity-resolved ontology for the
 * entities in play, so it orients before acting. Pure composition of getSince +
 * getOntology per entity — no new SQL.
 *
 * Remote (untrusted) callers get a redacted view: diary-sourced ontology values
 * and any private-visibility rows are stripped, so a public reader never sees
 * interiority projected onto an entity.
 */
import type { Storage } from "../storage.ts";
import { getSince } from "../chronicle.ts";
import { getOntology } from "../ontology-facts.ts";
import type { ChronicleTimelineRow, OntologyValue } from "../chronicle/types.ts";

export interface ChronicleContextOpts {
  /** Lookback window in days for the recent timeline (default 7, cap 50). */
  days?: number;
  /** Entity slugs to resolve current ontology for (the people in the session). */
  entities?: string[];
  /** Required tenant read scope. */
  sourceIds: readonly string[];
  /** Untrusted caller → diary-sourced + private-visibility ontology is redacted. */
  remote?: boolean;
}

export interface ChronicleContext {
  since: string; // YYYY-MM-DD lower bound
  recent_timeline: ChronicleTimelineRow[];
  ontologies: Record<string, OntologyValue[]>; // entity slug → resolved values
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - Math.max(0, days) * 86_400_000).toISOString().slice(0, 10);
}

export async function loadChronicleContext(
  storage: Storage,
  opts: ChronicleContextOpts,
): Promise<ChronicleContext> {
  const days = typeof opts.days === "number" && opts.days > 0 ? Math.min(opts.days, 50) : 7;
  const since = daysAgoIso(days);
  const sourceIds = opts.sourceIds;

  const recent_timeline = await getSince(storage, since, {
    sourceIds,
    limit: 50,
    // Remote callers must not read interiority via the timeline arm, mirroring
    // the ontology redaction below.
    ...(opts.remote ? { excludeDiary: true } : {}),
  });

  const ontologies: Record<string, OntologyValue[]> = {};
  for (const slug of opts.entities ?? []) {
    // Remote: private-visibility rows are never fetched (worldOnly), and any
    // diary-sourced value is additionally stripped by source_slug.
    let vals = await getOntology(storage, slug, {
      sourceIds,
      ...(opts.remote ? { worldOnly: true } : {}),
    });
    if (opts.remote) {
      vals = vals.filter((v) => !(v.source_slug ?? "").startsWith("life/diary/"));
    }
    if (vals.length) ontologies[slug] = vals;
  }
  return { since, recent_timeline, ontologies };
}
