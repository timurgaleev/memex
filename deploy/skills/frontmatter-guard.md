# Frontmatter Guard — Vault YAML Conventions

Every file written under the vault's write-allowed subtree should carry
frontmatter. This skill is the contract: what fields are required,
what types they accept, what memex consumes from them.

---

## Required fields

| Field | Type | Notes |
|---|---|---|
| `type` | string | One of: `journal`, `memory`, `decision`, `incident`, `idea`, `event`, `task`. |
| `created` | ISO date `YYYY-MM-DD` | First-write timestamp. Don't change on edit. |
| `tags` | array of string OR comma-separated string | Lowercase. memex extracts these as entities. |

Optional but recommended:

| Field | Type | Notes |
|---|---|---|
| `updated` | ISO date | Bump on substantive edits. |
| `source` | string | `telegram-chat`, `morning-briefing`, `manual`, `gmail-recipe`, `gcal-recipe`. |
| `related` | array of string | Wikilinks to peer notes — these become `wikilink` entities in memex. |

---

## Examples

### A daily journal entry

```yaml
---
type: journal
created: YYYY-MM-DD
tags: [journal]
---
```

### A long-term memory about the user

```yaml
---
type: memory
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [profile, user, preferences]
related: [[User Profile]]
---
```

### A decision retrospect

```yaml
---
type: decision
created: YYYY-MM-DD
tags: [decision, infra]
related: [[some related note]]
---
```

---

## What memex does with frontmatter

- **`tags`** become `tag` entities in `entity_mentions` — search for
  `#some-tag` will hit any note tagged that way.
- **`[[wikilinks]]`** in `related` (or anywhere in the body) become
  `wikilink` entities — search for `[[Some Note]]` returns every note
  that references it.
- **`type`** is currently informational only (no schema enforcement).
  Future revisions may filter by it.
- **`created` / `updated`** are *not* what memex uses for staleness —
  that's `last_indexed_mtime` on disk. Frontmatter dates are for human
  readers.

---

## Hard rules

- **Never strip frontmatter** when editing an existing note. If a file
  already has `---` at the top, preserve it; touch only the body.
- **Don't invent fields.** If you need to track something new
  (`priority`, `confidence`, etc.), propose it in `signal-detect.md` or
  here first — keep the schema small.
- **Lowercase tags.** `[Project, Decision]` and `[project, decision]`
  would otherwise show up as different entities in memex.
- **One H1 per file.** It becomes the document title in memex
  (`documents.title`). Multiple H1s split into multiple chunks but the
  title is sourced from the first.
