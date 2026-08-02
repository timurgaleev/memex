---
name: publish
description: Share brain pages as beautiful password-protected HTML with client-side encryption
triggers:
  - "share this page"
  - "publish page"
  - "create shareable link"
tools:
  - page_get
  - search
  - put_raw_data
mutating: false
---

# Publish Skill

Share brain pages as beautiful, self-contained HTML documents. Optionally
password-protected with client-side AES-256-GCM encryption. No server needed.

The agent does the work end-to-end: fetch the page with `page_get`, strip
every piece of private metadata, render a single self-contained HTML file,
and (by default) encrypt it. This skill defines the stripping rules, the
crypto contract, and the sharing workflows.

## Contract

- Published HTML is fully self-contained: no external dependencies, no server needed.
- All private metadata (frontmatter, source citations, confirmation numbers, brain cross-links, timeline) is stripped before publishing.
- Password protection uses AES-256-GCM with PBKDF2 key derivation; plaintext never appears in the encrypted HTML file.
- Default is always encrypted unless the user explicitly requests "open", "no password", or "public".
- External URLs (`https://...`) are preserved; only internal brain paths are stripped.

## When to Publish

- User asks to share a brain page, create a shareable link, or says "give me a page"
- User wants to send a deal memo, person briefing, or research to someone external
- User asks to publish a data room analysis or trip plan
- Any time brain content needs to leave the brain without exposing the whole system

## Default: ALWAYS ENCRYPT

Brain content is private. Default to password-protected unless the user explicitly
says "open", "no password", or "public".

If no password is specified, auto-generate one. Share the password via a different
channel than the URL.

## Workflow

1. `page_get <slug>` — fetch the page (use `search` first if you only have a topic).
2. Strip private metadata per the table below.
3. Render the remaining markdown as a single HTML file (inline CSS, no
   external assets) with a clean document layout and the page title.
4. Unless the user said "open"/"no password"/"public": encrypt the
   rendered body with AES-256-GCM (parameters below) via a small local
   script, and emit an HTML shell that decrypts client-side with the Web
   Crypto API on password entry.
5. Write the file to the requested output path (default: a scratch/tmp
   path or the user's Desktop) and report per the Output Format.

## What Gets Stripped

Remove all private/internal data before rendering:

| Stripped | Example | Why |
|---------|---------|-----|
| YAML frontmatter | `title:`, `type:`, `tags:` | Internal metadata |
| `[Source: ...]` citations | All formats | Provenance is internal |
| Confirmation numbers | `ABC123DEF` -> "on file" | PII/booking data |
| Brain cross-links | `[Jane](../people/jane)` -> `Jane` | Internal paths |
| Timeline section | Everything below `---` / `## Timeline` | Raw evidence log |
| "See also" lines | Internal references | Brain navigation |

**Preserved:** external URLs (`https://...`), all other content.

## Sharing Workflows

### Option A: Local file (simplest)

Render to a file, e.g. `~/Desktop/jane-briefing.html`, encrypted with an
auto-generated password.

Share the HTML file via email, Slack, Airdrop. Share the password separately.

### Option B: Keep a copy in the brain

Store the published artifact alongside the brain for later re-sharing:

```
put_raw_data key=shares/acme.html data=<the rendered HTML>
```

Retrieve it later with `get_raw_data` — no re-render needed as long as the
source page hasn't changed.

### Option C: Static hosting (Render, Netlify, S3)

Upload the HTML file to any static hosting service. The file is self-contained,
no server logic needed. Password-protected files work entirely client-side via
Web Crypto API.

### Option D: GitHub Pages / Gist

Render (e.g. `trips/japan-2026` → `trip.html`), then upload to a GitHub
Gist or Pages repo.

## Password Protection Details

- **Algorithm:** AES-256-GCM
- **Key derivation:** PBKDF2 with 100K iterations, SHA-256
- **Salt:** Random 16 bytes per encryption
- **IV:** Random 12 bytes per encryption
- **Decryption:** Client-side via Web Crypto API (SubtleCrypto)
- **No server auth needed** -- the HTML file is self-contained
- **"Remember on this device"** -- saves password in localStorage

When encrypted, the published HTML contains ONLY ciphertext. The plaintext is
not present anywhere in the file.

## Updating a Published Page

Re-run the workflow against the same output path with the same password.
Same file, same URL (if hosted), updated content.

## Revoking Access

Delete the file. If using static hosting, remove the file from the host.
If a copy lives in the brain under `shares/`, it is private there — only
the exported file needs revoking.

## Anti-Patterns

- **Publishing without encryption.** Brain content is private. Default to password-protected unless the user explicitly says "open", "no password", or "public".
- **Sharing password and URL in the same channel.** Always share the password via a different channel than the URL for security.
- **Assuming the user wants raw markdown.** The deliverable is a rendered, self-contained HTML document. Don't copy-paste markdown when this workflow exists.
- **Including internal metadata.** Never share content that still contains frontmatter, source citations, or timeline sections. Strip first, render second.

## Output Format

```
PUBLISHED: [page title]
========================

File: [output path]
Encrypted: [yes (AES-256-GCM) / no]
Password: [auto-generated password / user-provided / none]
Size: [file size]

Share the file via: [email / Slack / Airdrop / cloud upload]
Share the password via: [a different channel]
```

## Tools Used

- `page_get` -- fetch the source page
- `search` -- locate the page when only a topic is given
- `put_raw_data` / `get_raw_data` -- optional brain-side copy of the artifact
- Local script (agent-side) -- deterministic strip + render + encrypt; no LLM calls in the render step
