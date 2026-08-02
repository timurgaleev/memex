---
name: schema-author
description: Evolve the brain's type taxonomy. Add page types, propose new ones from corpus scans, backfill frontmatter type on existing pages, audit taxonomy health. Triggers when an agent notices untyped pages, custom domains needing typed entities (researcher, contract, deposition), or wants to see what types the brain currently uses.
tools:
  - ontology_get
  - ontology_dimensions
  - ontology_propose
  - ontology_conflicts
  - stats
  - page_list
  - page_get
  - page_put
  - query
  - jobs_submit
  - jobs_get
  - jobs_logs
  - find_experts
triggers:
  - "add a page type"
  - "add a type to my taxonomy"
  - "my brain has untyped pages"
  - "types aren't matching my notes"
  - "propose new types from my corpus"
  - "backfill page types"
  - "evolve my taxonomy"
  - "extend the type conventions"
  - "create a custom type for"
  - "researcher type"
  - "make X an expert type"
  - "ontology propose"
  - "taxonomy author"
brain_first: exempt
writes_pages: []
---

# schema-author — evolve the brain's type taxonomy

memex uses OPEN page typing: a page's `type` lives in its frontmatter, filing
prefixes are conventions (see `_brain-filing-rules.md`), and typed links are
derived from page content. There is no mutable "pack" artifact — the taxonomy
is the set of conventions the ontology tracks plus the frontmatter discipline
this skill enforces. Authoring the taxonomy means: read the active ontology,
propose changes through it, record the convention, and backfill existing pages.

## Non-goals (use these other skills instead)

This skill AUTHORS the taxonomy (adds page types, link verbs, filing prefixes,
expert-routing decisions). For these adjacent jobs, route elsewhere:

- **Filing one specific page** → `skills/brain-taxonomist` (via `get_skill
  brain-taxonomist`). Brain-taxonomist routes at WRITE TIME ("where does this
  note go?"). schema-author changes the rules at AUTHORING TIME ("what types
  and prefixes exist?").
- **Taxonomy-check as part of EIIRP iteration** → `skills/eiirp` already has a
  schema-check phase. Don't duplicate.
- **Just looking up a type's settings** → `ontology_get` (or
  `ontology_dimensions` for the dimension breakdown) directly. This skill is
  for CHANGING the taxonomy, not READING from it.
- **Querying who knows about X** → `find_experts` directly (or the
  expert-routing conventions). schema-author decides that a type should be
  expert-routable; it does not run the query.

## Convention

> **Convention:** see `conventions/brain-first.md` (via `get_skill conventions/brain-first`) for the lookup chain (search → query → page_get → external).

> **Convention:** see `conventions/schema-evolution.md` (via `get_skill conventions/schema-evolution`) for "when to add a type vs alias vs prefix" — the heuristic.

## When to invoke

Invoke when the user (or a sibling skill) says any of:
- "Add a `researcher` type to my taxonomy"
- "I have 4000 untyped pages under `meetings/`"
- "My brain doesn't know that `journal-article` is a type"
- "Treat `paper` pages as fact-extractable"
- "Propose types from what I've ingested"
- "Backfill the new types onto existing pages"

DON'T invoke for "where does THIS note go" (use brain-taxonomist) or
"who knows about X" (use `find_experts`).

## Workflow

### Phase 1 — Brain (know what the active ontology says)

```
ontology_get
```

Returns the brain's current ontology: known types, dimensions, and link
verbs in use. `ontology_dimensions` breaks down each dimension (type,
subtype, origin, format) with observed values. This is your baseline —
never propose a type without knowing whether an equivalent already exists.

### Phase 2 — Assess (what does the current taxonomy cover?)

```
stats
```

Gives page/doc/chunk counts. Then measure type coverage directly:

```
page_list prefix=<candidate-prefix>
```

and inspect frontmatter on samples via `page_get`. Look for:
- untyped pages (no `type` in frontmatter)
- dead prefixes (a convention directory with zero matching pages — probable
  mis-declaration)

If coverage < 90%, there's untyped content worth typing.

For an untyped-pages drilldown, `page_list` the busiest prefixes and look
for shared path prefixes (e.g. "12 of these are under `research/papers/`") —
those are candidates for a new type.

### Phase 3 — Propose (what types should the taxonomy add?)

Cluster candidates yourself from the Phase 2 scan (path-prefix clustering is
a pure heuristic — no model call needed), then run the proposal through the
brain:

```
ontology_propose  {"kind": "type", "name": "researcher", "rationale": "...", "evidence_slugs": [...]}
```

`ontology_propose` records the candidate against the active ontology and
surfaces collisions with existing dimensions. Check `ontology_conflicts`
afterwards — a proposal that conflicts with an existing type/alias is a
signal to alias instead of add (see `conventions/schema-evolution.md`).

For LLM-refined candidates, use `query` over the untyped cluster and let the
brain's utility tier rank which clusters cohere as a type; promote only the
top candidates with clear prefix evidence.

### Phase 4 — Apply (record the convention)

The taxonomy change becomes real in two places:

1. **The ontology** — the accepted `ontology_propose` entry is the durable
   record of the decision.
2. **The conventions page** — update the filing rules so every writing skill
   picks it up:

```
page_append  slug=concepts/type-conventions
  "## researcher
   - primitive: entity
   - prefix: people/researchers/
   - extractable: yes (facts pipeline may extract from these pages)
   - expert-routed: yes (find_experts may surface these pages)"
```

For multi-part refactors (e.g. add a type AND the link verb that points to
it), record both in the same pass so the taxonomy never half-describes
itself:

```
ontology_propose  {"kind": "type", "name": "paper", ...}
ontology_propose  {"kind": "link_verb", "name": "authored", "from": "researcher", "to": "paper"}
```

Validate before backfill: re-run `ontology_conflicts`. It flags dangling
references and prefix collisions you'd otherwise discover only at runtime.

### Phase 5 — Backfill (retype existing pages with the new types)

Dry-run first: enumerate what would change.

```
page_list prefix=people/researchers/
```

Count the pages that would gain `type: researcher`. If the numbers look
right, backfill. For a handful of pages, edit frontmatter directly with
`page_get` + `page_put`. For large batches, submit a durable job so the
work survives the session:

```
jobs_submit  {"kind": "retype-backfill", "params": {"prefix": "people/researchers/", "type": "researcher"}}
```

Follow with `jobs_get` / `jobs_logs`. Backfill must be idempotent: a second
run finds nothing to update. Never rewrite page bodies during a retype —
frontmatter only.

### Phase 6 — Verify

Re-check coverage the same way as Phase 2. Coverage should be ≥95% now.
Spot-check the new type:

```
find_experts "machine learning"
```

If `researcher` was declared expert-routed, results should include
researcher-typed pages. If they don't, the prefix convention and the actual
page slugs disagree — fix the convention or the filing, not the query.

### Phase 7 — Record (preserve the change)

Write the decision as a brain page so future sessions inherit it:

```
page_put  slug=reports/taxonomy/{YYYY-MM-DD}-add-researcher
  frontmatter: {type: report, category: taxonomy}
  body: what was added, why, evidence, backfill counts
```

The background cycle picks up new conventions on its next pass — no manual
reload step. Other agents see the change as soon as the pages are indexed.

## Outputs

- Accepted ontology proposals recorded against the active ontology.
- Updated `concepts/type-conventions` page (the human-readable contract).
- `type` frontmatter backfilled on matching pages after Phase 5.
- Query paths (`find_experts`, typed traversal via `graph_query`) now route
  through the new expert types.
- A `reports/taxonomy/...` decision page.

## Contract

- **Inputs:** a natural-language request that names a type / prefix / link verb / flag change, OR a Phase 2 scan showing untyped pages that need a new type.
- **Outputs:** ontology proposal entries + updated conventions page + (if backfill ran) `type` frontmatter set on matching pages + a decision report page.
- **Side effects:** retyped pages bump their document generation, so the query cache invalidates itself; other agents pick the change up on next read.
- **Idempotency:** every step is idempotent. Re-proposing an existing type surfaces via `ontology_conflicts` instead of duplicating; a second backfill finds nothing to update.
- **Trust:** taxonomy changes are internal-surface work — run them via the internal MCP surface or `memex call`; the public ingress does not expose destructive or taxonomy-shaping operations.
- **Atomicity:** each page write is a single versioned `page_put`; a failed batch leaves prior pages untouched and `page_versions`/`page_revert` can roll back any individual page.

## Anti-Patterns

- **Don't invent a parallel taxonomy record.** The ontology (via
  `ontology_propose`) plus the conventions page IS the taxonomy. A type that
  exists only in one agent's head — or only in one session's frontmatter —
  is not a convention.
- **Don't add a type for a directory you imported once for triage.** Type
  conventions are permanent decisions; one-time imports are not. See
  `conventions/schema-evolution.md` for the <20-pages-don't-codify heuristic.
- **Don't declare a type expert-routed without a filing prefix.** An
  expert-routed type with no prefix convention never matches real pages, so
  `find_experts` silently never surfaces it.
- **Don't promote a proposal without verifying the prefix matches real
  content.** Run `ontology_conflicts` and a `page_list` sample before
  recording the convention, to catch prefix collisions pre-write.
- **Don't conflate "filing one page" with "evolving the taxonomy."** Filing
  routes via `brain-taxonomist`; schema-author is for authoring the type
  taxonomy itself. The Non-goals section above names the boundary.
- **Don't skip the dry-run before a large backfill.** Always enumerate
  `would_apply` counts + sample slugs first. A prefix that matches 50,000
  pages is recoverable but slow; verifying first is cheap.
- **Don't remove a type without checking references.** If another type's
  aliases or link verbs reference it, break the references first. Check
  `ontology_conflicts` and `list_link_sources` before retiring anything.

## Output Format

When invoked, this skill produces structured output suitable for both human
and JSON consumption:

**Per-proposal result:** the `ontology_propose` response (accepted / conflict,
with the conflicting dimension named on conflict).

**Coverage summary (the agent's final report):**
- Total pages, typed %, untyped count, per-type breakdown, dead-prefix list
- Backfill: per-prefix `would_apply`/`applied` count + sample slugs in
  dry-run mode
- One line per taxonomy change: type name, prefix, flags
  (extractable / expert-routed), evidence count

On failure, tool errors come back in the standard MCP error envelope; read
the message — it names the conflicting type, missing slug, or rejected
parameter.

## Failure modes

- **Proposal conflicts** → `ontology_conflicts` names the colliding type or
  alias. Alias instead of add, or pick a different name.
- **Backfill touches nothing** → the prefix convention and the real slugs
  disagree. `page_list` the prefix and compare against the convention.
- **`find_experts` misses the new type** → the pages carry the type but the
  filing prefix doesn't match the convention page. Reconcile them.
- **Concurrent backfills** → durable jobs serialize per kind; the second
  submission reports the in-flight job instead of double-running. Wait for
  `jobs_get` to show the first one done.
- **Permission denied (public surface)** → taxonomy ops are internal-only.
  Use the internal MCP surface or `memex call` from the host.
