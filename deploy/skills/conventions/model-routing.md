# Model Routing Convention

Two distinct concerns share this name. Read both — they apply at different
moments.

## 1. The brain's internal tier system

This is how the brain itself picks which model runs each internal task.
All model calls go through AWS Bedrock — there are no other providers.
Embeddings are Titan (fixed, not a routing decision). The LLM tiers:

| Tier | Purpose | Model | Examples |
|---|---|---|---|
| `utility` | fast classification, expansion, verdict, dedup | Claude Haiku | query expansion, intent classification, friction-propose, contradiction classifier |
| `synthesis` | reasoning, generation, question answering | Claude Sonnet | `think` answers, cycle synthesize/patterns, fact extraction |

Answer *synthesis for the user* is primarily the MCP client's job (the
agent you're running in). The brain's synthesis tier exists for
server-side work: `think`, the background cycle's generative phases, and
`extract_facts`.

Budget knobs (env, operator-side):

- `MEMEX_THINK` budget knobs cap per-call and per-day spend on the
  synthesis tier. When the budget is exhausted, `think` degrades to
  retrieval-only output rather than silently switching providers.
- Utility-tier calls are metered per cycle phase; the cycle's warn-state
  envelope surfaces overruns in `run_doctor` output.

Visibility:

```bash
memex status                 # current config snapshot, incl. model tiers
memex doctor                 # probes + health checks per subsystem
```

**Never hardcode a model ID in skill prose or scripts.** Name the tier
(`utility` / `synthesis`) and let the server resolve it. Model IDs rotate
with Bedrock availability; a hardcoded phantom ID fails silently long
after the doc was written — the tier indirection is the structural fix
for that bug class. Switching to a new model family is an infra change
(Bedrock invoke permissions are region- and model-scoped), not a config
flip — it goes through the operator.

## 2. Subagent spawn routing

When the user-facing agent (the main session) chooses which model to spawn
a sub-agent on, this table applies. It's about WHERE the agent sends its
own work, not what the brain calls internally.

| Task | Model | Why |
|------|-------|-----|
| Main session / complex instructions | Opus tier (default) | Best overall quality |
| Signal detection / entity extraction | Sonnet tier | Fast, cheap enough, fires every message |
| Research / synthesis over large context | Sonnet tier | Strong quality per dollar at volume |
| Judge tests / quality grading | Haiku tier | Cheap, good enough for pass/fail |

Use tier names of the agent harness's own model roster; the brain's
Bedrock tiers are a separate pool and are not consumed by agent-side
subagents.

### Refusal handling

When a model declines a benign task:
1. Rephrase and retry once on the same tier (often a framing artifact)
2. Retry once on the next tier up (more context, better judgment)
3. If it still declines, surface to the user plainly — never fabricate
   the output, never silently drop the task

### Spawn rules

- 3+ items to process → spawn a sub-agent
- >2 tool calls that don't need real-time judgment → spawn
- Main thread must stay responsive to the user
- Signal detection always spawns (parallel, don't block)
- For durable/server-side background work, prefer `jobs_submit` over an
  agent-side subagent — see `conventions/subagent-routing.md`
