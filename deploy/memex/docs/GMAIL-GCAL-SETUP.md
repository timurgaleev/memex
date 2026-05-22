# Gmail + GCal recipe setup walkthrough

Deployment checklist for wiring up the Gmail and GCal ingestion
recipes on a fresh install. Both use Google Cloud OAuth; both store
credentials in AWS Secrets Manager.

> Need to redo a step? All actions here are idempotent — re-running
> the OAuth flow produces a new refresh token, the older one is
> invalidated by Google.

## TL;DR

```bash
# 0. Make sure you're authenticated to AWS.
aws sso login --profile <your-profile>   # or whichever profile you use

# 1. Gmail bootstrap (one command — wraps the venv + pip dance).
AWS_PROFILE=<your-profile> ./scripts/gmail-oauth-bootstrap.sh

# 2. Once Gmail is done, deploy the recipe.

# 3. GCal: re-auth + Production verification (separate step after
#    you're ready to publish the consent screen).
```

## Prerequisites

- A machine with a browser — the OAuth flow needs one.
- `python3` on PATH.
- AWS CLI configured with a profile that has read/write on the
  Secrets Manager prefix used by this stack
  (`<secrets_prefix>/gmail-oauth`, `<secrets_prefix>/google-calendar`).
- Cloned repo (the wrapper script lives at
  `scripts/gmail-oauth-bootstrap.sh`).

## Step 1 — Gmail OAuth: get a refresh token

The wrapper script handles the system-Python/pip mess (PEP 668
"externally-managed-environment") by creating a project-local
virtualenv. You don't need to install anything else by hand.

### Run it

```bash
AWS_PROFILE=<your-profile> ./scripts/gmail-oauth-bootstrap.sh
```

What happens:

1. Wrapper creates a local virtualenv (idempotent — reuses on re-run).
2. Installs `google-auth-oauthlib` + `boto3` in that venv.
3. Reads `client_id` + `client_secret` from
   `<secrets_prefix>/gmail-oauth` in Secrets Manager.
4. Opens a browser tab on `accounts.google.com` for consent.
5. After you accept, captures the auth code on `localhost`, exchanges
   it for a refresh token.
6. Writes the refresh token back into the same secret.

### Common errors

| Symptom | What it means | Fix |
|---|---|---|
| `command not found: python3` | No system Python. | Install Python 3. |
| `error: externally-managed-environment` running raw `pip3` | You ran `pip3` instead of the wrapper. | Use the wrapper — it does the venv automatically. |
| `Google did not return a refresh_token` | You've already authorized this client before; Google won't re-mint until the existing grant is revoked. | Open https://myaccount.google.com/permissions, revoke the app, re-run. |
| `An error occurred (AccessDenied)` on `secretsmanager:PutSecretValue` | Your AWS profile doesn't have write on this secret. | Use a profile with admin on the configured `<secrets_prefix>`. |
| Browser doesn't open | Headless / SSH / VPN. | Run on a real desktop or copy the printed URL into a browser. |

### Verify

```bash
AWS_PROFILE=<your-profile> aws secretsmanager get-secret-value \
  --secret-id <secrets_prefix>/gmail-oauth \
  --region <your-region> \
  --query SecretString --output text | jq '.refresh_token != null'
# expected: true
```

### Rotate the client secret

The Desktop OAuth `client_secret` is by Google's design not really a
secret — it's expected to ship with the app — but if it ever ends up
exposed, treat it as compromised: open Google Cloud Console →
Credentials → the OAuth Client → **Reset secret** → paste the new
value into the secret via:

```bash
AWS_PROFILE=<your-profile> aws secretsmanager get-secret-value \
  --secret-id <secrets_prefix>/gmail-oauth \
  --region <your-region> --query SecretString --output text \
  | jq --arg new 'GOCSPX-newvalue' '.client_secret = $new' \
  | AWS_PROFILE=<your-profile> aws secretsmanager put-secret-value \
      --secret-id <secrets_prefix>/gmail-oauth \
      --region <your-region> --secret-string file:///dev/stdin
```

## Step 2 — what the recipe does (after Step 1)

The Gmail recipe registers a `mailbox` source in the `sources` table
and schedules a `gmail.poll` job kind:

- **Cron cadence:** hourly (configurable via `poll_minutes` in the
  Secrets Manager entry — currently `60`).
- **Signal-detect:** Nova Lite classifier picks the top
  `signal_threshold` fraction of inbound mail (currently `0.10` =
  10 %) and writes the matching messages to
  `vault/inbox/gmail/<date>-<subject-slug>.md`.
- **Indexing:** the existing obsidian recipe sweeps the vault, so
  newly-written messages get embedded automatically. No new path.
- **Source-boost:** the `mailbox` source has `boost_weight = 0.6`
  by default (less preferred than vault, more than transient memory).
  Tune via `memex sources update gmail --boost-weight 0.8`.
- **Quiet hours:** `mailbox` source registered with
  `respect_quiet_hours = true` so polling skips the configured
  morning briefing window.

## Step 3 — GCal: publish the OAuth app + re-mint the refresh token

The `gcal` helper will only get long-lived refresh tokens once the
Google Cloud app is **In production**. While in Testing mode, refresh
tokens have a 7-day TTL.

Plan ~1 hour total, mostly waiting on Google.

### 3a. Pre-publish checklist (do this first)

Before clicking *Publish App* you need three things ready:

1. **Privacy policy URL — public, must return 200 OK.**
   - Source of truth: `PRIVACY.md` at the repo root.
   - Host it under your own domain (e.g.
     `https://<your-subdomain>.<your-domain>/privacy`).
   - Sanity check: `curl -sSI https://<your-subdomain>.<your-domain>/privacy`
     returns `200`.
2. **Home page URL — also 200 OK.**
3. **Authorized domain.** Google requires the bare apex of any URL
   listed above to appear in *Authorized domains*. Use
   `<your-domain>` (no scheme, no subdomain).

You also need the OAuth client ID for the Desktop client that's
already wired into `<secrets_prefix>/google-calendar`.

### 3b. Click-through walkthrough

1. Open https://console.cloud.google.com → pick the project that
   already owns the OAuth client (same one the Gmail flow uses).
2. Sidebar → **APIs & Services** → **OAuth consent screen**.
3. Confirm:
   - **User type:** External (Internal is only available to Google
     Workspace tenants).
   - **App name:** keep it consistent with the Gmail flow so
     reviewers see continuity.
   - **User support email:** `<your-email>`.
   - **App logo:** leave blank — not required for verification.
   - **App domain → Application home page:**
     `https://<your-subdomain>.<your-domain>`
   - **App domain → Application privacy policy link:**
     `https://<your-subdomain>.<your-domain>/privacy`
   - **Authorized domains:** `<your-domain>`.
   - **Developer contact information:** `<your-email>`.
4. **Scopes** screen — confirm the existing scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.readonly`
   Both are *sensitive* (yellow shield), neither is *restricted*
   (red shield).
5. **Test users** screen — anything there is irrelevant once
   published.
6. Back on the OAuth consent screen, click **Publish App** → confirm.
   Status flips from *Testing* to *In production*.

### 3c. Verification — what Google will (probably) ask for

For sensitive scopes used by a single-account app where the only
authorised account is the operator's own, verification is typically
fast. The reviewer may request:

- **30-second screen-recording** of the consent screen, narrated:
  "this is a personal AI assistant; it requests `gmail.readonly` to
  ingest mail into a private knowledge base, and `calendar.readonly`
  to ingest upcoming events; no data is shared with third parties."
  Upload to YouTube as *Unlisted* and paste the link in their reply.
- **Confirmation that the privacy policy URL** matches the one in
  the consent screen.

Email arrives within a few hours. Reply same-day; full verification
typically completes in 24–72 hours.

### 3d. Re-mint the refresh token (after the green badge)

Once the app is in production (no TTL on refresh tokens any more),
re-run the OAuth flow with the new wrapper:

```bash
AWS_PROFILE=<your-profile> ./scripts/gcal-oauth-bootstrap.sh
```

Same shape as the Gmail wrapper — opens a browser, captures the
auth code on `localhost`, exchanges it for a refresh token, writes
the refresh token back into `<secrets_prefix>/google-calendar`.
Idempotent on re-run.

### 3e. Verify

```bash
# Helper round-trips against Calendar API (from the bridge container,
# which has the helpers mounted at /opt/memex/bin/):
docker exec deploy-telegram-bridge-1 /opt/memex/bin/gcal today

# Recipe-side dry-run:
docker exec deploy-memex-1 \
  bun run src/cli.ts gcal poll --horizon-days 7 --dry-run
```

## What's stored where

| Secret | Used by | Bootstrap |
|---|---|---|
| `<secrets_prefix>/gmail-oauth` | Gmail recipe | `scripts/gmail-oauth-bootstrap.sh` |
| `<secrets_prefix>/google-calendar` | `gcal` helper + GCal recipe | `scripts/gcal-oauth-bootstrap.sh` |
| `<secrets_prefix>/memex-public-bearer` | memex HTTP server | rotated daily via the systemd timer in `deploy/systemd/` |

| Source row | Path prefix | Boost | Quiet-hours skip |
|---|---|---|---|
| `vault` | `/vault/` | 1.0 | false |
| `gmail` | `gmail:` | 0.6 | true |
| `gcal` | `gcal:` | 0.6 | true |

Manage with the `memex sources` CLI:

```bash
docker exec deploy-memex-1 memex sources list
docker exec deploy-memex-1 memex sources show gmail
```

## Daily ops cheat sheet

```bash
# Check the current rotated bearer:
AWS_PROFILE=<your-profile> aws secretsmanager get-secret-value \
  --secret-id <secrets_prefix>/memex-public-bearer \
  --region <your-region> --query SecretString --output text

# Inspect the rotation timer:
systemctl list-timers --no-pager | grep memex
journalctl -u memex-rotate-bearer.service --since '24 hours ago' --no-pager

# Manually trigger rotation (rare — testing only):
sudo systemctl start memex-rotate-bearer.service
```
