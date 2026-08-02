---
name: migrate
description: Universal migration from Obsidian, Notion, Logseq, markdown, CSV, JSON, Roam
triggers:
  - "migrate from"
  - "import from obsidian"
  - "import from notion"
tools:
  - page_put
  - page_get
  - search
  - link
  - add_tag
  - stats
  - run_doctor
mutating: true
---

# Migrate Skill

Universal migration from any wiki, note tool, or brain system into memex.

## Contract

- Source data is never modified or deleted; migration is additive only.
- Every migrated page is verified round-trip: written via `page_put`, read back via `page_get`, spot-checked.
- Cross-references from the source system (wikilinks, block refs, tags) are converted to memex equivalents.
- Migration is tested on a sample (5-10 files) before bulk execution.
- Post-migration health check confirms page count, link integrity, and embedding coverage.

## Supported Sources

| Source | Format | Strategy |
|--------|--------|----------|
| Obsidian | Markdown + `[[wikilinks]]` | Direct import, convert wikilinks to memex links |
| Notion | Exported markdown or CSV | Parse Notion's export structure |
| Logseq | Markdown with `((block refs))` | Convert block refs to page links |
| Plain markdown | Any .md directory | Import directory page-by-page |
| CSV | Tabular data | Map columns to frontmatter fields |
| JSON | Structured data | Map keys to page fields |
| Roam | JSON export | Convert block structure to pages |

## Phases

1. **Assess the source.** What format? How many files? What structure?
2. **Plan the mapping.** How do source fields map to memex fields (type, title, tags, compiled truth, timeline)?
3. **Test with a sample.** Import 5-10 files via `page_put`, verify by reading them back with `page_get`.
4. **Bulk import.** Import the full set, one `page_put` per source file (from the shell, `memex call page_put '<json>'` scripts well for batches).
5. **Verify.** Check `stats` and `run_doctor`, spot-check pages.
6. **Build links.** Extract cross-references from content and create typed links with `link`.

## Obsidian Migration

1. Import the vault's markdown files as pages (Obsidian vaults are markdown
   directories) — preserve the relative path as the slug (`vault/<rel-path>`
   or a cleaner taxonomy prefix if the vault maps onto one).
2. Wire the graph: memex canonicalizes slugs and resolves both
   `[[relative/path]]` / `[[relative/path|Display Text]]` wikilinks and
   standard `[text](page.md)` markdown syntax during indexing, so most
   cross-references resolve as pages land. After the bulk import, sweep
   for anything unresolved:

   - `find_orphans` — pages with no inbound/outbound links
   - `resolve_slugs` — confirm ambiguous references landed on the right page
   - `link` — create any typed links the derivation could not infer

Obsidian-specific:
- Tags (`#tag`) become memex tags (`add_tag`)
- Frontmatter properties map to memex frontmatter (page typing is open — keep the source's types)
- Attachments (images, PDFs) are noted but handled separately via `put_raw_data`

## Notion Migration

1. Export from Notion: Settings > Export > Markdown & CSV
2. Notion exports nested directories with UUIDs in filenames
3. Strip UUIDs from filenames for clean slugs
4. Map Notion's database properties to frontmatter
5. Import the cleaned files via `page_put`

## CSV Migration

For tabular data (e.g., CRM exports, contact lists):
1. For each row in the CSV, create a page with column values as frontmatter
2. Use a designated column as the slug (e.g., name)
3. Use another column as the compiled truth body (e.g., notes)
4. Store each page via `page_put`

## Verification

After any migration:
1. Check `stats` to verify page count matches source
2. Check `run_doctor` for orphans and missing embeddings (or `memex doctor` from the shell)
3. Read pages back via `page_get` for round-trip verification
4. Spot-check 5-10 pages
5. Test search: `search` for "someone you know is in the data"
6. If embedding coverage lags the import, run `memex embed` to backfill

## Anti-Patterns

- **Bulk import without sample test.** Never import the full dataset before verifying with 5-10 files. The cost of cleaning up hundreds of bad pages is enormous.
- **Destroying source data.** Migration is additive. Never modify, move, or delete the source files.
- **Ignoring cross-references.** Wikilinks, block refs, and tags from the source system must be converted to memex equivalents. Dropping them loses the knowledge graph.
- **Skipping verification.** A migration without post-import health check, page count comparison, and spot-check reads is incomplete.

## Output Format

```
MIGRATION REPORT -- [source] -> memex
=======================================

Source: [format] ([file count] files, [size])
Mapping: [field mapping summary]

Sample Test (N files):
- Imported: N/N
- Round-trip verified: N/N
- Cross-refs converted: N

Bulk Import:
- Total imported: N
- Skipped (duplicates/errors): N
- Links created: N
- Tags migrated: N

Verification:
- Page count match: [yes/no]
- Health check: [pass/fail]
- Search test: [query] -> [result count] hits
```

## Tools Used

- Store/update pages (`page_put`)
- Read pages back (`page_get`)
- Link entities (`link`)
- Tag pages (`add_tag`)
- Brain statistics (`stats`)
- Health check (`run_doctor`)
- Search (`search`)
