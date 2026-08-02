---
name: frontmatter-guard
version: 1.0.0
description: |
  Validate and auto-repair YAML frontmatter on brain pages. Catches malformed
  pages before they pollute the brain (missing closing ---, nested quotes, slug
  mismatches, null bytes, empty frontmatter, YAML parse failures). Wraps the
  doctor's frontmatter surface plus page-level repair for agent-driven
  workflows.
triggers:
  - "validate frontmatter"
  - "check frontmatter"
  - "fix frontmatter"
  - "frontmatter audit"
  - "brain lint"
tools:
  - run_doctor
  - page_get
  - page_list
  - page_put
  - page_versions
  - page_revert
  - sources_list
  - source_health
mutating: true
---

# Frontmatter Guard Skill

> **Convention:** see `conventions/quality.md` (via `get_skill conventions/quality`) for citation rules; this skill is structural validation, not citation auditing.

## Contract

This skill guarantees:
- Every brain page is scanned against the eight canonical frontmatter validation classes
- Mechanical errors (nested quotes, missing closing `---`, null bytes, slug mismatch) are auto-repairable on demand — every repair is a `page_put`, so the pre-fix content survives as a prior version (`page_versions` / `page_revert` is the undo)
- Validation aligns with `run_doctor`'s health surface — one source of truth for what "malformed" means
- Reports per source (the brain indexes multiple sources; the read-only note corpus is one of them); never silently audits the wrong root

## Why This Exists

Brain pages pile up over months. Agents write them with malformed frontmatter:
- Missing closing `---` (entity detector bugs)
- Unstructured YAML in meeting pages (ingestion bugs)
- Slug mismatches (path renames not propagated)
- Null bytes (binary corruption from copy-paste accidents)
- Nested double quotes in titles (`title: "Phil "Nick" Last"`)

Without a guard, these accumulate silently until indexing chokes or search returns garbage. The guard makes the failure visible at audit time and trivially fixable.

## Validation classes

| Code | Meaning | Auto-fixable? |
|------|---------|---------------|
| `MISSING_OPEN` | Page body doesn't start with `---` | No (needs human) |
| `MISSING_CLOSE` | No closing `---` before first heading | Yes |
| `YAML_PARSE` | YAML failed to parse | Sometimes (depends on cause) |
| `SLUG_MISMATCH` | Frontmatter `slug:` differs from path-derived slug | Yes (removes the field) |
| `NULL_BYTES` | Binary corruption (`\x00`) | Yes |
| `NESTED_QUOTES` | `title: "outer "inner" outer"` shape | Yes |
| `NON_STRING_FIELD` | `title`/`type`/`slug` is an unquoted non-string scalar (e.g. `title: 123`, `slug: 2024-06-01`) | No (quote the value) |
| `EMPTY_FRONTMATTER` | Open + close present but nothing between | No (needs human) |

## Phases

### Phase 1: Audit

Run a read-only scan. Start from the doctor's health surface, then narrow:

```
run_doctor                      # or from the shell: memex doctor --json
sources_list                    # which sources are registered
source_health                   # per-source ingest/index state
```

Report:
- Per-source counts grouped by error code
- Sample of up to 20 affected pages per source (pull candidates via
  `page_list` and inspect suspicious ones with `page_get`)
- Total count
- Scan timestamp

Parse the doctor output and the per-page inspection to decide next steps —
never assume a brain is clean.

### Phase 2: Validate one page

Validate a single page or prefix without a full sweep:

```
page_get <slug>                 # read the raw page
page_list <prefix>              # enumerate a directory's pages
```

Check the page's frontmatter against the eight classes above. Clean = no
codes fired; report any that did.

### Phase 3: Fix

When issues are found, repair the page and write it back:

```
page_put <slug> <repaired content>
```

Every `page_put` records a new version — the pre-fix content is one
`page_versions` call away, and `page_revert` restores it. That version
history is the safety contract; there are no loose backup files to manage.

Preview before applying in batch: state exactly which pages will be
modified and what each fix does, then confirm.

**Read-only source caveat:** pages indexed from the read-only note corpus
(the `memory` source) cannot be repaired with `page_put` — fix the
underlying note on disk, then reindex it (`memex reindex` or the `index`
tool) so the corrected frontmatter lands.

### Phase 4: Write-time prevention (optional)

There is no commit hook to install — the brain is DB-canonical, and the
guard runs at write time in your own workflow instead: validate the
frontmatter you are ABOUT to `page_put` against the eight classes before
sending it. For the read-only note corpus, run the Phase 1 audit on a
schedule (a systemd timer on the host, or your harness's scheduler) so
drift in the source files is caught at the next sweep.

## Trigger words

When the user says any of these, route here:
- "validate frontmatter"
- "check frontmatter"
- "fix frontmatter"
- "frontmatter audit"
- "brain lint"

## Output rules

- Always run the Phase 1 audit first; never assume a brain is clean.
- Surface counts to the user in plain language; do not dump raw JSON.
- For fix operations: state how many pages will be modified BEFORE writing, then confirm.
- `SLUG_MISMATCH` fixes remove the frontmatter `slug:` field — the brain derives slug from path. Mention this when the user's title is intentionally renamed.
- Never auto-fix `MISSING_OPEN` or `EMPTY_FRONTMATTER` without explicit user input — these usually mean a human author started a page and didn't finish.

## Chains with

- `run_doctor` — the doctor's integrity checks report the same class of problems as the Phase 1 audit.
- `skills/maintain` — broader brain health audit; chain after this skill if other classes of issue are suspected.
- `skills/eiirp` Phase 6 — the post-work verification pass expects frontmatter to be clean before it signs off.

## Output Format

Audit summary (terse, agent-friendly):

```
Frontmatter audit — 17 issue(s) across 1 source(s)

[memory] read-only note corpus
  17 issue(s)
    MISSING_CLOSE: 8
    NESTED_QUOTES: 5
    NULL_BYTES: 4
  sample:
    people/jane — MISSING_CLOSE
    companies/acme — NESTED_QUOTES
    (+ 12 more)

Fix: repair DB-canonical pages via page_put; for [memory] fix the
source notes, then reindex.
```

Structured envelope (when reporting for a downstream skill to parse):

```json
{
  "ok": false,
  "total": 17,
  "errors_by_code": { "MISSING_CLOSE": 8, "NESTED_QUOTES": 5, "NULL_BYTES": 4 },
  "per_source": [
    {
      "source_id": "memory",
      "total": 17,
      "errors_by_code": { "MISSING_CLOSE": 8, "NESTED_QUOTES": 5, "NULL_BYTES": 4 },
      "sample": [{ "slug": "people/jane", "codes": ["MISSING_CLOSE"] }]
    }
  ],
  "scanned_at": "2026-04-25T22:30:00.000Z"
}
```

Single-page validation returns a similar envelope keyed on per-page
results instead of per-source.

## Prevention — Writing Valid Frontmatter

**This is the most important section.** Fixing broken frontmatter is good. Not writing broken frontmatter in the first place is better.

### YAML arrays (the historical #1 error source)

```yaml
# Correct: single-quoted YAML flow (canonical form)
tags: ['yc', 'w2025', 'ai']

# Correct: unquoted scalars (fine when values have no special chars)
tags: [yc, w2025, ai]

# Correct: block style
tags:
  - yc
  - w2025

# Tolerated but non-canonical: JSON-style double quotes
tags: ["yc", "w2025"]

# Broken: mixed JSON objects and strings (invalid YAML)
tags: [{"name": "sports"}, "posterous"]
```

**Why this used to break:** a naive validator counts unescaped `"` characters and flags any line with 3+. A flow sequence like `tags: ["yc", "w2025"]` has 4 unescaped `"` by design — it's valid YAML, but the dumb counter flags it anyway; one long-running brain accumulated nearly 7,000 such false positives in a single audit. The right check parses suspicious values with a real YAML parser before flagging, so JSON-style arrays never trigger NESTED_QUOTES.

**Why you should still write the canonical form:** repairs and inferred frontmatter both emit single-quoted YAML for `tags:` / `aliases:`. Writing the canonical form in new content keeps pages stylistically consistent and makes repair diffs empty.

**The classic LLM trap:** code like `tags: [${items.map(t => JSON.stringify(t)).join(', ')}]` produces `tags: ["yc", "w2025"]`. Use single quotes with an apostrophe fallback: `tags: [${items.map(t => t.includes("'") ? JSON.stringify(t) : "'" + t + "'").join(', ')}]`. Or use a YAML library that knows how to emit canonical YAML.

### Quoted scalars

```yaml
# Correct: single quotes for values with special chars
title: 'My "Quoted" Title'

# Correct: double quotes when value has apostrophes
title: "Men's Fashion Guide"

# Broken: double quotes wrapping inner double quotes
title: "My "Quoted" Title"
```

### When to quote at all

- **Unquoted** is fine for simple values: `type: person`, `batch: w2025`
- **Quote** when the value contains `: " ' # [ ] { } | > & * ! ? ,` or starts with `@`
- **Single quotes** are the default safe choice
- **Double quotes** only when the value itself contains apostrophes

## Anti-Patterns

**Don't auto-fix `MISSING_OPEN` or `EMPTY_FRONTMATTER` without user input.** These usually mean a human author started a page and didn't finish — silently inserting `---` markers around an unfinished draft is wrong.

**Don't repair pages just to "make doctor green" without reading the audit first.** SLUG_MISMATCH cases are surfaced for manual review specifically because the brain derives the slug from path. A mismatch usually means the user renamed a page intentionally; auto-removing the slug field is the right outcome only when you've confirmed the rename was deliberate.

**Don't skip the version history.** Every repair goes through `page_put` so `page_versions` retains the pre-fix content. If the user wants to review what changed after a batch fix, walk the versions with them — never repair through a side channel that bypasses versioning.

**Don't audit a source that isn't registered.** If `sources_list` doesn't show the root you're worried about, don't paper over it with a manual path-walk; the right fix is to register/ingest the source properly, then audit.

**Don't promise write-time blocking for the read-only note corpus.** Those files are authored outside the brain; the guard catches their problems at audit/reindex time, not at write time. If the user wants earlier feedback there, schedule the audit sweep more frequently.
