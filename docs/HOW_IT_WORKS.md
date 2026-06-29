# How memex works

A complete, end-to-end tour of the system: what happens to a note from the
moment it is ingested to the moment your AI agent cites it in an answer. Read
this if you want to understand the whole machine, not just run it. For the
runtime topology and AWS resources see [`ARCHITECTURE.md`](../ARCHITECTURE.md);
for the design lineage see [`PARITY.md`](../PARITY.md).

---

## 1. What memex is, in one breath

memex is a **personal knowledge brain you run in your own cloud**. It reads your
markdown notes and your code, turns them into a hybrid search index plus a small
knowledge graph, and exposes that to **any MCP agent** (Claude Code, Cursor,
Codex) so the agent can search your memory and **cite the exact source**.

Three principles shape every design decision:

- **Brain-only, not a chatbot.** memex is a *retrieval brain*. It finds and ranks
  the right passages; it does not synthesize prose answers. Synthesis is the
  agent's job (the MCP client). This keeps memex deterministic, cheap, and
  auditable — every result points at a real source.
- **Self-hosted and private.** It runs entirely in your AWS account. No SaaS, no
  telemetry, no third party sees your notes. Your second brain stays yours.
- **DB-canonical.** The database is the source of truth. Pages are written
  through the API and mirrored into the search store; the index is always
  re-derivable from the canonical data.

---

## 2. The big picture

```
  your notes (.md) ─┐
  your code      ───┤
  pages via API  ───┤
                    ▼
            ┌──────────────┐   embed (Bedrock Titan v2, 1024-d)
            │   INGEST     │──────────────┐
            │ parse·chunk  │              ▼
            └──────────────┘        ┌───────────┐
                    │               │ Postgres  │  documents · chunks
                    ▼               │ + pgvector│  embeddings · entities
            ┌──────────────┐        │ + pg_trgm │  links · facts · pages
            │ ENRICH       │───────▶│           │
            │ entities·    │        └───────────┘
            │ links·facts  │              ▲
            └──────────────┘              │ hybrid search (vector + keyword)
                                          │ RRF fusion → rerank → cite
                              ┌───────────────────────┐
                              │  MCP server (Bun)      │◀── Claude Code / Cursor
                              │  search · get · graph  │     (over MCP)
                              └───────────────────────┘
                                          ▲
                              ┌───────────────────────┐
                              │  MAINTENANCE CYCLE     │  re-embed · reconcile
                              │  (12 phases, ~6h tick) │  links · salience · snapshot
                              └───────────────────────┘
```

Everything is one Bun/TypeScript daemon talking to one Postgres (with the
`vector` and `pg_trgm` extensions). The same code runs against embedded PGLite
in tests, so the whole system is exercised hermetically with no cloud calls.

---

## 3. Ingestion — turning content into a searchable index

A document enters through one of three doors, all of which funnel into one
`indexDocument` path:

1. **Vault sweep** — a recursive walk of your markdown tree; a file is
   (re)indexed when its mtime is newer than the last indexed time.
2. **Code sweep** — a graph-only pass over a source repo (call/def/ref edges; no
   embeddings).
3. **Page writes via MCP** — `page_put`/`page_append` write a canonical page,
   which is mirrored into the search store.

Inside `indexDocument`, each document goes through:

- **A 5 MB size cap.** Enforced on *both* the file path and the in-memory content
  path, so no caller — not even a remote MCP write — can store an unbounded blob.
- **Frontmatter inference (at ingest).** A content file with no `---` header gets
  one synthesized from its path and first heading (title, type, date, tags) — a
  pure, deterministic, per-file step. memex does *not* run a recurring job to
  back-fill frontmatter; inference happens once, where the content arrives.
- **Chunking.** The body is split into overlapping, structure-aware chunks
  (heading-anchored, size-bounded). Code is chunked per symbol instead.
- **Embedding.** Each chunk is embedded with **Amazon Titan Text Embeddings v2**
  (1024 dimensions) via Bedrock. Embedding happens *before* any DB write, so a
  failed embed never leaves a half-written document. A page can opt out
  (`embed_skip`) and stay keyword-searchable without a vector.
- **Atomic write.** The document, its chunks, their vectors, and the extracted
  entities are written in one transaction. A per-document `generation` counter
  and a global clock are bumped so the query cache knows what changed.

---

## 4. Retrieval — hybrid search that cites

This is the heart of memex. A `search` call runs **two arms in parallel** and
fuses them:

- **Vector arm** — cosine k-NN over the HNSW index (`pgvector`). Catches semantic
  matches ("how do I rotate creds" finds a note titled "secret management").
- **Keyword arm** — full-text search over a weighted `tsvector` (`pg_trgm` +
  Postgres FTS), with symbol identity weighted above body text for code.

The two ranked lists are merged with **Reciprocal Rank Fusion (RRF)** — a
rank-based fusion that needs no score calibration between the arms. On top of the
fused list memex layers a sequence of deterministic ranking signals:

- **Query-intent weighting** — factual/exact/topic/howto/personal intents shift
  the arm weights and the return size.
- **Title-phrase boost** — a contiguous query phrase in a page title lifts it.
- **Recency decay** — per-path-prefix half-lives (`daily/` ages fast,
  `concepts/` is evergreen).
- **Salience** — a "what matters" score from frontmatter weight + link-degree.
- **Evidence stamping** — each hit is tagged with *why* it matched
  (exact-title, both-arms, keyword-only), which the agent can reason about.
- **Near-duplicate dedup** — Jaccard-similar twins collapse to the best one.
- **Bounded query embedding** — the query-embed call races a deadline; on a
  stall, retrieval proceeds keyword-only rather than hanging.

A **two-layer query cache** (a global clock bookmark + a per-result
`{doc → generation}` snapshot) means a write to an *unrelated* document never
evicts your cached query, while a write to a *referenced* one does.

Every result carries its `source_path` and chunk, so the agent's answer can cite
exactly where each claim came from. Public/untrusted ingress is field-redacted;
privacy-sensitive graph reads stay internal-only.

---

## 5. The knowledge graph

Beyond passage search, memex builds a small graph so the agent can ask
*relational* questions ("who works at Acme", "what links to this note"):

- **Entities** — wikilinks, hashtags, and dates extracted from every chunk by a
  fast, deterministic regex pass (no LLM).
- **Links** — `[[wikilink]]` edges, resolved to real pages; plus optional
  gazetteer "mentions" (plain-text references to known entity pages) and
  typed-NER edges (`works_at`, `founded`, `attended`, …) inferred from
  frontmatter and verb context.
- **Facts** — a `## Facts` fence in a page is parsed into structured
  `entity_facts` with confidence and optional validity windows (facts can decay
  or expire at recall time).
- **Provenance + freshness** — link extraction, entity extraction, and chunking
  each carry a version watermark, so bumping the extractor re-processes only
  what changed, incrementally.

These are exposed as MCP tools (`entity_recall`, `graph_neighbors`, `backlinks`,
`find_orphans`, …) the agent calls explicitly.

---

## 6. The maintenance cycle

A background loop keeps the brain healthy without any human in the loop. Each
tick runs **twelve deterministic phases** under a database lock (so two cycles
never fight), honouring quiet hours so it doesn't steal CPU from live queries:

```
lint → embed-stale → mirror-pages → embed-facts → extract →
resolve-symbol-edges → reconcile-links → orphans-purge →
recompute-salience → extract-timeline → snapshot → purge
```

Design notes that make it robust on a small instance:

- **Incremental everywhere.** `embed-stale` re-embeds only chunks past a staleness
  threshold; `extract` re-processes only documents whose entity watermark is stale
  (never the whole corpus). Heavy phases are bounded by per-cycle caps.
- **Crash-safe locking.** The cycle lock has a short TTL with an active sub-TTL
  refresh, so a crashed container's lock frees within minutes and the next tick
  reclaims it — regardless of which host died.
- **Self-observing.** Each phase logs its peak RSS; a `cycle-freshness` doctor
  check flags a stalled loop; a memory cap turns any runaway into a clean restart
  instead of a host-wide failure.
- **First tick is prompt.** The loop fires its first tick shortly after boot (not
  a full interval later), so a frequently-redeployed brain still cycles.

---

## 7. The MCP interface

memex speaks one protocol: the **Model Context Protocol**. The agent connects
(locally over stdio, or remotely over HTTP with a bearer token) and gets a small,
contract-derived tool surface — `search`, `get_chunks`, `page_get`, `page_put`,
`entity_recall`, `graph_neighbors`, `add_fact`, … — whose schemas and input
validation are generated from a single `OPERATIONS` contract, so the client and
server never drift. Errors are structured envelopes that withhold internals on
the public path. There is no other way in: no web UI for content, no SQL access,
no SaaS API.

---

## 8. Why it is shaped this way

memex is a **faithful port** of a more mature reference brain — features are
copied and adapted, not reinvented — adapted to one stack difference: a single
`engine.query` over Postgres/PGLite, `MEMEX_*` env, soft-deletes, and a
single-holder model. The lineage is documented in [`PARITY.md`](../PARITY.md).
Where the reference and memex's DB-canonical design agree, memex follows the
reference exactly; where memex is genuinely simpler (one source, one holder), it
collapses the reference's multi-tenant machinery rather than carrying dead code.

The result is a system that is small enough to read end-to-end, deterministic
enough to test without the cloud, and private by construction.

---

## 9. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Bun + TypeScript (one daemon) |
| Store | Postgres + `pgvector` (HNSW) + `pg_trgm`; PGLite for tests |
| Embeddings | Amazon Bedrock — Titan Text Embeddings v2 (1024-d) |
| Light inference | Bedrock Nova Lite (intent classification, query expansion) |
| Interface | Model Context Protocol (stdio + HTTP) |
| Infra | Single EC2 in your AWS account, Terraform-managed, deployed via SSM |
| Admin | React 19 + Vite 6 SPA served at `/admin` |

---

## 10. Where to go next

- **Run it:** [`README.md`](../README.md) — the quickstart.
- **Operate it:** [`ARCHITECTURE.md`](../ARCHITECTURE.md) — topology, secrets,
  deploy flow.
- **Understand the lineage:** [`PARITY.md`](../PARITY.md) — what was ported and
  what is deliberately out of scope.
- **Track the work:** [`CHANGELOG.md`](../CHANGELOG.md) and
  [`TODO.md`](../TODO.md).
