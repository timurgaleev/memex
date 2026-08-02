---
name: schema-unify
description: Migrate a brain with runaway type proliferation to the canonical 15-type taxonomy via a doctor check + a durable unify-types job. Collapses dozens of noisy frontmatter types to 15 canonical with subtypes, slug-alias rows, and real link rows. Triggers when the doctor flags type proliferation, or the user asks "what is the canonical taxonomy / how do I clean up my page types".
brain_first: exempt
tools:
  - run_doctor
  - ontology_get
  - ontology_conflicts
  - stats
  - jobs_submit
  - jobs_get
  - jobs_logs
  - get_job_progress
  - page_restore
  - page_get
  - page_put
  - resolve_slugs
triggers:
  - "unify my types"
  - "migrate to the canonical taxonomy"
  - "94 types to 15"
  - "apply canonical taxonomy"
  - "clean up my page types"
  - "shrink type proliferation"
  - "what does the canonical taxonomy look like"
  - "consolidate page types"
  - "retype pages to canonical"
---

# Schema Unification (noisy types → canonical taxonomy)

The brain ships a **15-type DRY/MECE canonical taxonomy** (14 canonical +
`note` catch-all), recorded on the `concepts/type-conventions` page. Brains
that accreted noisy per-source types over years of ingestion opt in via the
doctor's type-proliferation finding + a durable `unify-types` job that is
PROTECTED (never auto-fired by the background cycle).

This skill is the playbook for that migration.

## brain_first: exempt

This skill is ABOUT the brain's shape — it can't depend on the brain it's
reshaping. No `search` lookup first; jump straight to the doctor.

## When this skill fires

- Agent runs `run_doctor` (or `memex doctor` on the host) and sees a
  type-proliferation or dangling-alias warning
- User asks "what is the canonical taxonomy / how do I clean up my page types /
  migrate to canonical"
- A dangling-aliases finding surfaces (post-unify GC)
- An agent ingesting from a custom source wants to consult the canonical
  taxonomy as a reference

## Mental model (one paragraph)

A long-lived brain accretes **dozens of distinct frontmatter `type` values**
over years of ingestion: tweet / tweet-thread / tweet-bundle / tweet-single /
media/x-tweet/bundle / tweet-stub all coexisting; thousands of
concept-redirect pages; partner-link pages that should be links; civic /
framework / insight / memo / anecdote one-offs. The cure: collapse to **15
canonical types** (person, company, media, tweet, social-digest, analysis,
atom, concept, source, deal, email, slack, writing, project, note) with
subtype/format/origin pushed to frontmatter, slug-alias rows for redirects,
real link rows for edge-shaped pages, and a catch-all that bins long-tail
unknowns to `note` with `frontmatter.legacy_type = <original>` for rollback.

## Workflow

### Phase 1: Discovery

Confirm the brain actually has proliferation (not already canonical).

```
ontology_get
```

If the observed type set is already ≤16 distinct values matching the
canonical list on `concepts/type-conventions`, the brain is already unified —
skip the migration.

Then run the doctor to see what would change:

```
run_doctor
```

Look for the type-proliferation finding. If it's `ok`, there's nothing to
migrate — done.

### Phase 2: Preview

Submit the unify job in dry-run mode (the default — `apply` is false unless
set) and read the per-cluster narrative:

```
jobs_submit  {"kind": "unify-types", "params": {"apply": false}}
jobs_logs    {"job_id": "<id>"}
```

The dry-run prints:
- How many pages would retype per cluster (tweets, articles, companies, etc.)
- How many concept-redirect pages would become slug-alias rows
- How many edge-shaped pages would convert to real links
- The synthesized catch-all rules for unknown types

Review the output. If the proposed changes look wrong, **don't** proceed —
adjust the mapping on `concepts/type-conventions` first (via the
`schema-author` skill), then re-preview.

### Phase 3: Apply

The handler is PROTECTED (manual-only) — the background cycle will never
auto-fire it. Submit explicitly, from the internal surface:

```
jobs_submit  {"kind": "unify-types", "params": {"apply": true}, "allow_protected": true}
```

`apply` defaults to **false** (dry-run) per the handler contract, so
`"apply": true` is required here or the job reports success having retyped
nothing. Omit it to preview.

Watch progress per phase:

```
get_job_progress  {"job_id": "<id>"}
jobs_logs         {"job_id": "<id>"}
```

On a large brain expect minutes, not seconds. The handler runs:
1. Preflight (validate the canonical mapping exists on the conventions page)
2. Stats snapshot (pre-state for the celebration summary)
3. Acquire the unify db-lock (long TTL; serializes concurrent runs)
4. Apply phases:
   - Explicit retype rules (tweets, articles, companies, etc.)
   - Catch-all retype (unknown types → note with legacy_type)
   - Page-to-link rules (partner-link, symlink-shaped pages)
   - Page-to-alias rules (concept-redirect pages → slug aliases)
5. Final sweep (untyped rows by path-prefix)
6. Mark the conventions page as the active canonical taxonomy
7. Verify + celebration summary

### Phase 4: Verify

```
run_doctor
stats
```

Expected:
- type-proliferation finding → `ok` (≤16 distinct typed values)
- dangling-aliases finding → `ok` (slug aliases all point at live canonicals)
- `ontology_get` shows the canonical type set

### Phase 5: Post-migration

Type-filtered queries keep working post-unify: a filter on a legacy name
(e.g. `article`) expands to the canonical type + subtype
(`media` + `subtype=article`) at query time. Direct SQL against the pages
table (operator-side) needs updating to the canonical types.

Search gets a small ranking signal: pages reachable via slug aliases
(canonicals of one or more redirects) rank slightly higher. `resolve_slugs`
resolves any old redirect slug to its canonical page.

## Rollback

Every retyped page preserves `frontmatter.legacy_type = <original>`. Restore
a page's type by writing it back:

```
page_get  <slug>          # read frontmatter.legacy_type
page_put  <slug>          # set type back to the legacy value
```

Page-to-alias and page-to-link source pages soft-delete with a restore
window. Restore within it:

```
page_restore  <slug>
```

Revert the taxonomy flip by editing `concepts/type-conventions` back (its
history is in `page_versions`; `page_revert` restores any prior version).

## Anti-patterns

- **Don't let the background cycle run unify-types.** It's manual-only by
  design. Automated maintenance should never silently change your taxonomy.
- **Don't expect the mapping to cover every legacy type explicitly.** Use the
  catch-all for the long tail. Pages get retyped to `note` with `legacy_type`
  preserved.
- **Don't rewrite body-text wikilinks.** The slug-alias table IS the resolver.
  `[[old-redirect-slug]]` keeps working via alias resolution
  (`resolve_slugs` short-circuits through it).
- **Don't bypass the dry-run.** Always preview before applying. The trust
  delta is real.
- **Don't run two unify jobs concurrently.** The unify db-lock serializes
  them; the second submission rejects with "already in progress."

## Decision tree

```
Type set already canonical (≤16, matches concepts/type-conventions)?
  → Skip migration.

Custom mapping needed for a domain-specific cluster?
  → Edit the mapping on concepts/type-conventions (via schema-author)
    BEFORE applying, then re-run the dry-run.

Brain has many custom types not covered by the canonical mapping?
  → The catch-all retype bins them to `note` with legacy_type preserved.
    Review by inspecting frontmatter.legacy_type after the migration.

Worried about a specific cluster's mapping?
  → Preview that cluster's counts in the dry-run logs, adjust the
    conventions mapping, and only then apply.
```

## Contract

Inputs:
- A brain whose observed type set exceeds the canonical taxonomy.
- The internal surface (protected jobs are not submittable from the public
  ingress).
- Minutes of wallclock on a large brain.

Outputs:
- Pages retyped to canonical types with `frontmatter.legacy_type` preserved
  (per-page rollback signal).
- Slug-alias rows for concept-redirect pages (the alias table IS the
  resolver — no link rewrite).
- Real link rows for edge-shaped pages (partner-link, symlink, etc.).
- `concepts/type-conventions` marked canonical at the end of a successful run.

Side effects:
- Source pages soft-deleted with a restore window (`page_restore <slug>`).
- Retyped pages bump their document generation — the query cache
  self-invalidates.
- Query-time type filters alias-expand to canonical (back-compat).

Failure modes:
- Concurrent submission rejected by the unify db-lock; second call exits
  gracefully.
- Catch-all retype excludes page-to-link + page-to-alias source types.
- Phase failures abort the run before the taxonomy flip; partial state is
  resumable from the job's checkpoint.

## Anti-Patterns (trust boundary)

DON'T:
- Submit `unify-types` from the public ingress. PROTECTED handlers require
  the trusted internal surface; public rejection is the intentional trust
  boundary.
- Edit the canonical mapping to silently skip clusters you don't trust —
  record the deviation on `concepts/type-conventions` so the source-of-truth
  mapping stays consistent.
- Run `unify-types` from inside automated maintenance. Pack-scale taxonomy
  upgrades are one-time consenting decisions.
- Purge soft-deleted source pages (`purge_deleted_pages`) before the restore
  window closes. Use `page_restore <slug>` first if rollback is needed.
- Assume `frontmatter.legacy_type` survives every roundtrip. The marker is
  canonical for the immediate post-migration window; downstream re-imports
  may overwrite it.

## Output Format

Per phase, the job logs emit:
```
[unify-types] phase=retype-explicit applied=N skipped=M
[unify-types] phase=retype-catch-all applied=N
[unify-types] phase=page-to-link converted=N pages soft-deleted
[unify-types] phase=page-to-alias aliased=N pages soft-deleted
[unify-types] phase=sweep residual=N
[unify-types] taxonomy marked canonical
```

Final celebration summary:
```
═══════════════════════════════════════════════════════════
  Canonical taxonomy migration complete
═══════════════════════════════════════════════════════════
  Before: 94 distinct page types
  After:  15 canonical types
  Retyped:      25,632 pages
  Aliased:       5,521 redirects → slug aliases
  Linkified:        65 ghost pages → real link rows
  Soft-deleted:  5,586 pages (restorable)
═══════════════════════════════════════════════════════════
```

`jobs_get` returns the structured result with per-phase counts and whether
the taxonomy flip completed.

## Reference

- Canonical taxonomy: `concepts/type-conventions` (via `page_get`)
- Taxonomy authoring: `skills/schema-author` (via `get_skill schema-author`)
- Filing rules: `_brain-filing-rules.md` (via `get_skill _brain-filing-rules`)
