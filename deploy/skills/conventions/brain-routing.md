# Brain Routing Convention

Cross-cutting rules for which source an operation targets. Applies to every
skill that reads or writes brain pages.

## The one axis

There is ONE brain — one database, one operator. No multi-brain routing, no
`--brain` flags, no mounts. The only routing decision left is the **source**:
which corpus INSIDE the brain an operation reads or writes.

- **`default`** — the DB-canonical page corpus. Everything skills write via
  `page_put` lives here: entity pages, meetings, reports, tasks.
- **`memory`** — the read-only note corpus, indexed from the operator's
  notes. Searchable, linkable, citable — but NEVER a write target. Its
  content changes only when the operator re-syncs the notes and reindexes.

## Default behavior (ALWAYS)

Start with no source filter. `search` and `query` span both sources with
unified ranking; that is the right answer 90% of the time. Don't narrow
without a reason.

1. Run `sources_list` (or `sources_status`) if you haven't seen the brain's
   sources yet this session.
2. Trust the unified ranking. A `memory` hit and a `default` hit compete on
   equal footing; the score decides, not the source label.
3. For every write, remember: `page_put` targets the DB-canonical corpus.
   There is no "write to memory" — if you think you need it, you're wrong.

## When to narrow to one source

Narrow to `memory` when:

- The user asks specifically about their notes ("what did I write in my
  notes about retry policy?", "check my vault notes on X").
- You're deduplicating: before creating a brain page, check whether the
  notes already cover the subject (cite the note, don't copy it).

Narrow to `default` when:

- The user asks about brain-authored artifacts specifically ("what reports
  have you filed?", "list the meeting pages").
- You're verifying a prior write landed (`page_get` / `page_versions`).

Do NOT narrow when:

- The user asks a general question. Unified search first; narrow only if
  the result set is noisy and the user's intent clearly scopes one corpus.
- You're unsure. Search wide, surface what you found, let the user point
  you at a corpus.

## Source health before destructive ops

Before any destructive operation (`page_delete`, `purge_deleted_pages`,
bulk `page_put` overwrites), run `source_health` and confirm you're
operating on the corpus you think you are. Deletes only ever apply to the
DB-canonical corpus; the note corpus is structurally read-only — a delete
that "needs" to touch it means the plan is wrong.

## Writing rules

Writing is stricter than reading.

- A fact derived FROM a note still gets written as a brain page (with a
  citation pointing at the note) — never attempt to edit the note itself.
- If a note contradicts a brain page, file the contradiction on the brain
  page with both citations (see `conventions/quality.md`). The note corpus
  is evidence; the brain page is the compiled truth.
- Respect the filing taxonomy in `_brain-filing-rules.md` for every
  `page_put` target slug.

## Citations with source context

Standard citation format stays the same (`[Source: ...]`), and when a page
comes from the note corpus, add the source context for human traceability:

- Brain-native page: `[Source: Meeting, 2026-04-10]` (unchanged).
- Note-corpus evidence: `[Source: memory:vault/projects/retry-budgets]`.

The `source:slug` form lets the operator trace any claim back to the exact
note it came from.

## Decision table

| Situation | Source scope |
|---|---|
| General question, could pull from anywhere | unified (no filter) |
| "What did I write in my notes about X?" | `memory` |
| "What reports have you filed?" | `default` |
| About to create an entity page | unified first (dedup check), then write to `default` |
| Verifying a write landed | `default` (`page_get`) |
| Unknown — can't classify | unified, surface findings, ask |

## Anti-patterns

- Trying to `page_put` into the note corpus. It's read-only by design;
  brain-authored content belongs in the DB-canonical corpus.
- Copying a note's content wholesale into a brain page instead of citing
  it. Duplication rots; citations don't.
- Narrowing to one source pre-emptively and missing the cross-corpus match
  that would have answered the question.
- Answering from the note corpus without a `memory:` citation. The user
  cannot trace the answer back.

## Read more

- `conventions/brain-first.md` (via `get_skill conventions/brain-first`) —
  reads the brain BEFORE asking.
- `conventions/quality.md` — citation format (extended here with the
  source prefix).
- `sources_list` / `sources_status` / `source_health` — the live view of
  what corpora exist and their state.
