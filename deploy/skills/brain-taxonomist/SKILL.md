---
name: brain-taxonomist
version: 1.0.0
prompt_version: 1
description: |
  Filing gate for ALL brain writes. Consulted before creating any new
  brain page to determine the correct path. Reads the LIVE ontology via
  the `ontology_get` tool — no hardcoded directory table. Also runs
  periodic taxonomy drift detection via `find_orphans` and `run_doctor`.
triggers:
  - "where does this brain page go"
  - "file this in the brain"
  - "brain taxonomist"
  - "taxonomy check"
  - "refile brain page"
  - "create brain page"
  - "which directory does this go"
  - "which directory does this page go"
tools:
  - ontology_get
  - ontology_dimensions
  - ontology_propose
  - ontology_conflicts
  - find_orphans
  - run_doctor
  - search
  - get_skill
mutating: false
---

# brain-taxonomist

## Purpose

**Gate function:** Before creating ANY new brain page, consult this skill to determine the correct filing path. This prevents misfiling at write time rather than cleaning up drift after the fact.

**Drift function:** Periodic scan for pages that have outgrown their current location.

## Contract

This skill guarantees:
- Every new page is filed at the path determined by the LIVE ontology plus the filing conventions — never against a hardcoded directory table baked into this skill.
- The decision is reproducible: invoking brain-taxonomist twice on the same content produces the same recommended path.
- Ambiguous cases surface to the user via `skills/ask-user/` rather than silently picking a default.
- When no matching type exists in the live ontology, the skill signals to EIIRP Phase 3 (SCHEMA CHECK) rather than picking the closest-fitting fallback.

## Critical: this skill reads the LIVE ontology as data

`brain-taxonomist` has NO hardcoded directory table. Every decision is
driven by `ontology_get` (types and dimensions) plus the filing
conventions in `_brain-filing-rules.md` (via `get_skill _brain-filing-rules`).
memex page typing is OPEN — types are conventions carried in frontmatter
and derived typed-links, not a mutable pack. This means:
- The operator who extends the taxonomy does it by proposing a dimension
  (`ontology_propose`) and adopting the convention in the filing rules —
  and this skill picks it up automatically on the next consult.
- Filing recommendations always reflect THE brain's actual taxonomy as
  it exists today, not a default set frozen into skill text.

This is the single-source-of-truth principle: taxonomy lives in the
brain, skills read it.

## When to Consult (MANDATORY)

Run the taxonomist check before writing to the brain in these cases:

1. **New brain page** — any `type` (person, company, concept, book, meeting, etc.)
2. **Bulk import** — before committing a batch of new pages
3. **Uncertain filing** — when the primary subject is ambiguous

You do NOT need to consult for:
- Updating an existing page in place (same path — `page_put` to the same slug)
- Appending to a Timeline section (`page_append` / `add_timeline_event`)
- Meeting entity propagation to existing pages

## Decision Protocol

### Step 1: Identify primary subject type

Walk these questions in order:
1. Is the primary subject a NAMED PERSON? → person-typed directory (`people/`)
2. Is the primary subject a NAMED ORGANIZATION? → company-typed directory (`companies/`)
3. Is it about a TIME-BOUNDED EVENT (meeting, deal, trip)? → temporal-typed directory (`meetings/`, `deals/`)
4. Is it a REUSABLE MENTAL MODEL? → concept-typed directory (`concepts/`)
5. Is it RAW MEDIA (article, video, book, PDF)? → media-typed directory (`media/`)
6. Is it BULK SOURCE DATA? → source-typed directory (`sources/`)
7. None of the above → consult EIIRP Phase 3 for taxonomy-extension proposal.

### Step 2: Look up the directory for that type in the live ontology

```
ontology_get                → current types + their canonical path prefixes
ontology_dimensions         → dimensions in play (helps disambiguate)
get_skill _brain-filing-rules  → the filing conventions layer
```

The first prefix for a type is the canonical path. If multiple types
match (e.g. both `person` and `founder` conventions exist), prefer the
more specific one (the one with the more specific path prefix).

### Step 3: For books — determine sub-category

The filing conventions treat books as `media/books/<category>/<slug>`
where category is one of: psychology, philosophy, spirituality, business,
media-and-society, family-and-divorce, heritage, science, fiction,
biography, arts-and-design. If the live conventions page defines a
different scheme, walk it from `get_skill _brain-filing-rules` instead
of hardcoding here.

### Step 4: Construct the slug

- kebab-case, descriptive
- no author name unless disambiguation is needed
- match the canonical path prefix exactly (no leading slash)

### Step 5: Validate before writing

- [ ] Path follows the live ontology's canonical prefixes
- [ ] Slug is kebab-case, descriptive
- [ ] Frontmatter includes `type:` matching a type known to the ontology
- [ ] Cross-links to related pages are included (`link` after `page_put`)

If the live ontology doesn't have a type for what you're trying to file,
DON'T pick the closest-fitting one. Instead, signal to EIIRP that a new
type is needed and let `ontology_propose` carry the proposal flow.

## Integration with Other Skills

- `eiirp` — calls this skill as Phase 2 TAXONOMY for every output in its inventory.
- `ingest` — article/media ingestion consults brain-taxonomist for filing.
- `repo-architecture` — delegates the filing decision to this skill.
- `book-mirror` — after generating a mirror, files it via brain-taxonomist.

## Periodic Drift Detection

```
# What pages have no type / no links matching the live taxonomy?
find_orphans

# What's the overall health?
run_doctor        (or `memex doctor` from the shell)

# Any conflicting type conventions?
ontology_conflicts
```

When drift is significant (>10% of pages untyped or orphaned), run the
EIIRP Phase 3 SCHEMA CHECK flow and surface candidate types via
`ontology_propose`.

## Output Format

Advisory: a single recommendation block plus a one-line reasoning trail.

```markdown
**File at:** `<directory>/<slug>`
**Reasoning:**
- Primary subject: <person|company|concept|...>
- Matched type: <name> (primitive: <entity|temporal|concept|media|annotation>)
- Ontology basis: <ontology_get type / filing-rules section>
```

When ambiguous, surface 2 candidates via `skills/ask-user/` rather than
silently choosing.

When the live ontology has NO matching type, signal to EIIRP Phase 3
(SCHEMA CHECK) and emit:

```markdown
**No match in the live ontology.**
**Suggested next step:** propose the missing dimension via `ontology_propose`,
then review with `ontology_conflicts` before adopting.
```

## Anti-Patterns

- **Hardcoded directory table in this skill.** Every decision goes through
  `ontology_get` + the filing conventions. The live taxonomy is canonical,
  so an operator who evolves it gets the right routing automatically.
- **Picking the closest-fitting type when no type matches.** Closest-fit
  silently degrades filing. Surface to EIIRP Phase 3 instead.
- **Auto-adopting an `ontology_propose` suggestion.** Even high-confidence
  proposals need user approval — this skill is a GATE, not an automator.

## Hard Rules

- **Never hardcode a directory table in this skill.** Every decision goes
  through `ontology_get` and the conventions layer. The live brain is canonical.
- **Confidence-floor honor.** EIIRP's Phase 3 produces suggestions with
  confidence < 0.6 that brain-taxonomist must surface to the user rather
  than auto-apply. Don't silently promote a low-confidence taxonomy delta.

## Changelog

### v1.0.0
- Initial version. Hardcoded directory table REMOVED by design — every
  decision reads the live ontology via `ontology_get`. Single source of truth.
- Book taxonomy lives in the filing conventions (`_brain-filing-rules.md`),
  not in skill text.
