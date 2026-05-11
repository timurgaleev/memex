# memex — Personal-Knowledge Brain

Use this skill to **search the operator's indexed knowledge** — the
Obsidian vault, plus any other content that has been ingested. Hybrid
retrieval combines vector (Bedrock Titan v2 embeddings) + keyword
(tsvector) search via Reciprocal Rank Fusion.

CLI: `/opt/<project>/bin/memex`

The brain is a *retrieval index*, not the source of truth. The Obsidian
vault is canonical; memex rebuilds itself from it. If the brain misses
something, fall back to grep / `obsidian search`.

---

## When to use proactively

Use memex **before** asking the operator for context, whenever the
answer might already be in their notes:

- Project facts ("what's the IAM role on the <project> ECS task?")
- Past decisions ("did we agree on Nova Pro or Nova Lite for the
  morning briefing?")
- People / company / date references
- Configuration lookups ("what hostnames does HA expose?")

If the search returns relevant chunks, cite them by `sourcePath` and
prefer their content over fabrication. If the search returns nothing
relevant, say so explicitly — don't invent.

---

## Commands

### Search
```bash
/opt/<project>/bin/memex search "<query>" [limit]
```
Default `limit` is 5. Returns JSON
`{ ok, hits: [{ chunkId, documentId, sourcePath, title, content, score }, ...] }`
sorted by RRF score descending.

### Index a one-off file
```bash
/opt/<project>/bin/memex index /vault/path/to/note.md
```
Used when the watcher missed a file (rare; the chokidar watcher in the
memex container picks up vault changes within ~1 s).

### Health check
```bash
/opt/<project>/bin/memex health
```
Returns `{ ok, db, version, stats: { documents, chunks, embeddings } }`.

---

## Retrieval tips

- Phrase queries as natural language ("home assistant zigbee setup"),
  not boolean. The embedding model handles paraphrasing.
- Short queries work fine — vector search needs only ~3 content words.
- For exact-phrase lookup (filenames, IDs), keyword search inside RRF
  will surface them too — quote-marks not required.
- The `score` is RRF-fused rank, not similarity. Compare scores within
  one query, not across queries.

---

## Caveats

- **Obsidian vault read-only**: memex only reads `/vault`. To *write*
  a note, use the `obsidian` skill (`/opt/<project>/bin/obsidian`).
- **Other recipes (Gmail/Telegram)** may not be wired in every
  deployment — check `<project>.yml` for the active recipe list.
- **Index drift**: if the vault and index diverge, run
  `docker exec deploy-memex-1 bun run src/cli.ts integrity --vault /vault`
  or kick a sweep with `reindex --all`.
