# Multi-tenancy — design

Status: **design / in-progress**. This is the authoritative plan for making
memex a multi-user, company-deployable brain. The approach is a well-trodden
column-scoped multi-tenancy pattern — no invented architecture — adapted to
memex's stack (Bun + `postgres.js` + RDS Postgres, AWS Bedrock, single
container on one EC2).

## Decisions (operator, 2026-06-25)

| Axis | Decision |
|---|---|
| Auth model | **External IdP (Cognito)** issues JWTs; memex validates them. No self-hosted login UI. |
| Isolation | **Column-scoped**: a `source_id` column on every content row; app-layer `WHERE source_id = ANY($scope)` filtering, **plus an RLS backstop** on the core content tables (defense-in-depth — security review reversed the original "RLS later" call). |
| Tenant unit | **Source-keyed**: tenant = a `sources` row. Per-user private source + a shared org source via `federated_read[]`. |
| Scope of first build | Build the MVP tenancy now; **live deploy is a separate, gated step** (no prod RDS change without explicit "deploy"). |

memex fronts the data/scope model with Cognito-issued JWTs. The OAuth provider
(`oauth-provider.ts`) is retained for **client-credentials machine tokens**
and the admin-registered legacy `access_tokens` path; the human-login path is
Cognito. These coexist — both resolve to the same `AuthInfo`.

## The two axes

1. **`source_id` (intra-DB logical tenancy).** Every `pages`,
   `content_chunks`, `links`, `timeline`, `ingest_log`, `files` row carries
   `source_id TEXT NOT NULL REFERENCES sources(id)`. `(source_id, slug)` is the
   page unique key.
2. **OAuth client → source binding.** Each token carries `sourceId` (write
   authority) + `allowedSources[]` (read federation, from
   `oauth_clients.federated_read`). Threaded into every engine call via
   `sourceScopeOpts()` / `resolveRequestedScope()`.

memex maps a Cognito JWT's subject (or a custom `source_id` claim) to a
`sources` row + `federated_read[]` via a small lookup, producing an
`AuthInfo`.

## Build map — component by component

| Component | memex target | Risk | Status |
|---|---|---|---|
| Scope resolver | `src/core/scope.ts` | none (additive) | **this PR** |
| OAuth/auth schema tables | migration `046_oauth.sql` | none (additive) | **this PR** |
| OAuth 2.1 provider | `src/core/oauth-provider.ts` (Bun `Response`, postgres.js) | medium | next |
| `AuthInfo`/`OperationContext`/`sourceScopeOpts`/`resolveRequestedScope` | `src/core/auth-info.ts` | medium | next |
| JWT verifier | `http/oauth.ts` — extend to return `{sourceId, allowedSources}` from a `token_sources` lookup / JWT claim | medium | next |
| Op dispatch | `mcp/dispatch.ts` + `http/server.ts` — thread `AuthInfo` → populate `sourceIds` on every op | **high** (touches every tool) | next |
| `source_id` columns + `(source_id, slug)` page key | migration `047_source_id.sql` | **highest** (pages PK change) | after review |
| Admin SPA + static serve | `src/http/admin/*` + Bun static serve | medium | later phase |

## `source_id` migration (047) — the high-risk part

memex content tables that gain `source_id`:
`documents` (already nullable from mig 004 — backfill + NOT NULL), `pages`,
`chunks`, `links`, `typed_links`, `entity_facts`, `timeline_events`, `tags`,
`page_aliases`, and the `synth_*` family.

Pattern: `source_id TEXT NOT NULL DEFAULT 'default' REFERENCES sources(id)`.

### Where isolation is actually enforced (architect review — CRITICAL)

The search arms filter on **`documents.source_id`** (`search/vector.ts:13`,
`search/keyword.ts:27`), NOT `pages.source_id`. But `pages` is the canonical
store and reaches the index through the page→content bridge
(`page://<slug>` documents, mig v1.3.54). **So `source_id` must propagate the
whole chain: a page's `source_id` → its bridged `documents` row → its `chunks`
→ `embeddings`.** If it doesn't, page content indexes as `'default'` and the
post-filter is theater. Defining and testing this propagation path is the
prerequisite for 047 — the isolation test must assert on **page-derived**
content, not just a raw document.

### Incremental PK path (architect review — adopted, lower blast radius)

Do NOT change the pages PK to composite in the MVP. Keep `slug` as PK and:
- add `pages.source_id TEXT NOT NULL DEFAULT 'default' REFERENCES sources(id)`,
- add `UNIQUE(source_id, slug)`,
- add `page_versions.source_id`.

Single-tenant stays correct (slug unique within `default`). The only deferred
capability is same-slug-across-tenants — not MVP-critical. This avoids the
big-bang of forcing all ~48 slug-keyed call sites (across ~20 files:
`pages.ts`, `slug-canonicalize.ts`, `page-aliases`, …) to pass `source_id`
simultaneously. The composite PK is a later, separately-tested step.

### `sources` as the tenant registry (architect review — HIGH)

`sources.kind` is `CHECK IN ('vault','memory',…)` and `path_prefix` is
`NOT NULL UNIQUE` — neither fits a per-user tenant. 047 must widen the CHECK to
add `'tenant'` and give tenant rows a synthetic unique `path_prefix` (e.g.
`tenant:<id>`) so the boot-time prefix backfill in `sources.ts` doesn't
misclassify them. Do not smuggle tenants in as `kind='other'`.

## Must-fix before 047 + the provider port (from the two reviews)

1. **Page→document→chunk `source_id` propagation** is the core correctness
   path (above). Test on page-derived content.
2. **Cache keys must include `source_id`** — the two-layer query cache
   (mig 031) otherwise serves tenant A's hits to tenant B (cross-tenant cache
   poisoning). Fold `source_id` into the ranking/cache signature.
3. **Filter the full leak surface, not just the two arms**: graph traversal,
   `typed_links`/backlinks, `entity_facts` + `timeline_events` recall,
   `page_aliases`/slug-resolution, and the HNSW post-filter. Each unfiltered
   query is a silent full cross-tenant read.
4. **RLS backstop** (`FORCE ROW LEVEL SECURITY`) on `documents`, `chunks`,
   `pages`, `links`, `entity_facts` — second line of defense so one forgotten
   `WHERE` is not a full breach.
5. **`sourceIds` becomes a required param** in the query builders
   (`vector.ts`, `keyword.ts`, `pages.ts`) — no `?? []` default. Optional-empty
   *is* the forget-the-filter bug.
6. **Validate `federated_read[]` against `sources`** at registration time (no
   array FK in Postgres) + a periodic orphan check.
7. **`oauth_tokens.revoked_at`** added (done in 046) and gated in verify.
8. **`mcp_request_log.params`** must pass the existing public redaction before
   insert (it stores request bodies → PII/secret sink otherwise).
9. **Token hashing** must be HMAC-SHA256 (or bcrypt/argon2), or bare SHA-256
   only over ≥128-bit random tokens.
10. **CI grep gate** failing any `slug =` not paired with `source_id`, plus a
    regression test asserting `hasScope(['admin'],'agent') === false`.

## Backward compatibility

- `'default'` source seeded first; all existing rows backfill to it.
- The static public bearer maps to `source_id='default'`, redacted read — the
  current behaviour, unchanged.
- The internal token maps to `admin` scope, all sources — current behaviour.
- So a single-tenant install keeps working with one tenant named `default`.

## Vector-search isolation

The single shared HNSW index cannot enforce tenancy natively. MVP:
**app-layer post-filter** of HNSW candidates by `source_id` (cheap, slight
recall waste at small N-tenants), over-fetching `k` before the filter.
Acceptable at low-hundreds of users; breaks when one tenant's vectors dominate
the candidate set and starve others (~10⁵ vectors/tenant) — revisit with
partitioned indexes then. Both arms (`keyword.ts`, `vector.ts`) already accept
`sourceIds[]` but as an optional param; 047 makes it **required** (no
empty-default) and wires it from `dispatch.ts`.

## Entitlement floor

The tenancy grant for an OAuth subject — which `source_id` it may write to and
its `federated_read[]` set — is stored **server-side** in the `source_grants`
table (migration 048), keyed by the JWT `sub`. **Token claims are never trusted
for tenancy.** A `source_id` / `federated_read` JWT claim is user-influenceable;
treating it as authoritative would let any validly-signed token mint its own
scope. The IdP's only job is to prove identity (the `sub`); the grant is
provisioned out-of-band in `source_grants`.

On OAuth verify success, `http/server.ts` looks up `source_grants` by `r.sub`
and builds `AuthInfo` from the row, ignoring the claim-derived fields returned
by `http/oauth.ts`. An un-provisioned subject (no grant row) resolves to no
`sourceId`/`allowedSources`, i.e. `effectiveReadSourceIds() => undefined` —
unscoped but still public-redacted read, the existing public default. The
grant lives server-side keyed to the client/subject, not in the bearer.

## Out of scope for MVP

DCR self-service registration, per-client daily budget caps
(`budget_usd_per_day`), agent-binding columns (`bound_*`), brain federation
across hosts, and the composite `(source_id, slug)` pages PK (the incremental
`UNIQUE(source_id, slug)` ships first). Note: per-row RLS backstop is **in**
the MVP (moved up by the security review) — only same-slug-across-tenants and
host-level federation are deferred.
