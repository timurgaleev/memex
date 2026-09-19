---
name: skillify
version: 1.1.0
description: |
  The meta skill. Turn any raw feature into a properly-skilled, tested,
  resolvable unit of agent capability. A second-model review is the
  recommended Phase 3 quality gate: a model from a different family critiques
  the output, you iterate to quality, THEN write tests that lock in the
  proven-good behavior.
triggers:
  - "skillify this"
  - "skillify"
  - "is this a skill?"
  - "make this proper"
  - "add tests and evals for this"
  - "check skill completeness"
tools:
  - search
  - list_skills
  - get_skill
  - page_put
mutating: true
---

# Skillify — The Meta Skill

> **Relationship to `cross-modal-review`:** Phase 3 below hands the skill's
> output to that skill for an independent second-model review before tests
> cement behavior. There is no separate eval command; the review is the gate.

## Contract

A feature is "properly skilled" when all 11 checklist items pass. Item 3
(second-model review) is informational — it does not gate `memex skillpack
lint` or `memex skillify check`, but record whether it ran and what it found
so the user knows where the gate stands.

## The Checklist

```
□ 1.  SKILL.md           — skill file with frontmatter + contract + phases
□ 2.  Code               — deterministic script if applicable
□ 3.  Second-model review — via the cross-modal-review skill; informational
□ 4.  Unit tests         — cover every branch of deterministic logic
□ 5.  Integration tests  — exercise live endpoints
□ 6.  LLM evals          — quality/correctness cases for LLM-involving steps
□ 7.  Routing triggers   — frontmatter `triggers:` with real user trigger phrases
□ 8.  Resolver eval      — test that triggers route to this skill
□ 9.  Check-resolvable   — DRY + MECE audit, no orphans
□ 10. E2E test           — smoke test: trigger → side effect
□ 11. Brain filing       — if it writes pages, filing entry per _brain-filing-rules.md
```

## Phase 0: Should This Be a Skill?

Before skillifying, check:
- Will this be invoked 2+ times? (One-off work ≠ skill)
- Is there >20 lines of logic? (Trivial helpers don't need full infrastructure)
- Does it have a clear trigger phrase a user would actually say?

If ANY answer is no, it's a script, not a skill — stop here. Do not scaffold, write a SKILL.md, run evals, or write tests for it. Tell the user why and move on.

Scope check (upper bound): one skill = one capability = one coherent trigger
family. If the target spans multiple distinct intents users would invoke
separately ("run the build" / "roll back the deploy" / "notify the team" are
three intents, not one), do NOT build one skill covering them all. Stop,
propose splitting into separate skillify targets, and ask the user which one
to skillify first.

## Phase 1: Audit

```
Feature: [name]
Code: [path]
Missing items: [check each of the 11]
```

## Phase 2: Write SKILL.md + Code (items 1-2)

### SKILL.md frontmatter template (copy-paste):

```yaml
---
name: my-skill
version: 1.0.0
description: |
  One paragraph. What it does, when to use it.
triggers:
  - "trigger phrase users actually say"
  - "another real trigger"
tools:
  - search
  - page_get
  - page_put
mutating: false  # true if it writes to brain/disk
---
```

Body must include: **Contract** (what it guarantees), **Phases** (step-by-step), **Output Format** (what it produces).

Extract deterministic code into `scripts/*.ts`.

## Phase 3: Second-Model Review (item 3)

### Why this comes before tests

Tests lock in behavior. If the behavior is mediocre, tests lock in mediocrity.
An independent review proves the quality bar FIRST, then tests cement it.

### Step 1: Pick a representative input

Choose the input that exercises the skill's hardest documented use case. If
unsure: use the primary trigger example from SKILL.md, or the most complex
real-world input from the last 7 days of captured pages (`search` with a
recency filter, or `get_recent_transcripts`).

### Step 2: Run the skill, capture output

Run the skill on the representative input. The OUTPUT is what gets reviewed.

### Step 3: Review, fix, repeat (≤3 cycles)

Load `cross-modal-review` (`get_skill cross-modal-review`) and have a model
from a different family review the output against what the skill is supposed
to accomplish. Apply the concrete improvements it names, then review again.
After three cycles, ship with a KNOWN_GAPS section listing what is still
below the bar and why.

Skip the review when the output is trivial (a thin wrapper around a single
tool call).

## Phase 4: Tests (items 4-6)

NOW that the review has proven quality, write tests that lock it in:

**Unit tests** — every branch of deterministic logic. Mock external calls.
**Integration tests** — hit real endpoints. Catch bugs mocks hide.
**LLM evals** — quality/correctness for LLM steps — test specific behaviors.

## Phase 5: Resolver + Check-Resolvable (items 7-9)

1. Fill frontmatter `triggers:` with phrases users ACTUALLY type
2. Resolver eval: feed triggers, assert correct routing
3. Check-resolvable:
   - Skill appears in `list_skills` and its triggers route (not orphaned)
   - No MECE overlap with other skills
   - No DRY violations (shared logic in lib/, not copy-pasted)
   - No ambiguous trigger routing

## Phase 6: E2E + Brain Filing (items 10-11)

- E2E smoke: full pipeline from trigger to side effect
- Brain filing: if the skill writes brain pages, add its filing rule per
  `_brain-filing-rules.md` (people/, companies/, concepts/, meetings/,
  reports/, inbox/, ...)

## Phase 7: Verify

```bash
bun test tests/<skill>.test.ts                   # unit tests
memex skillify check <slug>                      # frontmatter contract
memex skillpack lint                             # tools + commands the pack names exist
```

## Worked Example: Skillifying a "summarize-pr" Feature

```
Phase 0: Yes — invoked weekly, 50+ lines, clear trigger "summarize this PR"
Phase 1: Audit → SKILL.md missing, no tests, no resolver entry. Score: 1/11
Phase 2: Write SKILL.md + extract script to scripts/summarize-pr.ts
Phase 3: Second-model review, cycle 1 → "misses file-level diffs, no test
  plan in the summary" → apply fixes → cycle 2 → no blocking findings
Phase 4: Write 12 unit tests locking in the improved behavior
Phase 5: Add "summarize this PR" to the frontmatter triggers
Phase 6: E2E test: feed a real PR URL → verify brain page created
Phase 7: All green. Score: 11/11
```

## Quality Gates

NOT properly skilled until:

- All required items pass (1-2, 4-10; 11 only when applicable).
- The second-model review (item 3) ran OR is explicitly waived with
  rationale (informational; not blocking).
- All tests pass (unit + integration + LLM evals).
- Frontmatter `triggers:` exist with real trigger phrases.
- Check-resolvable shows no orphans, overlaps, or DRY violations.
- Brain filing if applicable.

## Output Format

Skillify produces two durable artifacts per skill:

1. **The skill tree on disk.** `skills/<slug>/SKILL.md`, any deterministic
   `scripts/<slug>.ts`, `routing-eval.jsonl`, and tests. `memex skillify
   scaffold <prompt>` drafts a starting skill file; the human/agent refines it
   into the real implementation.
2. **A verdict** from `memex skillify check <slug>` (the frontmatter contract)
   and `memex skillpack lint` (every tool and command the skill names exists),
   plus the 11-item score `<passed>/<total>` reported to the user.

## Anti-Patterns

- ❌ Writing tests before the second-model review (locks in mediocrity)
- ❌ Reviewing with the same model family that wrote it (correlated blind spots)
- ❌ Review without a fix cycle (vanity metrics)
- ❌ Code with no SKILL.md (invisible to resolver)
- ❌ Tests that reimplement production code (masks real bugs)
- ❌ Resolver entry with internal jargon (must mirror real user language)
- ❌ Two skills doing the same thing (merge or kill one)

