---
name: query
version: 1.0.0
description: |
  Answer questions using the brain's knowledge with 3-layer search, synthesis,
  and citation propagation. Use when the user asks a question, wants a lookup,
  or needs information from the brain.
triggers:
  - "what do we know about"
  - "tell me about"
  - "who is"
  - "what happened"
  - "search for"
  - "look up"
  - "background on"
  - "notes on"
  - "who knows who"
  - "relationship between"
  - "connections"
  - "graph query"
tools:
  - search
  - query
  - page_get
  - page_list
  - backlinks
  - graph_query
  - traverse_graph
  - entity_timeline
mutating: false
---

# Query Skill

Answer questions using the brain's knowledge with 3-layer search and synthesis.

## Contract

This skill guarantees:
- Every answer is grounded in brain content (no hallucination)
- Every claim has a citation tracing back to a specific page slug
- Gaps are flagged explicitly ("the brain doesn't have information on X")
- Source precedence is respected (user statements > compiled truth > timeline > external)
- Conflicting sources are noted with both citations

## Phases

1. **Decompose the question** into search strategies:
   - Keyword-flavored search for specific names, dates, terms
   - Semantic search for conceptual questions
   - Structured queries (list by type, backlinks, graph) for relational questions
2. **Execute searches:**
   - `search` — hybrid keyword+semantic retrieval with expansion (the main entry point)
   - `query` — direct structured lookups when you know exactly what you're asking for
   - `page_list` by type or `backlinks` for structural questions
3. **Read top results.** Read the top 3-5 pages via `page_get` to get full context.
4. **Synthesize answer** with citations. Every claim traces back to a specific page slug.
5. **Flag gaps.** If the brain doesn't have info, say "the brain doesn't have information on X" rather than hallucinating.

## Anti-Patterns

- Answering from general knowledge when the brain has relevant content
- Hallucinating facts not in the brain
- Silently picking one source when sources conflict
- Loading full pages when search chunks are sufficient
- Ignoring source precedence (user statements are highest authority)

## Output Format

Answers should include:
- Direct response to the question
- Citations: "According to [Source: people/jane-doe, compiled truth]..."
- Gap flags: "The brain doesn't have information on X"
- Conflict notes when sources disagree

## Quality Rules

- Never hallucinate. Only answer from brain content.
- Cite sources: "According to concepts/do-things-that-dont-scale..."
- Flag stale results: if a search result shows [STALE], note that the info may be outdated
- For "who" questions, use `backlinks` and typed links to find connections
- For "what happened" questions, use `entity_timeline`
- For "what do we know" questions, read the entity page (compiled truth) directly

## Token-Budget Awareness

Search returns **chunks**, not full pages. Read the excerpts first before deciding
whether to load a full page.

- `search` returns ranked chunks with context snippets. These are often
  enough to answer the question directly (`get_chunks` can pull more of a
  specific document if a hit is truncated).
- Only use `page_get <slug>` to load the full page when a chunk confirms the
  page is relevant and you need more context (e.g., compiled truth, timeline).
- **"Tell me about X"** -- get the full page (the user wants the complete picture).
- **"Did anyone mention Y?"** -- search results are enough (the user wants a yes/no with evidence).

### Source precedence

When multiple sources provide conflicting information, follow this precedence:

1. **User's direct statements** (highest authority -- what the user told you directly)
2. **Compiled truth** (the brain's synthesized, cited understanding)
3. **Timeline entries** (raw evidence, reverse-chronological)
4. **External sources** (web search, API enrichment -- lowest authority)

When sources conflict, note the contradiction with both citations. Don't silently
pick one. `find_contradictions` can surface disagreements the brain already knows about.

## Citation in Answers

When referencing brain pages in your answer, propagate inline citations:
- Cite the page: "According to [Source: people/jane-doe, compiled truth]..."
- When brain pages have inline `[Source: ...]` citations, propagate them so
  the user can trace facts to their origin
- When you synthesize across multiple pages, cite all sources

## Graph Traversal

For relationship questions ("who knows who at X?", "connections between A and B",
"who works at Acme?", "who attended the standup?"), use the graph layer instead
of full-text search:

- `graph_query` with `slug`, `type` (link type), `depth`, and `direction` (`in|out|both`)
- Available link types: `attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, `source`
- `direction: in` answers "who points to X?" (e.g., who works at company X)
- `direction: out` answers "what does X point to?" (default)
- `depth: N` controls multi-hop traversal (default 5); `traverse_graph` for open-ended walks

Examples:
- "Who works at Acme?" → `graph_query slug=companies/acme type=works_at direction=in`
- "Who attended Demo Day W26?" → `graph_query slug=meetings/demo-day-w26 type=attended direction=out`
- "What companies has Emily advised?" → `graph_query slug=people/emily type=advises direction=out`
- "Who has Alice met (via meetings)?" → `graph_query slug=people/alice type=attended depth=2`

Combine with `search` for queries that need BOTH semantic similarity AND
graph structure. Search results are ranked with a small backlink boost so well-
connected entities surface higher.

## Search Quality Awareness

If search results seem off (wrong results, missing known pages, irrelevant hits):
- Run `run_doctor` (or `memex doctor` from the shell) to check index health
- Check embedding coverage via `stats` -- partial embeddings degrade hybrid search
- Check the active ranking configuration with `memex search modes` (shell) to
  see which ranking stages are on for this brain
- Report search quality issues in the maintain workflow (see maintain skill)

## Tools Used

- Hybrid search (`search`)
- Direct structured lookups (`query`)
- Read a page (`page_get`)
- List pages with filters (`page_list`)
- Check backlinks (`backlinks`)
- Typed graph queries (`graph_query`)
- Traverse the link graph (`traverse_graph`)
- View timeline entries (`entity_timeline`)
