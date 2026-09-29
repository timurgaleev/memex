/**
 * Every opt-in cycle phase does nothing until its flag is set. The paid ones
 * (synthesis, facts backfill, rechunk re-embed) must not reach a model with no
 * flag and no injected model; the free ones must not write. One row per phase,
 * one store for all of them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { autoThinkPhase } from "../src/core/synthesis/auto-think.ts";
import { probeContradictionsPhase, type CandidatePair } from "../src/core/synthesis/contradictions.ts";
import { driftPhase } from "../src/core/synthesis/drift.ts";
import { enrichThinPhase } from "../src/core/synthesis/enrich-thin.ts";
import { patternsPhase } from "../src/core/synthesis/patterns.ts";
import { reflectionsPhase } from "../src/core/synthesis/reflections.ts";
import { conversationFactsBackfillPhase } from "../src/core/cycle/conversation-facts-backfill.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { indexDocument, type EmbedFn } from "../src/core/indexer.ts";
import { countStaleChunkerDocs } from "../src/core/chunker-version.ts";
import { rechunkSweepPhase } from "../src/core/cycle/rechunk-sweep.ts";
import { timelineAnchorPhase } from "../src/core/timeline-anchor.ts";
import { extractMeetingTimelinePhase } from "../src/core/timeline-meetings.ts";
import { syncTypedLinksForPage } from "../src/core/typed-links.ts";
import { deterministicEmbed } from "./det-embed.ts";

const ENV_KEYS = [
  "MEMRAIN_AUTO_THINK", "MEMRAIN_PROBE_CONTRADICTIONS", "MEMRAIN_DRIFT", "MEMRAIN_ENRICH_THIN", "MEMRAIN_PATTERNS",
  "MEMRAIN_REFLECTIONS", "MEMRAIN_FACTS_BACKFILL", "MEMRAIN_FACTS_FENCE", "MEMRAIN_RECHUNK_SWEEP", "MEMRAIN_TIMELINE_ANCHOR",
  "MEMRAIN_MEETING_TIMELINE", "MEMRAIN_TYPED_LINKS", "MEMRAIN_VAULT_PATHS", "MEMRAIN_CODE_PATHS",
] as const;

let tmp: string;
let vault: string;
let storage: Storage;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeAll(async () => {
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) saved[k] = process.env[k];
  clearEnv();
  tmp = mkdtempSync(join(tmpdir(), "memex-phase-off-"));
  vault = mkdtempSync(join(tmpdir(), "memex-phase-off-vault-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(clearEnv);

afterAll(async () => {
  clearEnv();
  Object.assign(process.env, saved);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});

const pair = (a: string, b: string, source: string | null = "tenantA"): CandidatePair => ({
  a_ref: a,
  a_text: `claim ${a}`,
  b_ref: b,
  b_text: `claim ${b}`,
  source_id: source,
});

async function seedReflections(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await putPage(storage, {
      slug: `reflections/2026-06-0${i}`,
      type: "note",
      title: `Reflection ${i}`,
      markdown_body: `Felt anxious about the deadline again today. Entry ${i}.`,
      source_id: "default",
    });
  }
}

// A body long enough (>= 200 chars) to clear the transcript floor.
async function seedTranscripts(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await putPage(storage, {
      slug: `notes/journal-2026-06-0${i}`,
      type: "note",
      title: `Journal ${i}`,
      markdown_body:
        `Entry ${i}: spent the afternoon turning the deadline over in my head, ` +
        "weighing whether to ask for more time or push through the weekend. " +
        "Kept circling back to the same knot of anxiety about letting the team down.",
      source_id: "default",
    });
  }
}

function fenceBody(facts: ParsedFact[]): string {
  return `# Alice\n\nSome prose.\n\n## Facts\n${renderFactsFence(facts)}\n`;
}

const embed: EmbedFn = async (text) => deterministicEmbed(text);

/** Create a markdown doc backed by a real file, then force it chunker-stale. */
async function makeStale(name: string, text: string): Promise<void> {
  const p = join(vault, name);
  writeFileSync(p, text);
  await indexDocument(storage, { sourcePath: p, text, sourceId: null }, { embedFn: embed, embeddingModel: "det" });
  await storage.engine().query("UPDATE documents SET chunker_version = 0 WHERE source_path = $1", [p]);
}

interface Row {
  phase: string;
  flag: string;
  /** Value the flag holds for the row; unset when absent. */
  off?: string;
  run: () => Promise<void>;
}

const ROWS: Row[] = [
  {
    phase: "autoThinkPhase",
    flag: "MEMRAIN_AUTO_THINK",
    run: async () => {
      const r = await autoThinkPhase(storage, { questions: ["What is unresolved?"] });
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_AUTO_THINK");
    },
  },
  {
    phase: "probeContradictionsPhase",
    flag: "MEMRAIN_PROBE_CONTRADICTIONS",
    run: async () => {
      const r = await probeContradictionsPhase(storage.engine(), { pairsFn: async () => [pair("1", "2")] });
      expect(r.judged).toBe(0);
      expect(r.skippedReason).toContain("MEMRAIN_PROBE_CONTRADICTIONS");
    },
  },
  {
    phase: "driftPhase",
    flag: "MEMRAIN_DRIFT",
    run: async () => {
      const r = await driftPhase(storage, {});
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_DRIFT");
    },
  },
  {
    phase: "enrichThinPhase",
    flag: "MEMRAIN_ENRICH_THIN",
    run: async () => {
      await putPage(storage, { slug: "people/alice", type: "person", title: "Alice", markdown_body: "stub", source_id: "default" });
      const r = await enrichThinPhase(storage, {});
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_ENRICH_THIN");
    },
  },
  {
    phase: "patternsPhase",
    flag: "MEMRAIN_PATTERNS",
    run: async () => {
      await seedReflections(4);
      const r = await patternsPhase(storage, {});
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_PATTERNS");
    },
  },
  {
    phase: "reflectionsPhase",
    flag: "MEMRAIN_REFLECTIONS",
    run: async () => {
      await seedTranscripts(3);
      const r = await reflectionsPhase(storage, {});
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_REFLECTIONS");
    },
  },
  {
    phase: "conversationFactsBackfillPhase",
    flag: "MEMRAIN_FACTS_BACKFILL",
    run: async () => {
      const r = await conversationFactsBackfillPhase(storage);
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("MEMRAIN_FACTS_BACKFILL");
    },
  },
  {
    // The facts fence is ON by default; only an explicit 0 turns it off.
    phase: "reconcileFactsForPage",
    flag: "MEMRAIN_FACTS_FENCE",
    off: "0",
    run: async () => {
      const put = await putPage(storage, {
        slug: "people/fenced",
        type: "person",
        markdown_body: fenceBody([{ rowNum: 1, claim: "fact", confidence: 1, active: true }]),
      });
      const r = await reconcileFactsForPage(storage, "people/fenced", put.content_hash);
      expect(r).toEqual({ removed: 0, added: 0 });
      const facts = await storage.engine().query(`SELECT id FROM entity_facts WHERE entity_slug = $1`, ["people/fenced"]);
      expect(facts.rows).toEqual([]);
    },
  },
  {
    phase: "rechunkSweepPhase",
    flag: "MEMRAIN_RECHUNK_SWEEP",
    run: async () => {
      process.env.MEMRAIN_VAULT_PATHS = vault;
      const before = await countStaleChunkerDocs(storage.engine());
      await makeStale("a.md", "## Note 1\n\nThis is the body of note 1.");
      const r = await rechunkSweepPhase(storage.engine(), {});
      expect(r.ran).toBe(false);
      expect(r.reason).toContain("disabled");
      expect(r.rechunked).toBe(0);
      // The stale doc is untouched.
      expect(await countStaleChunkerDocs(storage.engine())).toBe(before + 1);
    },
  },
  {
    phase: "timelineAnchorPhase",
    flag: "MEMRAIN_TIMELINE_ANCHOR",
    run: async () => {
      await putPage(storage, { slug: "notes/dated", title: "Dated note" });
      await storage.engine().query(
        `INSERT INTO documents (id, source_path, title, effective_date, effective_date_source)
         VALUES ('doc_notes_dated', 'page://notes/dated', 'Dated note', '2026-03-14'::timestamptz, 'date')`,
      );
      const res = await timelineAnchorPhase(storage);
      expect(res).toEqual({ pages_scanned: 0, events_written: 0 });
      const events = await storage.engine().query(`SELECT id FROM timeline_events WHERE slug = 'notes/dated'`);
      expect(events.rows).toHaveLength(0);
    },
  },
  {
    phase: "extractMeetingTimelinePhase",
    flag: "MEMRAIN_MEETING_TIMELINE",
    run: async () => {
      await putPage(storage, {
        slug: "meetings/2026-05-18-standup",
        type: "meeting",
        title: "Standup",
        compiled_truth: { attendees: ["Alice"] },
      });
      const res = await extractMeetingTimelinePhase(storage);
      expect(res).toEqual({ meetings_scanned: 0, entries_written: 0, attendees_touched: 0 });
    },
  },
  {
    phase: "syncTypedLinksForPage",
    flag: "MEMRAIN_TYPED_LINKS",
    run: async () => {
      await putPage(storage, { slug: "companies/acme", type: "company" });
      await putPage(storage, { slug: "people/employee", type: "person", compiled_truth: { company: ["Acme"] } });
      const res = await syncTypedLinksForPage(storage, "people/employee", "person", { company: ["Acme"] });
      expect(res).toEqual({ added: 0, removed: 0 });
    },
  },
];

describe("opt-in phases are no-ops without their flag", () => {
  for (const row of ROWS) {
    it(`${row.phase} without ${row.flag}`, async () => {
      if (row.off !== undefined) process.env[row.flag] = row.off;
      await row.run();
    });
  }
});
