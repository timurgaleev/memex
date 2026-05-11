# Signal Detection — When to Persist Something

Conversation surface is high-volume; the vault is the durable layer.
This skill teaches you when an exchange contains a *signal* worth
writing to the vault versus mere chat that should evaporate.

---

## Heuristics (in order of confidence)

### Strong signals → write immediately

- **Explicit ask:** the user says one of "remember this", "save this",
  "note that", "don't forget", or a language-equivalent phrase.
- **Decision:** the user picks an option after weighing alternatives
  ("ok, let's go with t4g.medium not small"). Capture the decision +
  a one-line rationale.
- **New fact about the user:** profession, family, preferences,
  scheduling constraints, current projects. Update the user-profile
  note.
- **Infrastructure / system change:** any AWS / docker / app /
  home-assistant configuration that's now different from before.
  Update the infra note.
- **Incident retro:** "this broke because X, fixed by Y". Capture as
  a dated inbox file.

### Soft signals → write only if unique

- Casual mention of an event ("on Thursday we have dinner"). Promote
  to a frontmatter `event:` only if it's new — gcal is the source of
  truth for the calendar, not the vault.
- Opinions ("Nova Pro felt slow last week"). Capture only if they
  could inform a future decision.
- Status updates about ongoing projects — let the journal cover these.

### NOT signals — don't persist

- Chit-chat, greetings, weather small talk.
- Tool output the user asked you to fetch and read aloud (it's
  already in the underlying system, e.g. HA, gcal).
- Exchanges that are entirely about correcting a typo or refining a
  previous request.

---

## Where to write each signal type

| Signal | Vault path |
|---|---|
| Decision | `<memory>/decisions-<topic>.md` (append) |
| New fact about the user | `<memory>/user-profile.md` (append) |
| Infra change | `<memory>/infra.md` (append) |
| Incident retro | `<inbox>/<date>-<slug>.md` (new) |
| Idea / scratch | `<inbox>/<date>-<slug>.md` (new) — see `idea-capture` |
| Daily journal | `$(obsidian journal-today)` (append) |

Always write via `/opt/<project>/bin/obsidian append` — the helper
enforces the write-allowed boundary configured for the deployment.

---

## After writing

The memex recipe picks up the new file via chokidar within ~1 s. No
manual reindex needed. If the user asks for something a few seconds
after you've written it, `/opt/<project>/bin/memex search` will
already return it.
