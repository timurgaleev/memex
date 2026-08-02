# Convention: schema evolution — when to add a type vs alias vs prefix

Cross-cutting convention for any skill that proposes a change to the
brain's taxonomy. Read first before proposing ontology changes
(`ontology_propose`). The brain uses OPEN page typing: `type` is a
frontmatter field, prefixes are conventions, and typed links are derived —
there is no schema pack to mutate. The goal is the same as any typed
system: keep the taxonomy small enough that an agent can hold the whole
type graph in its head, but expressive enough that custom domains
(research, legal, founder ops) get first-class types.

## Decision tree

```
You see a cluster of pages that share a domain meaning.
         │
         ▼
How many pages in the cluster?
         │
   ┌─────┴───────┬──────────────┐
   ▼             ▼              ▼
 <20          20-100         100+
   │             │              │
   ▼             ▼              ▼
One-off.      Big enough.    First-class.
Don't codify. Add an alias   Adopt a new
              to an existing type value with
Use the       type OR a      its own slug
nearest       narrow prefix  prefix, filing
existing      convention.    rule, and
type +                       ontology entry.
frontmatter
tag.
```

### Concrete examples

**One-off (don't codify):**
> "I have 3 pages under `projects/skunkworks-spec/`. Should I adopt
> a `skunkworks` type?"

No. Three pages doesn't justify a permanent taxonomy entry. Type these as
the nearest existing match (`concept` or `project`) and use a frontmatter
`project:` tag. If the cluster grows to 20+, revisit.

**20-100 pages — alias OR narrow prefix:**
> "I have 50 pages under `people/researchers/` that overlap with my
> `person` type. Should I adopt a `researcher` type?"

Two valid options:
1. **Alias** — register `researcher` as a page-alias / ontology alias of
   `person` (propose via `ontology_propose`). Queries for `researcher`
   will surface `person` pages too.
2. **Narrow prefix under the existing type** — keep `type: person`, adopt
   the `people/researchers/` prefix as a filing convention, and record it
   in `_brain-filing-rules.md` + `_brain-filing-rules.json`.

Pick the alias when researchers are people first, researchers second
(they share enrichment rules, expert-routing semantics, link verbs).
Pick a distinct type only when researcher-specific behavior diverges
(different extraction rules, different link verbs, different rubric).

**100+ pages — first-class type:**
> "I have 4000 pages under `meetings/`. I want them typed as `meeting`,
> not a legacy default."

Adopt the type: propose it via `ontology_propose` (check
`ontology_dimensions` first so the new type lands on the right axis),
add the filing rule to `_brain-filing-rules.json`, then backfill the
existing pages' frontmatter — as a durable job (`jobs_submit`) for a
corpus this size, per `conventions/test-before-bulk.md`. From here
forward, ingest under `meetings/` files with `type: meeting`.

## Don'ts

- **Don't codify a type for a directory you imported once for triage.**
  Taxonomy entries are permanent decisions; one-time imports are not.
- **Don't add a type just to make an empty prefix look intentional.**
  A dead prefix is a *signal* that the prefix is mis-declared or the
  corpus moved. Remove the prefix convention or migrate the content;
  don't paper over it with an empty type.
- **Don't promote a suggested type without verifying the prefix matches
  real content.** Any suggester is heuristic; it can propose types that
  overlap existing ones. Run `ontology_conflicts` before adopting to
  catch collisions pre-write.
- **Don't give a type expert-routing semantics without a prefix.** An
  expert-routed type with no slug prefix never matches page inference,
  so `find_experts` silently never surfaces it.
- **Don't fork the core filing rules casually.** `_brain-filing-rules.md`
  / `.json` are the shared contract every writing skill reads; extend
  them additively, don't rewrite their semantics.

## When to remove a type

Removing a type is RARE. Only do it when:
1. The type was adopted in error (typo, premature abstraction).
2. The corpus the type was meant for has been migrated to a different
   type.
3. The type is dangling (no slug prefix actually matches pages, no
   queries reference it, no other type's aliases or link kinds reference
   it).

Before removing, check references: `ontology_get` for the type's aliases
and link kinds, `page_list` under its prefix for surviving pages,
`list_link_sources` for edges that name it. If ANY other type's aliases
or link kinds reference the target, break those references first —
a silent removal leaves dangling semantics the graph can't explain.

## When to record the change

Every adopted taxonomy change gets written down, or it didn't happen:

1. `ontology_propose` files the proposal; the accepted entry is readable
   via `ontology_get`.
2. The filing rule lands in `_brain-filing-rules.json` (and its `.md`
   companion) so every writing skill inherits it.
3. A short note on `agent/taxonomy-log` (via `page_append`) records the
   date, the trigger cluster, and the decision — the audit trail for
   "why does this type exist?"

A burst of many taxonomy changes in a week is the hint to stop and
consolidate rather than keep mutating: batch the pending proposals,
review them against `ontology_conflicts`, and land them once.

## Bulk retype jobs

For a large retype/backfill (100+ pages), never loop `page_put` from the
main thread. Submit a durable job (`jobs_submit`) so the backfill is
resumable and observable, and follow `conventions/test-before-bulk.md`:
retype 3-5 pages first, read them back (`page_get`), verify frontmatter
and links survived, THEN run the batch. Scope the job to one slug prefix
per run so a bad rule can't leak across the whole corpus.
