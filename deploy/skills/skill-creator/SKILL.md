---
name: skill-creator
version: 1.0.0
description: |
  Create new skills following the memex conformance standard. Generates SKILL.md
  with frontmatter, Contract, Phases, Output Format, and Anti-Patterns. Checks
  MECE against existing skills. Updates manifest and resolver.
triggers:
  - "create a skill"
  - "new skill"
  - "improve this skill"
tools:
  - search
  - page_list
  - list_skills
mutating: true
---

# Skill Creator

## Contract

This skill guarantees:
- New skill follows conformance standard (frontmatter + required sections)
- MECE check: no overlap with existing skills' triggers
- Frontmatter `triggers:` route the intended phrases
- New skill shows up in `list_skills`
- Skill passes the conformance audit (`memex skillpack check`)

## Phases

1. **Identify the gap.** What capability is missing? What user intent has no skill?
2. **MECE check.** Enumerate the installed skills with `list_skills` and read their frontmatter `triggers:` via `get_skill`. Does any existing skill already cover this? If so, extend it instead of creating a new one.
3. **Create SKILL.md.** Use this template:

```yaml
---
name: {skill-name}
version: 1.0.0
description: |
  {One paragraph describing what the skill does and when to use it.}
triggers:
  - "{trigger phrase 1}"
  - "{trigger phrase 2}"
tools:
  - {tool1}
  - {tool2}
mutating: {true|false}
---

# {Skill Title}

## Contract
{What this skill guarantees — 3-5 bullet points}

## Phases
{Numbered workflow steps}

## Output Format
{What good output looks like}

## Anti-Patterns
{What NOT to do — 3-5 items}

## Tools Used
{MCP tools used, with descriptions}
```

4. **Write the routing.** The frontmatter `triggers:` array IS the routing —
   phrase each entry the way a user would actually say it. There is no
   separate routing file to update.
5. **Confirm discovery.** `list_skills` should return the new slug, and
   `get_skill {name}` should return the file you just wrote.
6. **Verify.** Run `memex skillpack check` to confirm the new skill passes conformance.

## Output Format

New `skills/{name}/SKILL.md` file, discoverable via `list_skills` with
triggers that route.

## Anti-Patterns

- Creating a skill that overlaps with an existing one (violates MECE)
- Skipping the MECE check against existing skills
- Creating a skill without triggers in frontmatter
- Shipping a skill that never shows up in `list_skills`
- Creating a skill without an Anti-Patterns section
