# Idea Capture — Fast Inbox Writes

When the user drops a quick thought ("idea: try a polling fallback for
the gcal cron"), capture it without breaking flow. This is the
lightweight cousin of `signal-detect` — no decision tree, just a
write.

---

## When to use

- The user prefixes with "idea:", "note:", "todo:", "remind me…", or
  just states something speculative.
- Mid-conversation, you notice an open question that deserves to
  outlive the chat.
- A search via `memex search` returns nothing but the topic feels like
  it should exist — write a placeholder.

If unsure, lean toward writing. Vault inbox is cheap; lost ideas
aren't.

---

## How to write

```bash
SLUG="$(echo 'gcal polling fallback' | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-*\|-*$//g' | tr A-Z a-z)"
DATE="$(date -I)"
PATH_="inbox/${DATE}-${SLUG}.md"

/opt/<project>/bin/obsidian write "$PATH_" "---
type: idea
created: ${DATE}
source: telegram-chat
---

# gcal polling fallback

The cron occasionally times out when Google's OAuth token endpoint is slow.
Idea: build a small retry-with-jitter wrapper inside the gcal helper —
3 attempts, max 6 s total. If still failing, fall back to last-cached
events from the previous run.
"
```

Always include:
- **Frontmatter** (`type`, `created`, `source` — see `frontmatter-guard`).
- **Title H1** (matches the topic, not the slug).
- **One paragraph of context** so the future you can re-engage. A
  title-only file is almost useless six months later.

---

## Don't

- Don't overwrite an existing file. If `obsidian read $PATH_` returns
  content, append instead, or pick a fresh slug.
- Don't write outside the configured write-allowed subtree (typically
  `inbox/` and `memory/`). The helper rejects bypass attempts.
- Don't write to the journal unless the user explicitly asked —
  `signal-detect` decides when journal entries land.

---

## What happens after

The chokidar watcher in memex notices the new file, embeds it via
Bedrock Titan, and adds it to the index within ~1 s. Future searches
surface it. No follow-up action needed.
