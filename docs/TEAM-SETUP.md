# Running memex for a team

How to take a working single-operator brain and put several people on it, each
with their own private space. Task-oriented; the knob-by-knob reference lives in
[CONFIGURATION.md](./CONFIGURATION.md), the install in
[DEPLOYMENT.md](./DEPLOYMENT.md).

Everything here assumes memex is already deployed and healthy.

---

## Pick the shape first

There are two ways a person's tenant gets decided, and the right one depends on
something outside memex: **who is allowed to add a connector in your chat
client.**

| | Per-person clients | One connector + enrollment codes |
|---|---|---|
| Each person adds their own connector | required | not possible |
| What the person types | client ID + secret | a one-time code |
| Works on a plan where only an Owner can add connectors | ✗ | ✓ |
| Operator work per person | register a client | issue a code |

On a plan where members add their own connectors (individual paid accounts),
**per-person clients** are simpler — the tenant comes from the client row and
there is nothing to type but the credentials.

On a Team or Enterprise plan **only an Owner can add a connector**, and every
member authorises against that one client. One connector would therefore be one
tenant for everybody. That is what **enrollment mode** exists for: the tenant is
bound to the *authorisation* instead of to the client.

Publishing one connector per person into a shared organisation catalogue is not
a third option — every member sees all of them and can enable any one. That is
isolation on the honour system.

---

## Setup — one connector, many people

### 1. A source per person

```bash
memex sources register alice --kind other --path-prefix tenant:alice
memex sources register bob   --kind other --path-prefix tenant:bob
```

### 2. One connector, in enrollment mode

```bash
memex auth register-client team-connector \
  --tenant-mode enrollment \
  --scopes 'read write' --source default \
  --redirect-uris 'https://<chat-host>/api/mcp/auth_callback,https://<alt-host>/api/mcp/auth_callback'
memex auth set-budget <client_id> 2.00
```

Prints the client ID and secret **once**. Register every callback origin the
client might use — the list is fixed at registration, and changing it means
re-registering, which rotates the secret.

`--source default` here is only the fallback for a grant that names nothing; an
enrolled session always overrides it.

### 3. A code per person

```bash
memex auth enroll alice --label alice --client <client_id> --ttl 30d
memex auth enroll bob   --label bob   --client <client_id> --ttl 30d
```

Each prints a code **once**. Single-use, expiring, revocable; only its SHA-256
is stored.

### 4. Hand it over

- The **Owner** gets the URL, client ID and secret, and adds the connector once
  at organisation level.
- **Each person** gets their own code, privately.

A code is a bearer credential: whoever types it first owns that space. Send them
person-to-person, never into a shared channel, and never reuse one for two
people.

### What the person then does

Clicks **Connect**, is shown a single field, pastes the code, and is returned to
the chat client. That is the whole experience — no account, no login, and never
again after the first time. The refresh token carries the binding, so the
connection renews itself indefinitely as long as it is used inside the refresh
window.

---

## Why sharing the connector secret is safe

The client ID and secret identify **the application**, not a person. They will
sit in an organisation's connector settings where every member can read them,
and that is fine — but only because of one specific property, which is worth
verifying rather than assuming:

```bash
memex auth list-clients | grep -A2 '"client_name": "team-connector"'
# grant_types must be ["authorization_code","refresh_token"] — NOT client_credentials
```

**If `client_credentials` is present, the design collapses**: anyone holding the
secret could mint a token with no code at all. It is absent when the client is
registered with `--redirect-uris`, which makes it a browser client. Check it.

With that in place, the secret alone yields nothing:

| Attempt with the real secret | Result |
|---|---|
| `POST /token` with `grant_type=client_credentials` | `invalid_client` |
| `GET /authorize` | the code form; no code minted |
| `POST /authorize` with a guessed code | `400`, "not accepted" |

Someone who adds the same connector without a code gets a form and stops there.

Wrong, used, expired, revoked and issued-for-another-client codes all fail
identically, so the form cannot be used to probe which codes exist. The claim is
one atomic `UPDATE`, so two people racing the same code cannot both win.

---

## The login gate

`MEMEX_OAUTH_REQUIRE_LOGIN=1` — which bootstrap writes into **every new
install** — gates `/authorize` on a signed-in operator.

`/admin/login` accepts exactly one credential: the operator bootstrap token.
There is no per-user login. So with that flag on, a teammate can only complete a
connector flow by holding an operator session for the whole brain, which is
worse than what the flag was guarding against.

Enrollment mode does not consult the flag — the code *is* the resource-owner
authentication. But a `client`-mode connector behind it is unusable by anyone
but the operator. Keep the flag for a brain that serves one operator and nobody
else; take it off otherwise.

**Never hand out the admin panel or its token.** It opens the whole brain.

---

## Day-2 operations

```bash
memex auth enrollments                   # id, label, source, expiry, used/revoked — never the code
memex auth revoke-enrollment <id>        # kill one that leaked before it was used
memex auth enroll alice --label alice --client <client_id> --ttl 30d   # re-issue
memex auth list-clients                  # who exists, in which mode, on which source
memex auth set-budget <client_id> 2.00   # daily USD ceiling; 'none' removes it
memex auth revoke-client <client_id>     # cut a connector off entirely
```

**Someone leaves.** Revoke any unused code of theirs. Their source keeps their
notes, and `memex sources delete` refuses while any content or live grant still
names it — it prints what is holding the reference rather than orphaning a
credential, so cleaning up is deliberate work, not one command. Removing access
without touching data means revoking the client they authorised through, which
on a shared connector cuts everybody off: there is no per-person revoke yet, so
rotating the connector (re-register, re-issue codes) is today's answer.

**Budgets are per client.** Everyone on one team connector shares one
`budget_usd_per_day`. Size it for the group, not per head; per-grant budgets are
not implemented (see `TODO.md`).

**Check who landed where.** Have the person run the `whoami` tool from their
client: it returns the write source and read set their token actually carries —
the fastest way to confirm an enrollment did what you meant.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `redirect_uri is not registered` | the callback origin was never registered; hosts differ between a vendor's domains | re-register the client with every origin |
| Person sees an admin login, not a code field | the client is in `client` mode with the login gate on | `rescope-client … --tenant-mode enrollment`, or take the gate off |
| `That code was not accepted` | used, expired, revoked, or issued for another client — deliberately indistinguishable | `auth enrollments` shows which; re-issue |
| Person lands in the wrong space | codes were swapped at handover | revoke, re-issue, hand over again |
| `budget_exhausted` on search or think | the connector hit its daily ceiling | raise it, or wait for the UTC day to roll |
| Writes succeed but nothing is findable | budget ran out mid-index: the note is stored unembedded, on purpose | raise the cap, then `memex embed` |

---

## Before you rely on this

- Set `MEMEX_TENANT_FAIL_CLOSED=1`. Without it, an authenticated principal
  carrying **no** grant falls back to the redacted whole brain rather than to
  nothing — and every rule above keys off the grant.
- Leave Dynamic Client Registration off. A self-registered client lands on the
  shared `default` tenant.
- Read the open items in [`TODO.md`](../TODO.md) before treating tenant
  isolation as absolute. The fences are real and tested, but the list is the
  honest edge of what has been proved.
