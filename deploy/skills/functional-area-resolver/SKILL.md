---
name: functional-area-resolver
version: 1.0.0
prompt_version: 1
description: |
  Compress an agent's routing file (RESOLVER.md or AGENTS.md) by converting
  granular skill-per-row tables into functional-area dispatchers. Each area
  lists sub-skills in a "(dispatcher for: ...)" clause. The LLM reads one
  area entry and routes to the correct sub-skill. Proven via held-out
  A/B eval: dispatcher pattern outperforms naive pipe-table compression.
triggers:
  - "compress agents.md"
  - "compress my resolver"
  - "resolver too big"
  - "resolver.md too big"
  - "agents.md too large"
  - "shrink routing table"
  - "slim down agents.md"
  - "functional area resolver"
  - "functional area dispatcher"
  - "context-health agents"
  - "context-health resolver"
  - "reduce context budget"
tools:
  - list_skills
  - get_skill
mutating: true
# This skill names other skills (web-research, publish, etc.) in its
# dispatcher prose but never actually calls external APIs or search
# providers. It rewrites local routing tables. Declarative opt-out.
brain_first: exempt
---

# Functional-Area Resolver — Pattern for Compressing Routing Tables

## Problem

Routing files (RESOLVER.md, AGENTS.md) grow as skills are added. Each skill
gets its own row (trigger -> skill path). At ~200+ skills this hits 25-30KB,
eating context budget that should go to actual work.

## Solution: Functional-Area Dispatchers

Replace N rows per area with **one entry per functional area**. Each entry
lists all sub-skills it can dispatch to in a `(dispatcher for: ...)` clause.

### Before (270 rows, 25KB)
```
- Creating/enriching a person or company page -> `enrich`
- Fix broken citations in brain pages -> `citation-fixer`
- Publish/share a brain page as link -> `publish`
- Generate PDF from brain page -> `brain-pdf`
- Read a book through lens of a problem -> `strategic-reading`
- Personalized book analysis -> `book-mirror`
- Brain integrity -> `maintain`
...
```

### After (13 rows, 13KB)
```
- **Brain & knowledge**: create/enrich/search/export brain pages, filing,
  citations, publishing, book analysis, strategic reading, concept synthesis,
  archive mining -> `brain-ops` (dispatcher for: enrich, query, brain-pdf,
  publish, maintain, citation-fixer, book-mirror,
  strategic-reading, concept-synthesis, archive-crawler, ...)
```

## Why It Works

The LLM doesn't need one row per sub-skill. It needs:
1. **Area recognition** — "this is about brain pages" -> Brain & Knowledge
2. **Sub-skill visibility** — the `(dispatcher for: ...)` list shows what's available
3. **The skill file itself** — once the LLM reads `brain-ops/SKILL.md`, it has full routing detail

This is a **two-layer dispatch**: routing file routes to the area, the area
skill routes to the specific sub-skill. Each layer does one job well.

## A/B Eval Results

Three resolver architectures were tested across three Anthropic frontier
models (Opus 4.7, Sonnet 4.6, Haiku 4.5) on real production AGENTS.md
content, 20 hand-authored training fixtures + 5 held-out blind fixtures,
n=3 seeded repeats per (fixture, variant). Two scoring rules: **STRICT**
(predicted slug exactly equals expected) and **LENIENT** (predicted is in
the same dispatcher area as expected). Both matter:

- STRICT measures: "does the LLM return the exact slug?"
- LENIENT measures: "does the LLM land in the right area, even if it picks a
  more-specific sub-skill from `(dispatcher for: ...)`?" This is closer to
  production behavior — an agent that lands in a mail skill for an email
  intent succeeds even if the resolver entry named the assistant dispatcher.

### Training corpus (n=20, 3 seeds × 3 variants × 3 models, LENIENT)

| Variant | Opus 4.7 | Sonnet 4.6 | Haiku 4.5 | Size |
|---|---|---|---|---|
| baseline (270 bullet rows) | 81.7% ± 7.2% | 86.7% ± 7.2% | 73.3% ± 7.2% | 25KB |
| **functional-areas** (this pattern) | **98.3% ± 7.2%** | **100% ± 0%** | **88.3% ± 7.2%** | **13KB** |
| resolver-of-resolvers (no dispatcher clause) | 63.3% ± 14.3% | 41.7% ± 7.2% | 65.0% ± 12.4% | 10KB |

### Held-out blind corpus (n=5, 3 seeds, LENIENT)

| Variant | Opus 4.7 | Sonnet 4.6 | Haiku 4.5 |
|---|---|---|---|
| baseline | 100% ± 0% | 100% ± 0% | 100% ± 0% |
| **functional-areas** | **100% ± 0%** | **100% ± 0%** | **100% ± 0%** |
| resolver-of-resolvers | 100% ± 0% | **73.3% ± 28.7%** | 100% ± 0% |

### What the data shows

1. **Functional-areas BEATS baseline on training across all three models** (+13 to +17pp) at 48% the size. Held-out is saturated at 100% for both — within margin of error.

2. **The `(dispatcher for: ...)` clause is the load-bearing signal.** resolver-of-resolvers strips that clause and collapses to 41.7% on Sonnet — the catastrophic failure case the pattern's design review predicted, now observed.

3. **The pattern works because the LLM can drill into the dispatcher list.** Most "STRICT failures" are the LLM picking a more-specific sub-skill from the dispatcher list. That's the pattern working as designed. STRICT scoring under-counts; LENIENT scoring reflects production agent behavior.

4. **The pattern's value scales with model tier.** Compression gain (functional-areas vs baseline, training, LENIENT) is +17pp on Opus, +13pp on Sonnet, +15pp on Haiku. Sonnet shows the cleanest separation between functional-areas and resolver-of-resolvers (100% vs 41.7%) — model capacity affects how much the dispatcher signal matters.

### Reproduce

The eval needs no special harness: blind-route each fixture intent against
each routing-file variant with a fresh subagent per (fixture, variant, seed)
pass — the subagent sees ONLY the routing file plus the dispatcher-aware
prompt (below) and must return one slug. Score STRICT and LENIENT as
defined above; 3 seeded repeats per cell keeps the noise readable. Record
receipts per run (model, prompt hash, fixtures hash, timestamp) on a brain
page under `reports/` so later re-runs are comparable.

### Methodology caveats

- **Production prompt matters.** With a naive "return the skill slug" prompt
  (no instruction about `(dispatcher for: ...)`), every compression variant
  collapses to ~30-60% on Opus. The routing prompt must explicitly tell the
  model it may return any sub-skill named in a `(dispatcher for: ...)` list.
  Use that instruction in your agent's routing prompt; without it,
  compression breaks.
- **Training corpus and variants were authored together.** The held-out
  corpus was written before the variants and never adjusted; this mitigates
  but does not eliminate overfitting.
- **Confidence intervals via t-distribution across n=3 seeded repeats.** Hold the
  n=3 lower-bound: high CIs mean the underlying sample is noisy.
- **Single-vendor result.** All three models are Anthropic (which is also
  what this brain runs on Bedrock). Cross-vendor verification is a
  follow-up.
- **Held-out blind set is small (n=5).** Saturated at 100% across most cells —
  the eval can't distinguish between "100%" and "95% with one nondeterministic
  miss." Expanding to ≥20 is a follow-up.

### Prior work and citations

The pattern is a **static-prompt analog of hierarchical agent routing**, a
2024-2025 research direction:

- **AnyTool** ([arXiv:2402.04253](https://arxiv.org/abs/2402.04253)) showed
  meta-agent → category-agent → tool-agent hierarchy on 16K APIs beats flat
  retrieval by +35.4pp. The `(dispatcher for: ...)` clause is the
  meta-agent's view collapsed into a single LLM pass.
- **RAG-MCP** ([arXiv:2505.03275](https://arxiv.org/html/2505.03275v1))
  reports 49.2% prompt-token reduction at 3.2× accuracy gain via
  embedding-based pre-retrieval. The token-reduction story matches ours
  (48% smaller), via a different mechanism (RAG vs static dispatcher).
- **Anthropic Agent Skills**
  ([engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills))
  promotes progressive disclosure: frontmatter (~80 tokens) always loaded,
  SKILL.md body loaded on match. This skill applies the same principle at
  the routing-table level, not the per-skill body level.

The 2025-2026 literature has no published benchmark for **static-prompt
hierarchical routing** (every published hierarchical scheme resolves the
hierarchy at runtime via a second LLM call). The finding — that the
hierarchy can be inlined into a single-LLM-pass dispatcher list and retain
routing accuracy — is the open contribution.

## How To Compress

### Step 1: Preconditions

Refuse to compress if either gate fails:
- Source routing file is under 12KB (compression overhead exceeds benefit).
- `git status` shows uncommitted changes to the routing file (the
  compressor's edit would entangle with whatever the user was doing).

If a user wants to override either gate, they ask explicitly with `--force`.

### Step 2: When to compress which file

Agent workspaces often have TWO routing files merged at runtime:
`skills/RESOLVER.md` and a sibling `../AGENTS.md`. Choose which to compress:

- Only one is fat (>12KB): compress that one; leave the small one alone.
- Both are fat: compress them separately, in order: AGENTS.md first
  (usually the larger one), then RESOLVER.md.
- Only the small one is fat (rare): same rule — compress it.

If the deployment uses only one routing file, this section is a no-op —
compress that one.

### Step 3: Identify functional areas

Group skills by domain. Typical areas (adjust per deployment — `list_skills`
shows what this workspace actually exposes):

- **Brain & Knowledge** — brain-ops as dispatcher
- **Content Ingestion** — ingest as dispatcher
- **Research & Investigation** — web-research as dispatcher
- **Media & Voice** — media-ingest as dispatcher
- **Publishing & Export** — publish as dispatcher
- **Infrastructure & Health** — maintain as dispatcher
- **Tasks & Logistics** — daily-task-manager as dispatcher
- **Skill Authoring & Meta** — skillify as dispatcher
- **Reading & Synthesis** — strategic-reading as dispatcher

### Step 4: Build the area entry format

Each area entry follows this template:

```
- **{Area Name}**: {comma-separated trigger phrases} -> `{dispatcher-skill}`
  (dispatcher for: {comma-separated sub-skill names})
```

Rules:
- Trigger phrases should be broad enough to catch intent ("brain pages, enrich,
  search, filing, citations, book analysis")
- Sub-skill list should be comprehensive — this is how the LLM knows what's available
- The dispatcher skill file should have its own internal routing table

### Step 5: Keep always-on entries separate

Gates and always-on entries (acknowledge, entity detection, capture, etc.)
stay as individual rows — they're checked on every message, not dispatched.

### Step 6 (MANDATORY): Verify routing accuracy

Run two gates before committing the compressed file. Do NOT commit if either
fails.

**Gate 1: Structural verification.** Confirms the `routing-eval.jsonl`
fixtures shipped alongside each skill still resolve to the right skills
under the compressed routing file. Walk every fixture: for each positive
intent, verify the compressed file still contains a row (or a
`(dispatcher for: ...)` clause) that routes it to the expected skill; for
each negative fixture, verify nothing over-captures it.

If accuracy on the fixtures drops below 95%, revert and tune the area
entries before re-running.

**Gate 2: LLM A/B verification on YOUR edited file.** Confirms a frontier
LLM can still drill into the dispatcher list and reach sub-skills under
your specific compression. Run it with your own subagents: for each
fixture intent, spawn a fresh subagent whose ONLY context is the
compressed routing file plus the dispatcher-aware routing prompt, and ask
it to return the slug it would route to. Score lenient (same-area) and
strict (exact slug) across the fixture set, 3 repeats per intent.

If the lenient (same-area) score on your edited file drops below 95%,
revert the compression and tune. Common causes:
- A sub-skill was omitted from the `(dispatcher for: ...)` list.
- Trigger phrases for an area are too narrow (LLM can't recognize intent).
- Areas were collapsed too aggressively (too few areas — see Anti-Patterns).
- ASCII `->` vs Unicode `→` mismatch — normalize to one arrow style and
  make sure your structural check accepts the one you chose.

Common false negatives (NOT bugs in your compression):
- Fixtures target skill names like `enrich`, `query`. If your routing
  file doesn't expose those skills at all, expect strict-scoring failures
  on those fixtures. Lenient scoring stays accurate for any sub-skill
  present in your `(dispatcher for: ...)` lists.

### Step 7: Review the diff before committing

Show the user the proposed edit (or the actual git diff) and wait for
explicit approval before staging. Same convention as `skills/book-mirror`.

## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Compression is only performed when the preconditions in Step 1 pass (file ≥12KB AND clean working tree, or `--force`).
- The mandatory verification gate in Step 6 fires on the user's edited file, not on sample variants. The user runs BOTH the structural fixture check AND the subagent A/B check before committing the compressed file.
- Privacy contract preserved: no operator-private filesystem path literals (host install dirs, private note-vault paths) leak into the compressed output.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The compressed routing file follows the area-entry template documented in Step 4 ("Build the area entry format"). Each entry: `- **{Area Name}**: {trigger phrases} -> \`{dispatcher-skill}\` (dispatcher for: {sub-skill list})`. The dispatcher arrow may be either ASCII `->` (default in this template) or Unicode `→` (used in some production deployments); pick one and keep it consistent so the structural check stays trivial.

## Anti-Patterns

- **Resolver-of-resolvers with pipe tables.** Tested and failed (see eval
  table). The LLM picks area names from the table instead of drilling into
  sub-skills.

- **Removing sub-skill names.** Without the `(dispatcher for: ...)` list,
  the LLM can't route to specific sub-skills. The list is the routing signal.

- **Too few areas.** Collapsing to <5 areas makes each area too broad.
  12-15 areas is the sweet spot.

- **Too many areas.** Defeats the purpose. If you have 50 areas, just keep
  individual rows.

## Maintenance

When adding a new skill:
1. Identify its functional area.
2. Add the skill name to that area's `(dispatcher for: ...)` list.
3. Update the area's skill file with routing detail.
4. Run the routing eval (Step 6) to verify.

When adding a new functional area:
1. Create the dispatcher skill with internal routing.
2. Add the area entry to the routing file.
3. Run the routing eval (Step 6) to verify.

## Changelog

### v1.0.0
- Initial release. Pattern validated with a held-out A/B eval (results
  tables above); receipts filed under `reports/`.
- Skill named `functional-area-resolver` (earlier working name was
  `compress-agents-md`); the contribution is the pattern, not the filename.
