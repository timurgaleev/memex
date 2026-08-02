# Brain Filing Rules -- MANDATORY for all skills that write to the brain

## The Rule

The PRIMARY SUBJECT of the content determines where it goes. Not the format,
not the source, not the skill that's running.

## Decision Protocol

1. Identify the primary subject (a person? company? concept? policy issue?)
2. File under the slug prefix that matches the subject
3. Cross-link from related pages (`link` / back-link entries)
4. When in doubt: what would you search for to find this page again?

## Common Misfiling Patterns -- DO NOT DO THESE

| Wrong | Right | Why |
|-------|-------|-----|
| Analysis of a topic -> `sources/` | -> appropriate subject prefix | sources/ is for raw data only |
| Article about a person -> `sources/` | -> `people/` | Primary subject is a person |
| Meeting-derived company info -> `meetings/` only | -> ALSO update `companies/` | Entity propagation is mandatory |
| Research about a company -> `sources/` | -> `companies/` | Primary subject is a company |
| Reusable framework/thesis -> `sources/` | -> `concepts/` | It's a mental model |
| Tweet thread about policy -> `media/` | -> `civic/` or `concepts/` | media/ is for content ops |

## Sanctioned exception: synthesis output is sui generis

The "file by primary subject" rule is for raw ingest. Synthesized output that
is one-of-one to a single source AND a specific reader (a personalized book
mirror, a strategic-reading playbook tied to one problem) does not fit any
subject prefix cleanly: filing by topic loses the "this is the book"
dimension; filing by author muddles authorship pages with synthesis pages.

Format-prefixed slugs under `media/<format>/<slug>` are the sanctioned
exception:

- `media/books/<slug>-personalized` (book-mirror output)
- `media/articles/<slug>-personalized` (long-form article personalization)

If you find yourself wanting `media/<format>/` for raw ingest, that is still
the anti-pattern in the table above. The exception is narrow: synthesized,
one-of-one, sui generis to a single source.

## What `sources/` Is Actually For

`sources/` is ONLY for:
- Bulk data imports (API dumps, CSV exports, snapshots)
- Raw data that feeds multiple brain pages (e.g., a guest export, contact sync)
- Periodic captures (quarterly snapshots, sync exports)

If the content has a clear primary subject (a person, company, concept, policy
issue), it does NOT go in sources/. Period.

Note: the read-only `memory` note source is indexed by the server, not
written by skills. `page_put` writes land in the DB-canonical default
source; do not try to write into the note corpus.

## Notability Gate

Not everything deserves a brain page. Before creating a new entity page:
- **People:** Will you interact with them again? Are they relevant to your work?
- **Companies:** Are they relevant to your work or interests?
- **Concepts:** Is this a reusable mental model worth referencing later?
- **When in doubt, DON'T create.** A missing page can be created later.
  A junk page wastes attention and degrades search quality.

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. This is bidirectional:
the new page links to the entity, AND the entity's page links back. Use the
`link` tool for the typed edge, and append the human-readable entry
(`page_append`) to the entity page's Timeline or See Also.

Format for back-links (append to Timeline or See Also):
```
- **YYYY-MM-DD** | Referenced in [page title](type/slug) -- brief context
```

An unlinked mention is a broken brain. The graph is the intelligence.

## Citation Requirements (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

Three formats:
- **Direct attribution:** `[Source: User, {context}, YYYY-MM-DD]`
- **API/external:** `[Source: {provider}, YYYY-MM-DD]` or `[Source: {publication}, {URL}]`
- **Synthesis:** `[Source: compiled from {list of sources}]`

Source precedence (highest to lowest):
1. User's direct statements (highest authority)
2. Compiled truth (pre-existing brain synthesis)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search -- lowest)

When sources conflict, note the contradiction with both citations. Don't
silently pick one.

## Raw Source Preservation

Every ingested item should have its raw source preserved for provenance.

Store the raw payload with `put_raw_data`, keyed to the derived page's slug
and a `type` (transcript, export, article-html, ...). Retrieve it later with
`get_raw_data`. The derived brain page should note that a raw copy exists so
any synthesized claim can be traced back to its original source.

For oversized binary media (video, audio) that doesn't belong in the brain
at all, keep the file in the operator's own storage and record a pointer
(URL or path) plus a content hash on the page — provenance without bloat.

## Cycle synthesize / patterns prefixes

The `synthesize` and `patterns` phases of the brain's background cycle write
to a **fixed allow-list** of slug prefixes sourced from
`_brain-filing-rules.json`'s `cycle_synthesize_paths.globs` array. Editing
that JSON is the ONLY way to add a new prefix the synthesis worker may
write to:

| Output type | Slug pattern | What goes here |
|-------------|--------------|----------------|
| Reflection | `wiki/personal/reflections/YYYY-MM-DD-<topic>-<hash[:6]>` | Self-knowledge, emotional processing, pattern recognition. Verbatim quotes from the user, with analysis. |
| Original idea | `wiki/originals/ideas/YYYY-MM-DD-<idea>-<hash[:6]>` | New frames, theses, mental models, "conceptive ideologist" outputs. Capture the user's exact phrasing — that's the artifact. |
| People enrichment | `wiki/people/<existing-slug>` | Timeline entries appended to existing people pages from session mentions. Stub pages for new substantive people. |
| Pattern | `wiki/personal/patterns/<theme>` | Cross-session theme detected across ≥3 reflections. Highest-leverage output: a pattern can span 25 years if reflections reference dated content. |
| Cycle summary | `cycle-summaries/YYYY-MM-DD` | Index of every page produced by one cycle run. Auto-written deterministically by the orchestrator. |

**Iron Law for synthesize output:**
1. Quote the user verbatim. Do not paraphrase memorable phrasings.
2. Cross-reference compulsively: every new page MUST link to existing brain content.
3. Slug discipline: lowercase alphanumeric and hyphens only, slash-separated. NO underscores, NO file extensions.
4. Edited transcripts produce NEW slugs (content-hash suffix changes) — never silently overwrite a prior reflection.

## Takes attribution

When writing a `<!--- memex:takes:begin -->` fence, the **holder** column says
WHO BELIEVES the claim, not who it's ABOUT. Cross-modal eval over a large
production takes corpus scored attribution at 6.5/10 — holder/subject
confusion was the #1 error. These six rules are the contract.

1. **Holder ≠ subject.** The test: did this person SAY or CLEARLY IMPLY this?
   - YES → `holder = people/<slug>`
   - NO, it's your analysis OF them → `holder = brain`
   - Example: "Alice has a hero/rescuer pattern" → `holder=brain` (analysis ABOUT Alice, not stated BY Alice)
2. **Atomic claims.** Split compound rows into separate rows. One claim per row.
3. **Amplification ≠ endorsement.** A retweet-only signal caps at `weight 0.55`.
   The user shared something; they didn't necessarily endorse every clause.
4. **Self-reported ≠ verified.** "A founder reports 7 figures" →
   `holder=people/<founder-slug>`, `weight=0.75`, NOT `holder=world/1.0`.
   Self-report is a strong individual signal, not consensus fact.
5. **No false precision.** Use 0.05 increments only (`0.35`, `0.55`, `0.75`).
   `0.74` and `0.82` imply calibration accuracy that doesn't exist. The engine
   layer rounds on insert — match the grid in your fence and avoid the warning.
6. **"So what" test.** Skip metadata-style trivia (Twitter handles, follower
   counts, obvious bio fields). A take has to be load-bearing for some future
   query.

**Holder format (enforced as a parser warning; treat it as an error):**
- `world` (consensus fact, no individual claimant)
- `brain` (AI-inferred, holder genuinely ambiguous)
- `people/<slug>` (individual's stated belief)
- `companies/<slug>` (institutional fact, no individual claimant)

Slugs use the standard grammar (`[a-z0-9._-]+`). `Alice`,
`people/Alice-Example`, and `world/alice-example` all fail validation.

**Founder-describing-own-company rule.** When a founder describes their own
company, the holder is the FOUNDER, not the company. "We can hit $10M ARR"
said by the founder of widget-co → `holder=people/<founder-slug>`, NOT
`holder=companies/widget-co`. Companies don't speak; their employees do.
