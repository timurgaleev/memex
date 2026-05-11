# obsidian — Persistent Memory via Obsidian Vault

The operator's long-term memory lives in an Obsidian vault. The vault
is bidirectionally synced via `obsidian-headless` and Obsidian Sync —
anything you read here is current within ~60 seconds of the
operator's edits, and anything you write appears in their vault on
their local devices within ~60 seconds.

CLI: `/opt/<project>/bin/obsidian`

---

## MANDATORY: Session Boot Sequence

At the start of every main session, run in order:

```bash
# Replace the paths below with the memory notes you actually maintain
# inside your configured write-allowed subtree.
/opt/<project>/bin/obsidian read <memory-path>/identity.md
/opt/<project>/bin/obsidian read <memory-path>/user-profile.md
/opt/<project>/bin/obsidian read <memory-path>/home-context.md
/opt/<project>/bin/obsidian search "stack" 3
```

If a memory file does not exist yet, that is normal — the boot
sequence proceeds. Do not ask the user for context that already
exists in these files.

---

## MANDATORY: Save at Session End

Before every `/new` or `/reset`:

- New facts about the user → `obsidian append <memory-path>/user-profile.md "..."`
- Infrastructure changes → `obsidian append <memory-path>/infra.md "..."`
- Home context changes → `obsidian append <memory-path>/home-context.md "..."`
- Daily journal → `obsidian append "$(obsidian journal-today)" "..."`
- Explicit "remember this" → save immediately

Do not skip. If unsure — save it.

---

## Vault Layout (write-allowed paths)

The write-allowed subtree is configured per-deployment. A typical
layout is:

```
<write-allowed-root>/
  <journal-dir>/<date>.md       — daily journal entries
  <memory-dir>/<topic>.md       — long-term observations (one file per topic)
  <inbox-dir>/<slug>.md         — scratch / unfiled
```

Everything outside the write-allowed root is read-only. The helper
CLI rejects writes outside this subtree — do not try to bypass it.

---

## Commands

```bash
/opt/<project>/bin/obsidian read <path>             # read a vault note (any path)
/opt/<project>/bin/obsidian write <path> <content>  # overwrite (write-allowed only)
/opt/<project>/bin/obsidian append <path> <content> # append (write-allowed only)
/opt/<project>/bin/obsidian search <query> [limit]  # recursive search across vault
/opt/<project>/bin/obsidian list [folder]           # list markdown files
/opt/<project>/bin/obsidian journal-today           # prints today's journal path
```

`<content>` may be passed as an argument or via stdin.

---

## Context Separation Rules

The vault often contains both home/personal and work/dev context.
When responding in a home / briefing context (Telegram, morning
briefing, HA checks), only surface home-related notes. Work tasks
belong to work sessions only — do not mention them in:

- Morning briefings
- Home automation responses
- HA checks

---

## Sync Notes

- Sync daemon: `obsidian-sync.service` (systemd, runs as a non-root
  service user).
- Vault path on disk: `/mnt/<project>-efs/<project>/vault/`
  (EFS-backed, survives instance replacement).
- If sync stops working, check `journalctl -u obsidian-sync -n 50`
  and the container's log output.
