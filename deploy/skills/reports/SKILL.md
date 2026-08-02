---
name: reports
version: 1.0.0
description: |
  Save and load timestamped reports as brain pages. Keyword routing for fast
  lookup. Scheduled jobs (systemd timers, agent schedulers) save output as
  reports; the agent or user queries them by keyword.
triggers:
  - "save report"
  - "load latest report"
  - "what's the latest briefing"
  - "show me the pulse"
tools:
  - page_get
  - page_put
  - page_list
  - search
mutating: true
writes_pages: true
writes_to:
  - reports/
---

# Reports Skill

## Contract

This skill guarantees:
- Reports saved as brain pages with timestamped slugs and frontmatter
- Keyword routing: query → report category mapping
- Latest report loadable by category name
- Reports are searchable via the `search` and `query` tools

## Phases

1. **Save report.** `page_put` to `reports/{category}/{YYYY-MM-DD-HHMM}` with frontmatter:
   ```yaml
   ---
   title: {report title}
   type: report
   category: {category name}
   date: {YYYY-MM-DD}
   time: {HH:MM local}
   ---
   ```
2. **Load latest.** Given a category, `page_list` under `reports/{category}/` and
   `page_get` the most recent slug (timestamped slugs sort lexically).
3. **Keyword routing.** Map common queries to report categories:
   - "email" / "inbox" → ea-inbox-sweep
   - "social" / "mentions" → social-mentions
   - "briefing" / "morning" → morning-briefing
   - "meeting" → meeting-sync
   - Custom mappings configurable

## Output Format

Saved: `reports/{category}/{YYYY-MM-DD-HHMM}`
Loaded: full report content with metadata.

## Anti-Patterns

- Saving reports without frontmatter (makes them unsearchable)
- Using inconsistent category names across runs
- Loading all reports when only the latest is needed
- Not routing by keyword (forcing exact category name)
