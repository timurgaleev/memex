# How memex works

A plain-language tour of the whole system: what it is, how your knowledge gets
in, how a question is answered, and — the question everyone asks — **where the
money goes**. Every claim here is grounded in the code (`deploy/memex/src`) and
the other docs ([ARCHITECTURE.md](../ARCHITECTURE.md),
[CONFIGURATION.md](./CONFIGURATION.md)).

## In one sentence

memex is a **retrieval brain**, not a chatbot. It **finds the right things and
proves them** (every hit comes with its source); the *answer* is written by your
MCP client (Claude Code, etc.) from what memex returned. It remembers and finds;
it does not talk.

## 1. How knowledge gets in

You point memex at content — markdown notes, a code checkout, or anything pushed
over MCP (mail, calendar, arbitrary documents). For each document it:

1. **Chunks** it into passages.
2. Computes an **embedding** (a numeric "fingerprint" of meaning) for each chunk
   with **Amazon Titan Text Embeddings v2** on Bedrock.
3. Stores everything in **Postgres (RDS)** — the database is the single source of
   truth, not the files on disk.

## 2. How a question is answered (the pipeline)

When your MCP client searches, memex runs a hybrid pipeline
(`core/search/hybrid.ts`):

1. **Classify intent** — Claude Haiku works out what kind of question it is.
2. **Retrieve in parallel** — embed the query and search by *meaning* (vector) +
   search by *words* (keyword), at the same time.
3. **Expand the query** — Haiku adds synonyms / related terms for extra keyword
   passes.
4. **Fuse** the result lists (Reciprocal Rank Fusion).
5. **Hydrate** the top hits with their parent document + source type.
6. **Source-boost** and 7. **de-duplicate**.
8. **Rerank** (optional) — a two-pass Claude Haiku rerank, or the paid
   graph-aware Sonnet rerank, reorders the best hits.
9. **Trim** to the top *k* and return them **with citations**.

The important part: steps 1, 3, and 8 use an LLM **internally** — not to *write
an answer*, but to make *retrieval sharper*.

One optional shortcut sits in front of all of this: a **semantic query cache**
(off by default). Ask the same thing a second time — or a close paraphrase — and
memex recognizes the two queries *mean* the same (their fingerprints nearly
match) and returns the cached result instead of paying for the whole pipeline
again.

## 3. Where the money goes

Three cost layers, from pennies to real money:

| Layer | What it does | When it spends | Cost |
|-------|--------------|----------------|------|
| **Titan embeddings** | chunk fingerprints | on indexing + one query vector per search | pennies (~$0.026 / 1M tokens) |
| **Claude Haiku** (utility) | understand + expand the query, nightly synthesis, contextual embedding wrapper | most searches + nightly | cheap (~$1–15/mo) |
| **Claude Sonnet** (paid slices) | graph-aware rerank, relational reasoning, `think`, deep-synth, take grading | **only when a flag is set** | pay-per-call — the cost swing |

The dominant variable cost is **`MEMEX_GRAPH_RERANK`** — a paid Sonnet call on
*every* search, so it scales with how much you search. On top of that sits a
fixed infrastructure floor: one small EC2 instance + one RDS Postgres +
networking/secrets. See [CONFIGURATION.md](./CONFIGURATION.md#quality--cost-tiers-pick-one)
for the Free / Balanced / Max tiers and how to pick one.

## 4. Why run LLMs *inside* the brain at all?

If the MCP client writes the answers, why does memex call models internally? Two
reasons — and neither is "chatting with the user":

**A. Sharper retrieval, at query time.**
- **Graph rerank** (Sonnet): reorders the top hits using the knowledge-graph
  connections between pages — the most relevant, best-connected hit rises.
- **Relational fallback** (Sonnet): kicks in only for relationship questions
  ("who founded X") when plain hybrid search underperforms.

**B. A knowledge layer, built in the background.**
- **Synthesis** (`MEMEX_DREAM_SYNTHESIS`, Haiku): on quiet-hours ticks the brain
  distils your notes into concepts, opinions ("takes"), and a calibration profile
  — stored in a *separate* store; your original notes are never touched.
- **Deep synthesis / take grading** (Sonnet): deepen and score those takes.
- **Facts** — memex pulls concrete claims ("Acme's contract renews in March") out
  of what you write, as you write it, and keeps them tidy: names are matched back
  to the right page instead of spawning duplicates, and a superseded claim is
  retired when a newer one lands. You can also *declare* facts yourself in a
  `## Facts` block on a page — that block is a **fence**: those claims are yours,
  and the brain won't quietly drop them even as it prunes its own.
- **Reflections, then patterns** — over your recent sessions the brain writes short
  **reflections** (what happened, what was decided), then makes a second pass that
  reads across many reflections and surfaces the **patterns** — themes that keep
  recurring — as their own pages. Both are paid and off by default; reflections
  feed the pattern pass, so a run does both in order.
- **`think`** (Sonnet): an on-demand "reason deeply about this question" command
  that returns a synthesized, cited answer. For a *time* question ("when did X
  change, is it still true?") it figures out which entities you mean even if you
  didn't name one, and pulls in each one's **trajectory** — the log of how that
  thing changed over time — so the answer reflects the latest state, not a stale
  snapshot.
- **Contextual embeddings** (`MEMEX_CONTEXTUAL_LLM`, Haiku): before fingerprinting
  a chunk, prepend a short blurb situating it in its document ("from the note about
  the Acme deal…") so an otherwise-ambiguous chunk is found more reliably.

So internal models make search *more accurate* and let the brain *understand its
own content* — the final answer is still written by your MCP client using what was
retrieved.

## 5. Multi-tenant by design

One deployment can serve more than one person or company. Each is an isolated
`source_id`; sharing is explicit (`federated_read` grants). Reads and writes are
scoped to the caller's grant, and operational tools (`stats`, `advisor`, the job
queue) are operator-only. A blind clone stays single-user; the isolation only
matters once you provision a second tenant. See [tenancy.md](./tenancy.md).

## 6. The shape (and why)

memex is deliberately small: **one Docker container on one EC2 instance**, an
**RDS Postgres** for the index, an **EFS** mount for config that survives rebuilds,
and **AWS Secrets Manager** for the tokens. The only public surface is `POST /mcp`
(+ `GET /health`), reached through a **Cloudflare Tunnel** — no load balancer, no
extra AWS ingress. It fits on one small box and you can read the whole thing in an
afternoon. Full topology in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 7. It maintains itself

A background cycle runs every few hours: it indexes new content, re-embeds stale
documents, and (during quiet hours) runs the synthesis layer — distilling takes,
writing reflections, and mining the patterns across them. It's careful not to
waste effort: editing one line of a page re-embeds only the chunk that changed,
not the whole document, and it won't turn its own reflections and patterns back
into raw input for another pass. No cron babysitting — the brain keeps itself
current.

And it checks its own work. A nightly **eval probe** runs a fixed set of
questions against the brain and records how good the retrieval was, so quality
drift shows up as a trend you can read (`memex doctor`) rather than a surprise. It
runs under a spend ceiling, so the self-check can't run up a bill.
