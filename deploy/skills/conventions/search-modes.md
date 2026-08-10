---
name: search-modes
description: How to pick the retrieval surface and knobs — search depth, detail level, date bounds, and when to escalate to entity_recall, relational_recall, or think.
type: convention
---

# Convention: Search Modes

> **Convention:** every retrieval call picks a depth deliberately. The knobs
> (result count `k`, `detail` level, date bounds, expansion) have sane
> server-side defaults; per-call overrides win when set. Escalate surfaces
> in order — cheap keyword+vector first, graph and synthesis last.

## When this fires

Any agent doing search-adjacent work against the brain consults this
convention:

- `brain-ops` / `query` / `signal-detector` skills: use the default knobs at
  search time. Per-call overrides win when set; server config is the default.
- Skills that recommend tuning ("the cache hit rate is high — raise the
  threshold?"): route operators to the `memex search modes` dashboard and
  `memex eval` rather than rolling their own logic.
- New skills that add per-call retrieval overrides: name them explicitly so
  the resolved-knob attribution in `memex search modes` reads cleanly.

## The knob set

| Knob | Values | Use |
|------|--------|-----|
| `k` | result count (default ~6-10) | Raise for survey questions, lower for pinpoint lookups |
| `detail` | `low` \| `medium` \| `high` | How much of each hit comes back: titles+snippets → chunks → full context. Default `medium`; `low` for scanning, `high` only when you will actually read it |
| `since` / `until` | `7d`, `2w`, `1y`, or ISO dates | Pure date filter, no boost — see `conventions/salience-and-recency.md` |
| `salience` / `recency` | `off` \| `on` \| `strong` | Ranking boosts — same file |
| `expand` | `query` only | LLM multi-query expansion (utility tier): generated keyword variants. Off in both default bundles (`conservative`, `balanced`); on under `tokenmax`. `search` has no `expand` knob — pass `expand: true` to `query` for concept/landscape questions, where the words you chose differ from the words the note used |

Cache and intent weighting are constant server-side — they're free wins
(no API cost). The knobs you scale per call are the cost levers: `k`,
`detail`, and which surface you escalate to.

## The escalation ladder

1. **`search`** — hybrid keyword+vector with reranking. Answers most
   questions. Start here, always.
2. **`entity_recall`** — when the question is about ONE entity ("tell me
   about acme"). Compiled facts + timeline + takes in one call; cheaper
   than assembling it from 4 searches.
3. **`relational_recall`** — when the question is about a RELATIONSHIP
   ("how do alice and widget-co connect?"). Graph-aware retrieval.
4. **`think`** — server-side synthesis (Sonnet tier) over retrieved
   context. Costs real money and seconds; use when the user asked a
   question that needs an answer composed FROM the brain, not a list of
   hits. Budget-capped via the `MEMEX_THINK` knobs — degrade gracefully
   to raw hits when the budget says no.

Rule of thumb: one step up the ladder per failed attempt, never two.
A thin `search` result usually needs a better query, not `think`.

## Resolution chain

    per-call opts (k / detail / since / salience / …)
      ↓ (when undefined)
    server config (operator-set)
      ↓ (when unset)
    built-in defaults (safety fallback)

## Tools for agents

Agents tuning a brain's retrieval should use these directly:

    memex search modes              # dashboard + per-knob source attribution (read-only)
    memex eval                      # retrieval-quality gate over the eval set
    memex status                    # config snapshot incl. search settings

Config mutation is operator-side. Recommend, don't apply.

## Cache contamination guard

The query cache is two-layer (global clock + per-doc generations) and keyed
by the ranking signature — a call with different knobs (expansion on,
different k, different detail) is keyed by a different signature than a
default read, so cross-knob contamination is structurally impossible. Any
write to a ranked document bumps its generation and invalidates exactly
the cached queries that saw it. Consequence for skills: never worry about
stale cache after a `page_put`; do worry about wasting the cache by
jittering knobs call-to-call for no reason.

## Trigger phrases

If an operator or agent asks any of these, route to the tool shown:

- "what search config is active?" → `memex search modes`
- "is my cache hot?" → `memex status`
- "tune my retrieval" → `memex eval`, then recommend changes to the operator
- "did retrieval regress?" → `memex eval`

## Don't

- Don't hardcode knob values in skill prose as if they were contracts.
  Defaults are server-side; cite the knob name, not a number.
- Don't mutate search config from inside a subagent loop without operator
  approval. Mutation is a trust-boundary crossing; config stays
  operator-side.
- Don't add per-call overrides on a production query path without naming
  them, or the `memex search modes` attribution stops reading cleanly.
- Don't jump to `think` because `search` came back thin. Fix the query.

## See also

- `conventions/salience-and-recency.md` — the ranking axes in depth
- `conventions/brain-first.md` — the lookup order before ANY external call
- `memex eval` — the retrieval-quality methodology gate
