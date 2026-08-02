---
name: eiirp
version: 1.0.0
prompt_version: 1
description: |
  Everything In Its Right Place. The universal post-work organizer. After
  any significant work session, EIIRP runs a 7-phase audit: (1) inventory
  every output, (2) walk the filing taxonomy to decide where each lands,
  (3) check ontology consistency against the brain's actual shape, (4) file
  enriched brain pages, (5) audit the skill graph for DRY+MECE, (6) verify
  resolvability, (7) report. Named after the Radiohead song. Nothing
  produced during significant work lives only in chat — knowledge becomes
  permanent, patterns become reusable.
triggers:
  - "everything in its right place"
  - "eiirp"
  - "store this research"
  - "put this in the brain"
  - "file this properly"
  - "where does this research go"
  - "make this permanent"
  - "archive this research"
  - "archive this research thread"
  - "brain this"
  - "file all of this"
  - "organize all of this"
  - "organize all of this work"
  - "make this re-doable"
  - "DRY this up"
  - "check everything is in the right place"
tools:
  - search
  - query
  - page_get
  - page_put
  - link
  - add_timeline_event
  - ontology_get
  - ontology_propose
  - ontology_conflicts
  - find_orphans
  - run_doctor
  - list_brain_skillpack
mutating: true
writes_pages: true
# EIIRP files across the full canonical set — the actual destination
# per page is decided by brain-taxonomist consulting the filing rules
# (_brain-filing-rules.md) plus the live ontology via `ontology_get`.
# List the recommended set of canonical directories here so the
# filing-audit gate passes; the routing surface stays open because
# page typing in this brain is OPEN — new prefixes emerge through the
# ontology proposal loop, not a fixed table.
writes_to:
  - people/
  - companies/
  - deals/
  - meetings/
  - concepts/
  - projects/
  - civic/
  - writing/
  - analysis/
  - guides/
filing_exempt: true
distinct_from:
  - name: brain-taxonomist
    reason: "brain-taxonomist classifies individual pages at write time (the filing GATE). EIIRP orchestrates the full post-work LIFECYCLE — inventory + taxonomy + ontology + skillify + verify."
  - name: ingest
    reason: "ingest handles NEW content from external URLs/media. EIIRP handles COMPLETED research that needs to be decomposed and filed across multiple brain locations."
  - name: skillify
    reason: "skillify is the meta-skill for turning a feature into a tested skill. EIIRP calls skillify when Phase 5 identifies a reusable pattern."
---

# EIIRP — Everything In Its Right Place

> *"Everything in its right place"* — Radiohead, Kid A

## Contract

After any significant work, EIIRP organizes ALL outputs across two domains:

**Knowledge domain (brain):**
1. Every piece of knowledge lands in the correct brain location.
2. All sources are cited and linked.
3. The ontology is updated (via proposal) if a new content type emerged.
4. Entity pages created/updated with cross-links.

**Capability domain (skills):**
5. Every reusable pattern becomes a composable skill.
6. Existing skills are audited for DRY violations.
7. Skill graph is MECE — no gaps, no overlaps, no ambiguous routing.

**The meta-guarantee:** Nothing produced during significant work lives only in chat.
Knowledge → brain. Patterns → skills. Everything in its right place.

## When to Use

- After completing a deep research thread.
- After building something new (code, pipeline, workflow).
- After a multi-source analysis that produced significant findings.
- When the user says "EIIRP", "organize this", "DRY this up", "make this re-doable".
- When a work session produced both knowledge AND new capabilities.
- When you notice skill overlap, duplication, or gaps.

## Phase 1: INVENTORY — What did we produce?

Scan the current session/thread and identify ALL outputs across both domains.

### Knowledge outputs
```
□ Primary findings (the synthesis)
□ Source documents (URLs, PDFs, articles, tweets)
□ Entity mentions (people, companies, organizations, places)
□ Concepts/frameworks (reusable mental models)
□ Data artifacts (structured data, timelines, statistics)
```

### Capability outputs
```
□ New skills created or modified
□ Scripts/code written (should they be in lib/ or scripts/?)
□ Methodology used (search patterns, source chains, verification steps)
□ Workflows that could be automated (systemd timer, durable job, webhook)
□ Patterns that will recur (→ candidate for skillification)
```

Produce a manifest:

```markdown
## EIIRP Manifest
- Topic: [topic]
- Date: [date]
- Knowledge outputs: [count] (sources, entities, concepts)
- Capability outputs: [count] (skills, scripts, patterns)
- Reusable methodology: [yes/no — describe if yes]
```

## Phase 2: TAXONOMY — Where does each piece go?

**Read the live ontology first** (the single source of truth for
filing decisions):

```
ontology_get
ontology_dimensions
```

The ontology lists the directories the brain accepts plus the typing
conventions each maps to. Walk it for each output and pick the directory
whose prefix matches the content's primary subject. The filing rules in
`_brain-filing-rules.md` (via `get_skill _brain-filing-rules`) carry the
edge cases.

If `brain-taxonomist` is installed, INVOKE IT for ambiguous cases. It runs
the same decision protocol against the live ontology and gives you a single
recommended filing path with reasoning.

Output: a filing plan table:

```
| Content | Brain path | Action |
|---------|-----------|--------|
| Primary research | reference/.../page | CREATE |
| Person X | people/x-slug | CREATE |
| Person Y | people/y-slug | UPDATE (already exists) |
| ... | ... | ... |
```

## Phase 3: ONTOLOGY CHECK — Does the ontology cover this content?

This is where EIIRP closes the taxonomy-derivation loop. If the work
produced content that doesn't fit any existing type or prefix, propose
adding it through the ontology loop:

```
# Where does the brain's actual content conflict with the ontology?
ontology_conflicts

# What dimensions does the current ontology organize along?
ontology_dimensions

# Propose an addition; the operator reviews before it becomes convention.
ontology_propose
```

**Confidence floor:** when a proposed type is speculative — you have one
example, or the fit is under ~60% confident — DO NOT file as if the
proposal were accepted. Surface the suggestion to the user and let them
choose. The ontology tools ship the primitives; EIIRP enforces the
human-in-the-loop gate.

If the taxonomy needs to change:
- Propose the addition to the user before submitting `ontology_propose`.
- Document the decision on a brain page (`page_put` under `concepts/` or
  the relevant convention page) so the next session inherits it.
- Frontmatter discipline on the newly-filed pages is the enforcement —
  see `skills/frontmatter-guard`.

## Phase 4: FILE — Create enriched brain pages

For each item in the filing plan:

### 4a. Primary research page
Use the brain page template. MUST include:
- Proper frontmatter (`type`, `title`, `date`, `tags`, sources)
- **State** section — current status/key findings
- **Sources** section — every source with URL, author, date, language
- **Timeline** section — chronological development
- **Entity links** — backlinks to all related brain pages
- **See Also** — related concepts, reference pages

### 4b. Entity pages (people, companies)
For each entity mentioned:
- Check if a brain page exists (`search "<name>"` or `page_get people/<slug>`).
- If exists: update State, append a Timeline entry (`add_timeline_event`)
  citing this research.
- If not: create with enrichment (see `skills/enrich`).

### 4c. Write and verify
Pages are live the moment `page_put` returns — the brain is DB-canonical,
there is no separate sync step. After ALL pages are written, verify every
link resolves (`resolve_slugs` on the referenced slugs, `backlinks` on the
new pages) and that the background cycle has nothing to complain about.

## Phase 5: SKILL GRAPH AUDIT — DRY + MECE on capabilities

This phase operates on the SKILL graph, not just the research.

### 5a. New pattern identification

Ask: did this work reveal REPEATABLE patterns that will recur?

**Indicators of a reusable pattern:**
- You used a specific sequence of searches across multiple sources.
- You followed a specific verification/cross-referencing methodology.
- You wrote code that could be parameterized for different inputs.
- The output format is generalizable.
- The user is likely to ask for similar work on a different topic.

**For each identified pattern:**
1. Identify the composable pieces (DRY, MECE):
   - Shared logic → `lib/` (not copy-pasted into skills)
   - Search methodology → skill or lib function
   - Output template → brain template or skill phase
   - Filing logic → already covered by brain-taxonomist + the ontology
2. DRY check via the skillpack surface:
   ```
   list_brain_skillpack        # what the brain says is installed
   list_skills                 # what the workspace actually exposes
   ```
   Look for overlapping triggers or unreachable skills — pull each skill's
   frontmatter `triggers:` with `get_skill` and check them for collisions.

### 5b. Existing skill audit
For ALL skills used or touched during this work, check:
1. Were any skills BYPASSED? (did you do something manually that a skill should handle?)
2. Are there skills that OVERLAP with what you just did? (merge candidates)
3. Is shared code copy-pasted between skills? (extract to `lib/`)

**The MECE question:** If someone asked for this exact work again tomorrow on a different topic, which skills would they invoke? Is the path clear and unambiguous? If not, fix the routing.

### 5c. Present the plan
```
## Skill Graph Changes

### New skills to create
1. **[skill-name]** — [what it does]
   - DRY check: [clean / overlaps with X]
   - Recommendation: [create / merge into X]

### Existing skills to update
1. **[skill-name]** — [what changed, why]

### Code to extract to lib/
1. **lib/[name].ts** — [what it does, which skills use it]

### Skills to merge or deprecate
1. **[skill-A] + [skill-B]** → [merged-skill] — [why]
```

On approval: invoke `/skillify` (or `memex skillify`) for each new/modified skill.

## Phase 6: CHECK RESOLVABLE — Verify everything routes

After all filing and skillification:

```
run_doctor                          # health surface (or: memex doctor)
search "<topic keywords>"           # brain pages findable
find_orphans                        # any pages without inbound links?
list_brain_skillpack                # skillpack consistency
```

Confirm:
- [ ] All brain pages have proper frontmatter per the filing rules
- [ ] All entity pages are cross-linked
- [ ] Any new skills appear in `list_skills` and their frontmatter `triggers:` route
- [ ] No DRY violations (no duplicated logic across skills)
- [ ] No MECE violations (no ambiguous routing between skills)
- [ ] Ontology proposal submitted if new content types emerged
- [ ] `run_doctor` reports a healthy brain

## Phase 7: REPORT — Summary

```markdown
## EIIRP Complete: [Topic]

### Brain pages created/updated
- [path] — [description]
- ...

### Entity pages
- [path] — [created/updated]
- ...

### Ontology changes
- [none / description of the proposal + status]

### Skills identified
- [skill-name] — [status: created / merged / deferred]
- ...

### Resolver status
- DRY check: [clean]
- MECE audit: [clean]
- Skillpack: [consistent / drifted]
- Doctor: [ok / warn — detail]
```

## Output Format

EIIRP produces a single Phase 7 report block. Plain markdown:

```markdown
## EIIRP Complete: [topic]

### Brain pages created/updated
- [path] — [description]

### Entity pages
- [path] — [created|updated]

### Ontology changes
- [none | description of the proposal + status]

### Skills identified
- [skill-name] — [status: created|merged|deferred]

### Resolver status
- DRY check: [clean|N violations]
- MECE audit: [clean|N overlaps]
- Skillpack: [consistent|drifted]
- Doctor: [ok|warn — detail]
```

Always machine-readable: stable section headers + bullet-per-item. The
report doubles as a sync checkpoint for downstream skills (skillpack-check
reads it; doctor cross-references the skillpack state). File the report
itself as a brain page under `reports/` (`page_put reports/eiirp-<topic>-<date>`)
so it survives the chat.

## Anti-Patterns

- **Hardcoding directory tables in EIIRP's logic.** Every filing decision
  reads the live ontology (`ontology_get`) plus `_brain-filing-rules.md`.
  Page typing in this brain is OPEN — the taxonomy evolves through the
  proposal loop, and EIIRP MUST pick up new conventions automatically.
- **Auto-accepting low-confidence ontology proposals.** A speculative type
  suggestion is "manual review required". EIIRP surfaces it; the user accepts.
- **Skipping Phase 5 SKILL GRAPH AUDIT because "this was a one-off."**
  If the work took >10 minutes, the methodology is probably reusable.
  Audit anyway; defer the skillify decision to the user.
- **Filing synthesis output by topic alone.** Synthesis pages tied to a
  single source + reader are sui generis; they file under
  `media/<format>/<slug>-personalized`. See `_brain-filing-rules.md`
  "Sanctioned exception" section.
- **Treating non-English sources as secondary citations.** Multilingual
  sources are first-class.

## Hard Rules

### Knowledge domain
- **Never leave research only in chat.** If it took >10 minutes to produce, it gets a brain page.
- **Every source gets a citation.** No "according to reports" without a URL.
- **Entity pages get updated, not just created.** If a brain page exists, UPDATE it.
- **Ontology changes require confirmation.** The taxonomy is load-bearing.
- **Multilingual sources are first-class.** Never treat non-English sources as secondary.

### Capability domain
- **DRY is sacred.** If the same logic appears in two skills, extract it to `lib/`.
- **MECE is sacred.** Every trigger phrase routes to exactly one skill.
- **Composability over monoliths.** Small skills that compose > one giant skill that does everything.
- **Skillify only what recurs.** One-off work doesn't need a skill. Patterns that repeat 2+ times do.

### Meta
- **EIIRP is idempotent.** Running it twice on the same work should produce no changes the second time.
- **EIIRP consumes the ontology as data.** Never hard-code directory tables in EIIRP's logic — read from `ontology_get` so the routing surface tracks how this brain actually evolves.

## Changelog

### v1.0.0
- Initial release for this brain.
- Phase 3 ONTOLOGY CHECK runs on the ontology tool surface
  (`ontology_get | ontology_conflicts | ontology_propose`) with a
  human-in-the-loop gate on every proposal.
- Phase 5 SKILL GRAPH AUDIT cross-checks `list_brain_skillpack` +
  `list_skills` + frontmatter `triggers:` collisions.
- Phase 6 verification uses `run_doctor` + `find_orphans` for the
  persistent surface; pages are DB-canonical so filing is live on write.
