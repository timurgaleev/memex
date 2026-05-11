---
title: brain-recall
description: Use memex to recover specific known content — recent decisions, named projects, identifiable conversations — when the user references something they expect you to remember
tags: [memory, retrieval]
---

# brain-recall — Find Things You Should Already Know

When the user says something like *"like we discussed last week"*,
*"the foo note"*, *"my workspace overview for X"* — they're asking
you to surface a specific known artefact, not to do exploratory
research.

This is a precision lookup, not the broad-recall search you'd do
for *"what do I know about Z"*.

## When to use

- User references a past decision / artefact by partial name
- User says "remember when we…", "the file about…"
- You need to verify your own claim against the indexed source

## How

```bash
# Start narrow — exact-phrase search via the stack helper:
/opt/<project>/bin/memex search '"some exact phrase"'

# Or via MCP tools/call name=search arguments={ q: "...", k: 3 }
```

The `intent` field in each hit (`exact|factual|topic|howto|personal`)
tells you whether memex treated this as exact-phrase. If you got
`topic` results when you wanted `exact`, retry with quoted query.

Keep `k` small (3-5) — for recall, you want the right hit at the top,
not 20 candidates.

## When recall returns nothing useful

1. Try the `backlinks` tool — `tools/call name=backlinks arguments={ name: "Foo" }`.
   That answers "what mentions Foo" via the entity graph.
2. Fall back to the `obsidian` skill (grep through the vault).
3. If you genuinely can't find what the user expects, **say so** —
   don't fabricate. Log a `log_friction` event with kind `search-miss`
   and `extra: { skill: "brain-recall" }` so `memex friction
   propose-fix` can group the miss with this skill.

## What this skill is NOT

- Not for broad-topic queries → use the broader search via `obsidian` skill.
- Not for indexing new content → use `idea-capture`.
- Not for graph traversal beyond direct backlinks → that's a future
  feature (graph-query) not yet built.
