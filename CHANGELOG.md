# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **The typechecker now covers the tests too, and the exclusion is gone.** The
  gate shipped scoped to `src/` because `tests/` still carried 59 errors, almost
  all `noUncheckedIndexedAccess` on array reads. Those are closed, so
  `tsconfig.src.json` is deleted and `bun run typecheck` is the whole package —
  there is no longer a second command reporting a backlog nobody watches. The
  fix for an unchecked index is an assertion that the element exists, not an
  optional chain: `facts[0]?.claim_metric` compiles and hides the case where the
  array came back empty. One test was doing exactly that — indexing a result it
  never proved non-empty, with both assertions `toBeUndefined()`, so it would
  have passed just as happily had the parser returned nothing. It now asserts
  the length first.

### Changed
- **`TODO.md` carries the work, not the research behind it.** The file had grown
  to 4038 lines, most of it audit transcripts — findings, the refutation log
  that killed a third of them, and citations into trees that are not this one.
  None of that is actionable and none of it belongs in a public backlog. What
  remains is the work itself: open items, the decisions behind each deferral,
  and where in this repo each one lands. Doc comments picked up the same trim —
  a few carried a build-wave label that meant nothing outside the session that
  coined it.

## [1.121.0] — 2026-08-13

### Added
- **Doctor checks say when they could not run.** The verdict was binary, so a
  check that THREW rendered byte-identical to one that passed — eight catch
  blocks pushed `ok: true` with the error text as the detail, and the MCP
  surface repeated it. Checks now carry `status: "ok" | "warn" | "fail"` beside
  `ok`, using the vocabulary the cycle runner already defined rather than a new
  one, and the report rolls up to the worst. `ok` stays the exit-code driver: a
  warn must not red a cron probe on a brain that is serving fine. Two states
  that were silently green — never cycled, and a future timestamp meaning clock
  skew — are warns now. A static guard fails the build if any catch path
  reports a pass.
- **Every paid model call books a row.** Eight independent Bedrock invoke sites
  each built their own command, three of them bypassing the budget tracker
  entirely, and the ledger had exactly one row for all time because only the MCP
  settle path wrote to it. All eight now pass through one chokepoint carrying an
  operation label, and usage is recorded in a `finally` so a call that threw is
  still billed — a failed paid call costs real money and used to book nothing.
  Embeddings get their own price axis instead of being priced as chat, and
  prompt-cache tokens are charged at their real rates rather than as plain
  input. No ceiling moved: this is accounting, not enforcement. A ledger write
  that fails is logged and swallowed, the way telemetry already behaves.
- **A query can find a page by its name.** The keyword arm ranks chunk text; a
  page whose proper noun appears only in its title was invisible to it, and the
  title and slug boosts run after fusion — boosts with nothing to boost. Pages
  named by a query now enter the candidate set. The other half of that eval miss
  is recorded, not papered over: for question-shaped queries the keyword arm
  returns nothing at all because every term is ANDed, and the measured remedy
  (an OR fallback) costs more precision than it buys.

### Fixed
- **A credential is required on both ingresses.** Authentication used to hinge
  on a guess about how the request arrived: no `Cf-Connecting-Ip` meant
  "internal", and internal meant allowed without the Authorization header being
  read at all. Writes survived that because a separate internal-token check
  followed, but every read tool was reachable with no credential. The ingress
  classification still decides redaction and rate-limit keying — it no longer
  decides whether a credential is needed. Pre-credential routes (`/health`,
  OAuth discovery, the token endpoints) are exempt on both ingresses, so the
  container healthcheck and the discovery flow keep working. The escape hatch
  is unchanged: with no internal token configured, the legacy fall-through still
  allows, and boot still says so loudly.
- **Every failed authentication attempt is metered.** The pre-auth throttle
  skipped exactly the caller it existed to stop: with no trusted client IP the
  key was null, the gate never tripped, and the failure was never charged — an
  unmetered brute-force channel costing two database round-trips per attempt.
  Keys now fall back from trusted IP to socket address to one shared bucket,
  which gets its own wider but finite ceiling so one unattributable sprayer
  cannot starve another.
- **Restating a fact no longer mints a duplicate.** With on-write extraction
  enabled, every re-save of a page re-inserted the same claims verbatim; the
  ledger only ever grew. An identical claim about the same entity, from the same
  source and writer, now refreshes the row on file. Identity is the tuple
  consolidation already used, so the two agree instead of each having their own
  notion of "the same claim".
- **A claim always ages, and always names a writer.** Consolidated takes and
  fence rows landed with a blank `kind`, which decay cannot see — so a take
  stayed at full strength forever while every member fact beneath it decayed.
  Provenance was enforced on one tool rather than on the write path, so rows
  kept arriving with a NULL writer. Both invariants now hold where every caller
  passes, and migration 100 backfills the rows written before they did: a blank
  kind becomes `belief`, an unnamed writer becomes `unattributed`. It touches
  only NULL cells, so a re-run is a no-op, and it deletes nothing — collapsing
  the duplicates already on file is an operator's call, not a migration's.
- **The CLI flag vocabulary is per command.** One global set meant `memex doctor
  --remediate` was rejected as unknown — the entire self-heal surface was
  unreachable — while `memex reindex --stale` was accepted and silently ignored.
  Each command now declares what it reads. A per-command `--help` short-circuits
  before validation, so `memex watch --help` reaches its help text instead of an
  argument error, and a flag that takes a value and is given none is an error
  naming the flag.
- **Tree-sitter trees are given back.** Every swept file leaked one tree plus one
  per symbol into the Emscripten heap for the process lifetime; a boot sweep over
  a few thousand files leaked tens of thousands. Parsing now runs through a
  helper that releases in a `finally`, so a throw cannot skip it.
- **The grammar check uses the grammars.** It compared blob bytes against a
  manifest generated from those same blobs, which can only ever confirm the blobs
  are the blobs — during the incident it was green while every shell file threw.
  It now loads each grammar and parses a probe. That costs ~109 MB resident
  (measured), which the old check deliberately avoided; it is paid once per
  process, and a code sweep links the same grammars anyway.
- **Truncation is visible on both model tiers.** The stop reason rode only the
  reasoning-tier transport, so every utility-tier call parsing structured output
  was truncation-blind and could not be fixed at its call site. An event-dense
  page whose JSON array was cut reported zero events, booked the spend, and
  flagged nothing. Both transports now carry it, and the calls that lost work
  retry with more room — within their existing USD budget, reporting the
  truncation rather than returning a partial result as if complete.
- **`entity_recall`'s token budget is a cap.** The page arm did not enforce it,
  and the split across arms was fixed, so an entity that is all facts — the
  common shape — returned at most half the answer the caller paid for while the
  page and timeline allocations sat unused. Unused allocation now flows to the
  arms that have content.
- **Concept-shape detection stopped firing on entity lookups.** The cue bank had
  no suppressors, so "overview of Acme Corp" was simultaneously classified as an
  entity lookup and flagged as possibly a partial set — a wasted round-trip and
  unfounded doubt about a complete answer. A word-count floor and an
  exact-identifier anti-signal now run first, and the two cues that collided with
  our own entity bank were narrowed.
- **The search token budget is a ceiling again.** It truncated the overflowing
  hit and kept it, with a floor that still emitted the whole title plus a token
  of body — a 400-character title under a 50-token budget returned 102 tokens.
  Whole items only now: what does not fit is dropped and counted, and a first
  item that alone exceeds the budget yields an empty result, because the caller
  asked for a hard cap.
- **The PGLite lock stopped handing the directory to whoever asked second.**
  It treated anything it could not parse as stale and took over: an unreadable
  file, a truncated pid line, and the zero-byte window between `wx` creating the
  lock and the owner writing its pid into it all read as "nobody holds this".
  Two starts racing was enough — the second read the first's half-written lock
  as garbage and stole it, which is precisely the two-writer corruption the lock
  was shipped to prevent. A file that exists but names no readable owner is now
  refused, not cleared. Separately, a process probe that failed with anything
  other than "no such process" was counted as dead; only that one verdict means
  death now, because a false "dead" reaps a live writer while a false "alive"
  merely refuses a start the operator can see. The probe is injectable so the
  unknown-errno branch is testable at all, and the test that asserted the old
  take-it-over behaviour is rewritten with the reason it was wrong.

- **Every surface that answers "what am I running" now answers with the build.**
  The previous release pointed `/health` at the build stamp and stopped there —
  but MCP is the only contract this brain has, and the four surfaces an agent
  actually reaches were left on `package.json`, which is pinned at `0.1.0` by
  design. `get_brain_identity`, `get_status_snapshot`, the advisor report and
  `doctor` all reported that constant while the container ran a tagged build.
  Nine call sites now read the one stamp. The advisor's version-drift collector
  needed both of its sides moved together: changing only the reported version
  would have made it cry drift on every call. Three tests asserted the version
  matched `\d+.\d+.\d+`, which held on a constant that could never change —
  they now pin the stamp and assert it is not the package constant.
- **Three regex slips.** A `timeout` alternative already covered by the
  `timed?\s?out` beside it, `round` listed twice in one alternation, and a
  module imported on three separate lines. None changed behaviour; all three
  were found by running a linter over the source for the first time.

### Added
- **The TypeScript is typechecked now.** Every other language in the repo had a
  static gate — `shellcheck` for the shell, `fmt`/`validate` for Terraform, a
  guard script for the migrations — while the 74k lines the product is actually
  written in had none. `tsc` had never been run here at all; its first run
  reported 61 errors, and one of them was a live defect (see the doctor fix
  below). `make typecheck` and a CI step now gate `src/`, which is clean. The
  49 remaining errors all sit under `tests/` and are tracked in `TODO.md`;
  `bun run typecheck:all` reports the count so it is a number to watch fall
  rather than a silent exclusion.
- **`deploy/deploy.sh` stamps the image and then proves it.** The build arg,
  the Dockerfile `ENV`, `version.ts` and the `/health` payload were wired end to
  end, but nothing ever supplied the value — `MEMEX_VERSION` was absent from the
  host environment, so compose fell through to its `dev` default and every image
  ever built carried that stamp. The script computes it from `git describe`,
  builds, waits for healthy, and refuses to succeed unless the running container
  reports back the same stamp. A container that comes up healthy while still
  serving the previous image is the failure a deploy check exists to catch, and
  the one a constant version string cannot.

### Fixed
- **`/health` reported a version that could never change.** The field was
  `package.json`'s version, which is pinned at `0.1.0` on purpose — the build
  stamp lives in `MEMEX_VERSION` and is baked into the image. So the one
  externally-visible version surface answered `0.1.0` for every image ever
  built, and a deploy check reading it could not tell a fresh container from a
  six-month-old one. It now reports the build stamp. The existing test asserted
  only `typeof version === "string"`, which passed throughout.
- **The doctor's engine check said nothing about the engine on Postgres.** Its
  detail read `path` straight off the `DatabaseConfig` union; that field exists
  only on the PGLite variant, so on a Postgres brain — which is what runs in
  production — it serialised as `undefined` and vanished from the report. The
  branch now lives in a small exported function, because a test driving
  `doctor` can only ever exercise the PGLite side without a live Postgres, and
  the bug was on the other one. Found by running `tsc` over the codebase for
  the first time.

## [1.120.0] — 2026-08-12

### Added
- **The advisor says when takes are being written faster than they can ever be
  graded.** `propose-takes` writes on every synthesis tick, but `grade-takes`
  only considers takes past `MEMEX_GRADE_MIN_AGE_DAYS` — 182 by default,
  because a claim about the future needs time to come true before judging it
  means anything. On a brain younger than that bar the paid producer runs
  nightly and the grader selects nothing, reporting a clean phase with zero
  grades written — indistinguishable from "there was nothing new to grade".
  The finding names how many takes are waiting and when the oldest reaches the
  bar. It fires only when the bar is the sole blocker: a brain with no takes,
  or one where at least one take is already mature, stays silent.

## [1.119.1] — 2026-08-12

### Fixed
- **A retrieval-quality probe that measured nothing reported as one that
  passed.** The nightly probe replays `eval_queries`; with none registered it
  scores 0/0 and records the run under `ok:true`, and `doctor` rendered that as
  `mean_rr=0.000 hit_rate=0.000 (scored 0/0)` — a run that measured nothing,
  filed as a run that came back clean. Forty consecutive nights had recorded it
  on the live brain without anything saying so. `doctor` now names the empty
  eval set instead of printing zeros, and the advisor carries a `eval_set_empty`
  finding with the streak length and the command that registers a query. The
  streak resets on `total_queries`, not `scored`: a probe that replayed queries
  and matched none did measure — that is a retrieval problem, and a different
  finding from having no eval set at all.

## [1.119.0] — 2026-08-12

### Added
- **A benchmark for what the brain volunteers.** The retrieval eval answers
  "when asked, does search find it?"; nothing answered what an agent actually
  experiences — when nobody asked, did the brain offer the right pages, and did
  it stay quiet when it had nothing to say. Six labelled conversations, replayed
  through the real push path, scored for precision, recall, miss rate and
  false-fire rate. The last exists so the others cannot be gamed by volunteering
  everything; an unmeasured rate reports as `n/a`, never as a passing zero. It
  already recorded two blind spots in entity extraction as expected misses: an
  all-lowercase mention yields nothing, and a sentence-opening "Did Dana ever
  hear back" is read as the candidate "Did Dana".

## [1.118.0] — 2026-08-11

### Added
- **`memex page-retype` corrects the type of many pages at once.** `pages.type`
  decides which enrichment paths see a page, so one that should be `person` but
  landed as `note` quietly drops out of several reads — and the only remedy was
  issuing the writes one at a time with no preview. Preview is the default;
  `--apply` performs it. It does NOT touch `updated_at` (that is behavioural
  state — the stale-salient anomaly, the recency-biased salience rank and
  `get_recent_transcripts` all read it) and writes no page-version row (a type
  change is not a body edit); the operation is recorded as a single `ingest_log`
  row instead. It refuses based on the rows it matched rather than the arguments
  it was given, and refuses retyping *into* a fenced type outright.

### Changed
- **`recall` says what it is.** Its description now states plainly that it reads
  ONE fact by id and names the tools that search — an agent reaching for it
  expecting a search was a routing problem, and descriptions are what route.

## [1.117.0] — 2026-08-11

### Added
- **PGLite says why it would not open.** The engine adapter had no error
  handling at all, so a refusal reached the operator as whatever Emscripten
  threw — usually a bare `Aborted()`. Failures now carry a named cause and a
  next step, and `memex doctor` inspects the data directory with plain
  filesystem calls (pid file, control-file size, `PG_VERSION`, WAL segment
  count) — a diagnosis you can only get by opening the thing that will not open
  is no diagnosis.

### Changed
- **A second process is refused a PGLite data directory.** Two processes on one
  directory is how it gets corrupted; the guard takes over a lock whose owner is
  dead, verifies ownership before releasing, refuses a second handle in the same
  process, and fails closed if it cannot place a lock at all — with
  `MEMEX_PGLITE_NO_LOCK=1` as the deliberate way out. **This changes behaviour:**
  a CLI command run against a running daemon's PGLite directory is now refused.
  The database-level lock it used to rely on required both processes to open the
  database, which is the corruption itself — safe on Postgres, never safe on
  PGLite. Production runs Postgres and is unaffected.

## [1.116.0] — 2026-08-11

### Added
- **`entity_recall` takes one token budget for the whole answer.** It returns a
  page, facts and a timeline together, and nothing could cap them together — so
  a caller working to a context budget had to guess the split, fetch, measure
  and call again. Pass `token_budget` and the split is decided server-side, with
  whatever one arm does not use flowing to the others. The response carries a
  `budget` report of what was dropped or truncated, so a partial answer is never
  mistaken for a complete one. Each row is charged as it is serialized, not by
  its headline text, and the budget is applied after redaction so the counts
  describe what you can actually see.
- **Response shapes are pinned.** `MEMEX_RESPONSE_VERSION` (reported at
  `initialize`) plus a registry of the top-level keys each covered tool returns.
  The input side has been generated from one contract and frozen against a
  snapshot for a while; the output side had nothing, so a renamed key would have
  shipped silently and a client would have met it in production. The registry
  states its own scope — it covers the registered tools, not the whole surface —
  and a conformance test drives each one for real.

## [1.115.0] — 2026-08-11

### Added
- **`stats` reports how the corpus is typed.** `page_put` permits an ad-hoc
  type and the brain's own writers use several that are not declared, but
  nothing counted the result — so a typo (`peson` for `person`) or a writer
  drifting to a new label stayed invisible until someone noticed a page missing
  from a type-filtered read. The breakdown now ships with the types nobody
  declared and how many pages sit under them. It counts; it does not reject.

### Changed
- **The orphan count stops counting pages the brain wrote for itself.**
  Synthesis output, drift reports and think drafts are orphans by design, and
  once they dominate the number it stops being read — 283 of 382 orphans on the
  maintainer's brain were synthesis page mirrors. The rule is provenance, not
  namespace: a page is skipped when its current version was written by one of
  the brain's own page writers. Excluding `atoms/` and `concepts/` by slug would
  have been simpler and wrong — those are ordinary namespaces, so an authored,
  genuinely unlinked page there would have vanished from the report meant to
  surface it. A page the brain merely *edited* (enrichment) still belongs to its
  author and is still reported, and a remote caller cannot stamp itself with a
  reserved writer to hide its own page. Two env keys tune it per brain:
  `MEMEX_ORPHAN_EXCLUDE_WRITERS` replaces the list,
  `MEMEX_ORPHAN_EXCLUDE_EXTRA` appends; setting the first to empty counts
  everything.

## [1.114.0] — 2026-08-11

### Added
- **Every fact now says where it came from.** An unattributed fact cannot be
  audited, aged against its origin, or weighed during synthesis. `add_fact`
  still accepts `source_slug` / `source_chunk_id` / `written_by`; a caller that
  supplies none is now credited to its own identity rather than landing
  anonymous. A public caller cannot set `written_by` at all — that is the audit
  field, and an anonymous writer claiming `operator` would launder its own
  writes.

### Security
- **`written_by` is no longer returned to public readers.** With every
  unattributed write now credited to its caller, returning the field would hand
  an anonymous reader a roster of the brain's writers — for rows whose fact text
  they cannot read anyway.

### Fixed
- **A failed page→search mirror leaves a durable trace.** The caller saw
  `search_indexed: false` and the maintenance cycle reconciled later, but
  nothing outlived the request, so a page that quietly stayed unsearchable was
  invisible afterwards. It now writes an `ingest_log` row naming the page and
  the error. The page write itself still succeeds — it is already committed to
  the canonical store.

## [1.113.1] — 2026-08-11

### Fixed
- **The set-shaped hint no longer points at a door the caller cannot open.** It
  named `query`, which the public ingress forbids outright, and promised that
  `query` expands the question — while `query` inherits the same expansion
  setting, so under the exact configuration that triggers the hint it would have
  changed nothing. It also read the process-wide expansion setting rather than
  the one resolved for that call, so an operator passing `mode` got the hint
  backwards in both directions. It now reads the resolved value, names
  `expand: true` explicitly, and on the public path keeps the partial-results
  warning without naming an unreachable tool.
- **Two advisor findings stopped naming a fix that fixes something else.** The
  islanded-pages and dead-links findings had their `fix_command` corrected once
  already this release; the replacements were wrong in a subtler way. Every
  candidate command measures an adjacent but different set — `find_orphans`
  ignores outbound links and dead sources, `memex reconcile-links` compares
  wikilink entities against documents. Both findings now carry no fix_command
  and state the counted condition in `detail` instead, so nobody is sent
  somewhere that reports success while the condition stands.

## [1.113.0] — 2026-08-11

### Added
- **A set-shaped question now says so.** "All the companies working on X",
  "what are the different approaches to Y" — `search` answers those with a
  plausible non-empty list, and query expansion is off in two of the three
  search modes, so the caller has no way to tell the list is partial. `search`
  now returns an advisory `hint` pointing at `query` when the question reads as
  set-shaped and expansion is in fact off. The hits are unchanged; only the
  silence about their completeness is.

### Fixed
- **The advisor no longer sends you to a command that does not do the job.**
  The dead-link finding pointed at `memex doctor`, which has no dead-link check
  — following the advice printed `ok:true` while the links stayed broken. The
  islanded-pages finding pointed at `memex orphans`, which purges orphaned
  database rows and has nothing to do with pages. They now name
  `memex reconcile-links` and the `find_orphans` tool, and a test checks that
  every command an advisor finding names actually exists.

## [1.112.1] — 2026-08-11

### Fixed
- **`lint --dry-run`, `migrate-engine --dry-run` and `quarantine scan --apply`
  work again.** 1.112.0's new safety-flag guard carried a hand-written list of
  which commands honour `--dry-run`, `--apply` and `--fix`, and that list was
  wrong in both directions: it refused three invocations that were real, and it
  vouched for commands that never read the flag, so the guard was asleep exactly
  where it was supposed to be awake. The list is now checked against the command
  switch itself by a test, which fails the moment the two disagree.

## [1.112.0] — 2026-08-11

### Changed
- **The CLI now refuses flags it does not define.** Previously an unknown flag
  was collected and ignored. A script passing a flag memex never had will now
  fail instead of running without it — which is the point, but it is a
  behaviour change worth knowing before upgrading.

### Fixed
- **A cut-off answer is retried with more room, not the same room.** Every paid
  call picks an output cap, and Bedrock says when it hit that cap — but only the
  fact extractor was listening. `think` was the worst case: its retry replayed
  the identical prompt at the identical cap, and since these calls run at
  temperature 0, a truncated answer truncated again in the same place. Its
  default cap was also 1500 tokens for a structured JSON answer spanning up to
  12 pages and 20 takes, which cannot close — and an unclosed answer is thrown
  away whole, with the money already spent. The default is now 4000
  (`MEMEX_THINK_OUTPUT_TOKENS`), and a truncated call is retried once at double
  the cap when the budget covers it, across `think`, the graph rerank, the
  relational fallback, reflections, patterns, drift, enrich-thin and the
  contradiction judge.
- **A misspelled flag no longer runs the command anyway.** `memex embed
  --dry-runn` dropped the flag and started a real, paid backfill; every unknown
  flag did the same, and the fallback is always the mutating or paid path. The
  CLI now refuses a flag it does not define and suggests the intended one. It
  also refuses a correctly spelled safety flag on a command that would ignore
  it — `--dry-run` reading as "preview" while the command mutates is the worse
  failure.
- **`--help` on a subcommand prints help.** `memex search --help` answered
  "`<query>` is required", and `jobs` and `auth` likewise demanded arguments
  from someone asking what the arguments are.
- **The search token budget counts the title it returns.** The cap was measured
  against body text only, while the title ships with every hit — so a budget
  the caller asked for as a hard guarantee was quietly overshot.

## [1.111.1] — 2026-08-11

### Fixed
- **Facts written in the same millisecond no longer come back in an arbitrary
  order.** `written_at` is `DEFAULT NOW()` at millisecond resolution, so a burst
  of writes ties, and every `listFacts` ordering ended on that column with no
  further tiebreak — the "most recent fact" an agent read back was then whichever
  row the scan happened to produce. All three orderings (recency, confidence,
  semantic) now end in `id DESC`.

### Changed
- **The full local test run is sharded, by the same script CI uses.** Running all
  324 test files in one `bun test` process exhausts the PGLite WASM heaps —
  they only grow, even across `storage.close()` — so the run dies inside
  `pg_initdb` and reports hundreds of failures that have nothing to do with the
  code. The sharding loop moved out of the CI workflow into
  `deploy/memex/scripts/test-sharded.sh` (`bun run test:sharded`), so the local
  ship gate and CI cannot drift apart. CI behaviour is unchanged.

### Tests
- **The doctor category test had gone stale.** `code-grammars` shipped as a real
  check in 1.109.0 but was never added to the test's hard-coded union, so the
  suite had a standing failure that the broken full-suite run hid.

## [1.111.0] — 2026-08-10

### Security
- **A junk bearer no longer costs two database lookups.** An unverified token
  went straight to the OAuth verifier, and because the guard had already refused
  the request the in-handler rate limiter never fired on that path — so the
  brute-force route was the one route with no limiter at all. Failed
  verifications are now metered before the lookup, on the `/mcp` path only; the
  internal ingest path is deliberately left alone, because every docker-bridge
  peer shares one bucket there and a throttle would trade an unauthenticated-load
  risk for a self-inflicted internal lockout.
- **Rate-limit buckets are no longer shared by the whole internet.** The OAuth
  endpoints keyed on the socket address, which behind the tunnel is the proxy —
  one 10/min bucket for every caller. All header-keyed limiters now share one
  trust model: `Cf-Connecting-Ip` always, `X-Forwarded-For` / `X-Real-IP` only
  under the new `MEMEX_HTTP_TRUST_PROXY=1`, and an unattributable caller is not
  metered at all rather than being given a spoofable identity.
- **`auth rescope-client` can set and clear the slug write fence.** A fence could
  only be applied at registration, so narrowing an existing client's write scope
  meant revoking and re-registering it.

### Fixed
- **A remote agent can read back the fact it just wrote.** `add_fact` is
  reachable over the public write surface, facts default to `visibility:private`,
  and the reader floors every scoped caller to `world` — so an agent's own writes
  were invisible to it. `add_fact` now accepts `visibility` explicitly.

### Added
- **A USD ceiling on concept synthesis.** The phase had a call-count cap
  (`maxConcepts`), which is not a spend bound — 30 calls cost whatever 30 calls
  cost, and nothing stopped it spending against a model with no pricing entry.
  It now uses the existing budget tracker: the ceiling defaults ON
  (`MEMEX_CONCEPTS_BUDGET_USD`, default $0.50 — far above what a healthy run
  reaches), the pre-call estimate is measured from the prompt actually built
  rather than guessed, actual spend is recorded after each call, and one
  exhausted budget stops every later paid call instead of letting an unpriced
  model repeat itself. Concepts that miss out keep their deterministic
  narrative, so the run still completes.

## [1.110.0] — 2026-08-10

### Fixed
- **A boolean CLI flag no longer eats the argument after it.** `memex embed
  --dry-run <slug>` lost both the slug and the dry-run and started a real, paid
  whole-corpus backfill; `memex search --k=5 hello` searched with the default k
  and no search term, because `--key=value` arrived as one token and was never
  split. Flags are now classified by name, not by position, and `--key=value` is
  split on the first `=`. A bare `--flag=` (an unset shell variable) is refused
  rather than read as ON — guessing ON there would arm `--force` / `--apply` /
  `--fix` by accident.
  - **Two commands change behaviour as a result.** `memex hnsw --force rebuild`
    previously printed the status JSON (the flag swallowed `rebuild`); it now
    rebuilds the index, which is what it always read as. `memex search --explain
    stats` previously errored; it now dispatches the `stats` sub-command.
- **A malformed extractor response no longer discards a paid call.** One `null`
  element threw a TypeError out of the parser and binned every good fact
  alongside it; a response wrapped in prose ("Here are the facts: {...}") was
  dropped whole; and an unreadable `kind` was coerced to `fact` — the strongest
  kind — at confidence 0.7, which then aged as a confident objective claim.
  Elements are now validated individually, a JSON object is recovered from a
  fenced or prose-wrapped response, and an unreadable kind floors to `belief`.
- **The parse outcome is now discriminable.** A genuinely empty turn and an
  unreadable response both returned `[]`, so the conversation backfill treated a
  parse miss as "nothing to say" and re-extracted that page at Sonnet prices on
  every run, forever. The two are now distinct and a malformed response files a
  `parse_failure` absorb row.
- **A file whose grammar cannot be linked is indexed as text instead of being
  dropped.** The chunker's throw escaped before the document write, so the file
  produced no chunks and no embeddings and was invisible to both search arms —
  the mechanism behind the missing shell corpus. Such a file now falls back to
  the existing plain-text path, is logged once per language rather than once per
  file, and is deliberately stored with no mtime stamp so the next sweep retries
  it and the corpus heals itself once the grammar is fixed.

### Fixed
- **Query steering pointed the wrong way.** The skills claimed `search` runs
  with LLM query expansion; it does not — expansion is off in both default mode
  bundles and `search` has no `expand` knob at all (it lives on `query`). So a
  concept or landscape question went to `search`, recovered none of the
  vocabulary the note actually used, returned a plausible nonzero count, and the
  agent treated the answer as complete. The skill docs, the lookup chain and the
  `search` tool description now say what the code does, and route a thin
  concept-question result to `query` with `expand: true` — as an escalation
  within the existing ladder, not a competing rule.

## [1.109.0] — 2026-08-10

### Fixed
- **Shell scripts are indexable again.** The vendored `bash` and `go` grammar
  blobs were built against a different tree-sitter runtime than the pinned
  `web-tree-sitter`. They linked cleanly and parsed trivial input, then died
  inside the external scanner on ordinary syntax (`case…esac`, an array slice,
  ANSI-C quoting) with `resolved is not a function` — so every `.sh` file
  errored during the code sweep and the shell corpus was absent from the code
  graph. The boot log printed only an error count, so nothing surfaced it.
  Both grammars are re-vendored from their own pinned npm packages
  (`tree-sitter-bash`, `tree-sitter-go`), which ship prebuilt wasm.

### Added
- `wasm/manifest.json` binds every vendored grammar blob to a sha256 and the
  npm package it came from; `scripts/vendor-grammars.ts` regenerates it. A
  `code-grammars` check in `memex doctor` verifies the blobs still match
  (hashing, not linking — linking all six costs ~112 MB of RSS).
- `tests/grammar_selfcheck.test.ts` links and parses every declared grammar.
  Its bash fixture is deliberately scanner-heavy: it fails on the old blobs and
  passes on the new ones, which is the only reason it is a guard rather than
  decoration.
- `GrammarLoadError` names the language, path, size and reason when a grammar
  cannot be linked, in place of the empty `Error` Emscripten raises.

### Changed
- The code boot sweep now names the files it failed on. It logged
  `errors=15` and nothing else, so a failing file was undiagnosable from the
  boot log. Capped at 10 lines plus an `... and N more` tail, so a broken
  bind-mount cannot flood startup.

### Fixed
- Docs said the MCP server exposes 63 tools; the live surface is 91.
  `ARCHITECTURE.md` and `README.md` corrected.
- The comment above the post-write page re-read in `mcp/dispatch.ts` claimed
  an omitted title/body is preserved. It is not — `putPage` sets both columns
  unconditionally, so an omitted title lands as `NULL` and an omitted body as
  `''`. `page_put` is a full replace; the comment now says so.

## [1.108.0] — 2026-08-04

### Security
- **Auth no longer fails open behind a non-Cloudflare ingress.**
  Public-request detection keys on the `Cf-Connecting-Ip` header the
  Cloudflare edge injects; behind any other reverse proxy (Caddy, nginx,
  an ALB) every request classified as internal and the whole MCP surface
  was served **without auth** — found live on a Caddy-fronted deployment.
  New `MEMEX_ASSUME_PUBLIC=1` classifies every HTTP request as public
  (health/OAuth-discovery exemptions unchanged); serve now logs a loud
  startup caution when a public bearer is configured without the flag,
  naming the verification step (an unauthenticated `POST /mcp` must
  return 401). Set the flag on any non-Cloudflare deployment.

### Added
- **Caddy ingress mode** (`ingress_mode = "caddy"`): TLS terminates on the
  instance via Let's Encrypt — no Cloudflare account or tunnel needed, for
  domains whose DNS cannot move (e.g. a Route53 zone carrying production
  email). Terraform opens 80/443 (tcp + udp for HTTP/3) and manages the
  `<subdomain>.<domain>` A record (`caddy_manage_dns`); bootstrap runs
  Caddy as a hardened compose override (cap_drop ALL, read-only rootfs,
  HSTS, request timeouts, cert state on EFS, cloudflared parked behind an
  unused profile) with `MEMEX_ASSUME_PUBLIC=1` and finishes with an auth
  smoke test. Battle-tested as a downstream deployment first. Default
  stays `cloudflare` — zero behavior change for existing installs.
- **`memex init --postgres`** writes a postgres config (URL from
  `MEMEX_POSTGRES_URL` at serve time) and heals a stale pglite config;
  the container entrypoint picks the backend from the env. Closes the
  fresh-volume trap where the brain silently ran on the local pglite
  database while RDS sat empty because the env URL is only consulted
  when the config already says postgres.
- `eu.amazon.nova-2-lite-v1:0` joins the `bedrock_model_id` allowlist —
  the EU cross-region Nova 2 Lite profile for EU data-residency deploys.

### Fixed
- **Fresh `terraform apply` no longer fails on the SG description.** The
  EC2 API rejects non-ASCII `GroupDescription`; the em-dash in the
  security-group description broke every from-scratch apply (long-lived
  deployments created before the string never noticed).
- **A version-less cloudflared tunnel secret no longer bricks bootstrap.**
  `fetch-secrets.sh` fetched the token unguarded; terraform creates that
  secret with no version, and the resulting throw aborted the whole
  bootstrap under `set -e` before compose up. Now guarded like the other
  secrets — empty `cloudflared.env` plus a WARN.
- **`think` retries a round-1 synthesis whose output fails to parse** —
  one budget-gated retry instead of discarding the whole gather+prompt
  spend as "no synthesis".
- **Caddy bootstrap no longer mangles the compose override comment.** The
  escaped backticks in the `compose.caddy.yml` heredoc parsed as a stray
  command substitution (shellcheck SC1073); the block also gains proper
  quoting and an array-based `COMPOSE_FILES`, so the shellcheck CI job is
  green again.
- **Deployment docs match runtime behavior**: the container has no
  `memex` alias (the index example goes through `bun run src/cli.ts`,
  one file per call, with `embed --dry-run` for backlog checks); the
  6-hour cycle maintains the existing corpus and does not ingest new
  files; `bootstrap.sh` documents cloud-init's once-per-instance
  semantics and the SSM re-run path; prerequisites carry the
  non-Cloudflare-ingress auth warning.

## [1.107.2] — 2026-08-03

### Fixed
- **Timestamp-tied orderings are deterministic.** PGLite's NOW() has
  millisecond resolution, so back-to-back writes routinely share a
  timestamp and every `ORDER BY captured_at DESC` without a secondary key
  fell back to heap order — the root cause behind three long-standing
  flaky tests (friction recent-order, links-extraction watermark,
  eval-replay listing) and a fourth same-class failure the fix hunt
  surfaced. All seven such queries (friction recent + listing,
  friction-propose examples ×2, eval-replay listing, eval-export ×2) now
  carry an insertion-order tiebreak (`id DESC`; `COLLATE "C"` for TEXT
  ids, matching the keyword-arm convention), and the watermark test
  separates its timestamps explicitly instead of racing the clock.

## [1.107.1] — 2026-08-03

### Changed
- **The research skill is `perplexity-research` again.** Renamed from
  `web-research` (operator call: keep the Perplexity name); the skill drives
  Perplexity — the agent's Perplexity tooling or API, any web-search tool as
  a fallback — with brain context, and every cross-reference in the pack
  follows the rename.

## [1.107.0] — 2026-08-02

### Added
- **The brain ships a full 53-skill agent skillpack.** `deploy/skills/` now
  carries a complete pack of agent-facing skills — the operating doctrine
  for any MCP client working with this brain: core ops (`brain-ops`,
  `query`, `capture`, `ingest`, `maintain`), enrichment
  (`enrich`, `article-enrichment`, `concept-synthesis`, `book-mirror`),
  daily practice (`briefing`, `daily-task-manager`, `daily-task-prep`,
  `reports`), research (`web-research`, `academic-verify`,
  `data-research`, `citation-fixer`), taxonomy (`brain-taxonomist`,
  `repo-architecture`, `eiirp`, `frontmatter-guard`, `schema-author`,
  `schema-unify`), lifecycle (`skillify`, `skill-creator`,
  `skill-optimizer`, `skillpack-check`, `skillpack-harvest`, `testing`,
  `smoke-test`, `advisor`, `brain-upgrade`) and more — plus a shared rules
  layer (`_AGENT_README`, `_brain-filing-rules`, `_output-rules`,
  `_friction-protocol`) and 12 cross-cutting `conventions/` docs
  (brain-first lookup, search modes, model routing, scheduled work,
  calibration, …). Every skill speaks memex's own surface: MCP tool names,
  `memex` CLI commands, Bedrock model tiers, durable jobs, DB-canonical
  pages.
- **`list_skills`/`get_skill` understand the directory pack layout.**
  Skills live as `<slug>/SKILL.md` (flat `<slug>.md` still works);
  underscore-prefixed shared docs and `conventions/<name>` are excluded
  from the enumeration but fetchable by slug via `get_skill`. The
  container serves the pack from a read-only compose mount
  (`MEMEX_SKILLS_DIR=/skills`), and `memex skillpack` bundles the full
  directory tree with a per-file sha256 manifest.

## [1.106.0] — 2026-08-02

### Added
- **Per-client slug-prefix write fence is now enforced.** The
  `oauth_clients.bound_slug_prefixes` column (schema since migration 046)
  gains its enforcement: a bound client's write/admin ops are confined to
  slugs under its prefixes, and write tools that name no slug at all are
  refused for bound clients outright (deny-by-default, so a future write
  tool can never bypass the fence by omission). Register with
  `memex auth register-client <name> --bound-slug-prefixes inbox,notes`.
- **Non-Latin slugs.** An all-Cyrillic (or CJK) title now produces a real
  slug instead of collapsing onto the shared `unknown` target that could
  never resolve. The slug grammar accepts lowercase/caseless letters of any
  script (ASCII slugs are a strict subset — nothing existing changes), and
  `slugifyTarget` keeps its historical ASCII fold for mixed-script names so
  stored slugs stay stable; only inputs that previously produced `unknown`
  gain the Unicode fallback.
- **`memex jobs prune --dry-run`** previews what a prune would delete. The
  flag was previously swallowed by the CLI parser while the prune deleted
  for real.
- **Doctor: duplicate-pages probe.** Warn-only check for live pages sharing
  (source_id, content_hash) under different slugs — the silent-duplicate
  class the migration-099 path remap had to work around.
- **Relative date filters in search.** `since`/`until` accept `7d`/`2w`/
  `1m`/`1y`, a plain-date `until` now means end-of-day, and garbage values
  fail loud instead of silently dropping the bound.
- **Opt-in timeline anchor phase** (`MEMEX_TIMELINE_ANCHOR=1`, default
  OFF): every firmly-dated page with no timeline events gets exactly one
  deterministic anchor event at its content date — the trajectory event arm
  is no longer blind to dated pages the LLM extractor skipped.
- **Chat-history importer** (`bun scripts/import-chat-history.ts <in.json>
  <outdir> [--dry-run]`): converts exported conversation JSON into
  `type: conversation` pages the conversation parser already understands.
  LLM-free, DB-free; ingest the output with `memex index`.
- **Admin: rescope a client in place.** `POST /admin/api/rescope-client` +
  `memex auth rescope-client <id> --source SRC [--federated-read a,b]`
  change an existing client's write source and read set without
  revoke + re-register (which rotated the secret).
- **Conversation parser reads block-format transcripts** — a
  `- **Name** (Mon 11:18)` header with indented body lines now parses
  instead of yielding zero messages.

### Fixed
- **The ANN arm no longer silently truncates its candidate pool.** The HNSW
  scan returns at most `hnsw.ef_search` rows (default 40) before the LIMIT,
  while the vector arm requests `max(20, k*3)` candidates — 60 at the
  default k=20, so every default-k query was degraded. The GUC is now
  raised transaction-locally to match the request (clamped to pgvector's
  1000 cap) whenever the fanout exceeds the default.
- **The compiled-truth ×2 boost no longer reorders results across pages at
  the default detail.** RRF-fused scores sit in a narrow band, so the
  multiplier let a weakly-matching page's truth mirror displace a
  strongly-matching page's best chunk on every default query. The boost now
  applies only at `detail: low` — the one-chunk-per-document view where the
  distilled truth is exactly what the collapse should keep. Ranking
  signature bumped (v7) so pre-fix cached orderings invalidate.
- **"what do I know about X" is classified as an entity query.** The intent
  pattern matched only second/third person (`you|we`) — the operator's own
  canonical phrasing fell through to the generic path.
- **Re-embedding preserves contextual prefixes.** Every `memex embed`
  re-embed path (gap-fill, `--stale`, forced) embedded the raw chunk text,
  silently stripping the contextual-retrieval prefix the chunk was marked
  as carrying — and the marker then lied about the vectors in the DB. All
  paths now rebuild the same deterministic prefix the index path uses.
- **The embed-coverage metric can reach 100%.** The denominators counted
  `embed_skip` pages that the embed paths deliberately never touch, so
  doctor warned (<95%) forever on a source with skip-marked pages.
- **A partially malformed facts fence no longer deletes the skipped rows'
  projections.** The parser reports per-row warnings and reconciliation
  refuses (preserving the existing index) instead of wiping rows it could
  not re-insert.
- **A path-shaped entity in fact extraction keeps its `/`.** The fallback
  slugifier flattened `people/bob` into the phantom `people-bob`, keying
  facts under a slug no page can have.
- **A file containing NUL bytes indexes instead of aborting.** Postgres
  rejects U+0000 in TEXT; the document transaction died and the file never
  indexed. Chunk content, titles, and doc comments are now sanitized at the
  indexer choke point.
- **An explicitly configured budget of 0 spends nothing.** The paid
  synthesis phases (auto-think, drift, patterns, reflections, thin-enrich)
  coerced a configured 0 to their paid default; patterns/reflections also
  gained the missing pre-flight so the cap is checked before the model call.
- **Cycle lock-release failures are logged** instead of silently swallowed
  (a stranded `cycle_locks` row blocked ticks until TTL with zero
  diagnostic).

## [1.105.0] — 2026-07-27

### Fixed
- **The zero-yield cycle phases stopped re-paying for the same pages.**
  `extract_atoms` and `propose_takes` keyed idempotency on a result row
  existing, so a document that cleanly extracted NOTHING wrote no row and was
  rediscovered — and billed — on every run. Since discovery orders by recency
  and slices to a per-run cap, a stable set of such documents could hold the
  run's slots indefinitely and starve everything behind them. Both phases now
  memoize a clean empty extraction: atoms stamp `atoms_scan_hash` into the
  document's frontmatter (self-invalidating when the content changes), takes
  persist a sentinel row on the same idempotency tuple. A malformed or
  truncated model response is NOT memoized — it stays retryable — and for
  takes the memo and the retirement of the claims the document no longer
  supports land in one transaction, so a failure between them cannot leave a
  document permanently memoized with stale takes still active.
- **A truncated fact extraction no longer passes as complete, and its retry
  cannot outspend the budget.** The extractor capped output tokens without
  checking whether the model stopped because it hit that cap. It now surfaces
  the stop reason; the retry it triggers is checked against the same budget the
  first call was pre-flighted against, so a truncated page cannot bill past the
  operator's cap.
- **An operator job retry restores a real budget.** `retry` re-queued a
  terminal job without resetting `retry_count`/`stall_count`, so the first
  ordinary failure — or the next stall sweep — terminal-failed it again
  immediately. Both counters and the stale error now reset.
- **`putPage` resurrects a soft-deleted page instead of colliding with it**,
  and refuses to resurrect (or create) a slug that now holds a redirect, which
  would otherwise shadow the canonical page a merge or rename produced.
- **`get_last_seen` no longer reports a future-dated event as "seen today"** —
  the query is bounded by `asof`, defaulting to today.
- **Facts extracted from a conversation carry the time the conversation
  happened**, not the time of extraction, and a turn whose speaker is an
  anonymous placeholder no longer becomes an entity.
- **`think` selects page excerpts around the query** instead of always taking
  the leading characters, and renders its Gaps section once rather than twice.
- **`doctor` stops reporting a healthy brain when checks failed** but produced
  no auto-remediation, names the failing checks, and its pending-migrations
  hint points at a command that exists.
- **The generated admin bootstrap token is no longer printed to a non-TTY
  stderr**, where it would persist in container or systemd logs. A headless
  install supplies `MEMEX_ADMIN_BOOTSTRAP` itself.
- **The opt-in LLM arm of `relational_recall` settles its real cost** against
  the client budget rather than releasing the hold as zero.

## [1.104.0] — 2026-07-27

### Changed
- **The vault source id is now `memory`, renamed from `obsidian-vault`**
  (migration 099). The old id came from the path→source mapping this project
  has shipped since migration 071, which routed both `/vault/…` and `/memory/…`
  to `obsidian-vault` — a name that described the editor the files happened to
  sit in rather than what the source holds. The migration also rewrites stored
  `/vault/…` document paths to `/memory/…`, matching `MEMEX_VAULT_PATHS`: with
  the id renamed but the paths left alone, the next index pass would insert a
  duplicate document for every file instead of updating the existing row.

  **If your install carries an `obsidian-vault` source, it is renamed on
  upgrade** and any grant naming it is rewritten with it. Update scripts,
  recipes, or client token requests that reference the old id. Installs without
  that source are unaffected — the migration is a guarded no-op.

## [1.103.0] — 2026-07-27

### Fixed
- **A token client is no longer advertised tools it cannot call.** `tools/list`
  filters the internal-only set on `isPublic`, but an OAuth/PAT request resolves
  to `isPublic: false`, so remote clients (mobile app, web connector, PAT) were
  offered every tool in `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` and then refused at
  call time with `-32001 requires the internal token`. Reported from the mobile
  client as `resolve_slugs` and `log_friction` "failing on every call"; the
  handlers were never reached. The internal-token wall now covers only the
  caller it was built for — an anonymous peer on the docker bridge
  (`authInfo === undefined`). An authenticated principal is gated by the per-op
  scope, `OPERATOR_ONLY_TOOLS`, its source grant, and the redaction bit, which
  is the intended posture. The static public bearer and the bare bridge path
  are unchanged.
- **`volunteer_context` ignored the caller's read grant.** It resolved pointers
  across the whole brain and returned slugs, titles, and synopses — diary pages
  included — to any scoped caller. `sourceIds` is now threaded through the
  pointer resolver (alias index and both page lookups), and a remote caller is
  never volunteered a `life/diary/*` page.
- **`log_friction` was reachable at `read` scope.** It appends a
  `friction_events` row and carries no source axis, so it is now `scope: "write"`
  and part of the derived `WRITE_SCOPED_TOOLS` set.
- **`relational_recall` resolved its query seeds against the whole brain.** The
  fanout honoured the caller's grant but the seed-resolution stage did not, so a
  scoped caller could confirm that another source's page exists even though the
  traversal returned nothing. The read scope now reaches the seed resolver, and
  the tool applies the same diary fence as `resolve_slugs`.
- **The opt-in LLM arm of `relational_recall` spent Bedrock unmetered.** Only
  that arm is wrapped in the client-budget hold; the deterministic arm stays free
  and unmetered. The arm's real cost is echoed back as `spentUsd` so the
  reservation settles against it — otherwise the hold released as zero-cost and
  the daily cap never accumulated.

## [1.102.0] — 2026-07-20

### Changed
- **Reversible destructive page/graph/fact tools are now reachable by a
  `write`-scoped token, not only the internal token.** `page_delete`,
  `page_restore`, `page_revert`, `unlink`, `remove_tag`, and `forget_fact`
  were callable over HTTP only with the shared internal token; an
  authenticated OAuth/PAT caller may now invoke them when its grant covers the
  op (`write` scope), and every mutation is scoped to the token's own source.
  This keeps the scope model consistent (delete/restore = `write`) and lets a
  remote client manage its own pages. `purge_deleted_pages` (the hard-delete
  reaper) is likewise reachable now at the `admin` scope (delete = `write`,
  purge = `admin`) and is source-scoped to the
  caller. The static public bearer stays forbidden from all of them, and the
  bare docker-bridge path still requires the internal token. `page_delete`
  remains a soft-delete with the 72h recovery window before purge reaps it.

## [1.101.0] — 2026-07-13

### Removed
- **Single-person brain: the multi-person tenant provisioning surface is
  gone.** One brain serves one person; per-credential source scoping stays.
  Removed the `tenant` CLI (`add`/`grant`/`list`/`revoke`), the
  `source_grants` table (migration 098 drops it — it was the entitlement
  floor for an external-IdP JWT path that was never wired into ingress),
  `core/tenant-grants.ts`, the admin provisioning endpoints
  (`GET|POST /admin/api/grants`, `POST /admin/api/sources`,
  `POST /admin/api/revoke-grant`, `GET /admin/api/agent-config`) and the
  grants UI on the admin Agents page (the credentials view remains), plus
  `docs/tenancy.md`. What STAYS is the security layer that also protects a
  single person's own remote clients: `oauth_clients.source_id` /
  `federated_read` scoping, PAT `permissions.source_id`, the per-op scope
  gate, fail-closed tenancy mode, operator-only tools, and the diary/takes
  fences.

### Fixed
- `full-stats` no longer counts `source_grants`; the admin dashboard drops
  the tenant-grants metric.

## [1.100.0] — 2026-07-12

### Added
- **Life Chronicle: a temporal spine for the brain.** Meetings and transcripts
  project into a queryable timeline, entities gain a per-entity dimensional
  ontology (sourced, confidence-weighted values that supersede over time), and
  a diary page type captures private interiority — so an agent can answer
  "what happened the week of X", "when did I last interact with Y", and "how
  did this entity's role change" without re-deriving chronology every session.
  Built entirely on existing primitives (pages, `entity_facts`,
  `timeline_events`) — no new datastore.
  - **Timeline events + reads.** Eligible conversation-shape pages emit
    `type: event` atoms (when·where·who·what) under `life/events/`, projected
    into a date index that backlinks to the depth page. New MCP reads:
    `chronicle_day` (day or ISO-week window, optional narrative prose),
    `chronicle_since`, `chronicle_on_this_day`, `chronicle_last_seen`
    (with `days_ago` at UTC midnight). Deleted event pages hide their
    projections at read time; every read is source-scoped.
  - **Per-entity dimensional ontology riding `entity_facts`** (migration 097:
    `dimension`/`value`/`value_hash`/`dim_status`). A new value supersedes the
    prior across a validity window (`valid_from`/`valid_until`), same-value
    corroboration from a second source bumps confidence, backdated
    observations are recorded without rewriting the present, and novel
    LLM-proposed dimensions quarantine until confirmed. New MCP ops:
    `ontology_get` (with `asof` time travel), `ontology_propose` (write),
    `ontology_dimensions`, `ontology_conflicts` (two-source disagreement).
    Merges take a per-`(source, entity, dimension)` advisory lock, so
    concurrent writers cannot double-open a value.
  - **Diary capture + agent orientation.** `memex capture --type diary`
    (routes to `life/diary/`) and `--type event` with `--who/--what/--where/
    --kind`; `volunteer_chronicle` hands an agent the recent timeline plus
    resolved-entity ontology in one zero-LLM payload.
  - **Auto-extraction, default-OFF.** `MEMEX_AUTO_CHRONICLE=1` enables a
    fire-and-forget `chronicle_extract` job (durable queue, 10-min budget) on
    eligible trusted writes; `chronicle_backfill` (operator-only) sweeps
    existing meetings. The LLM judge's proposals pass an all-or-nothing parse
    barrier — one malformed event rejects the whole batch with zero writes.
    Event pages are content-addressed (`life/events/<day>-<hash8>`), so
    re-extraction updates instead of duplicating. `MEMEX_CHRONICLE_TZ` pins
    the calendar timezone (default UTC).
  - **Ambient surfaces.** Temporal-mode searches lift `life/events/` and
    `life/diary/` hits (bounded ×1.15–1.25, non-temporal rankings bit-for-bit
    unchanged, attribution in `--explain`); the advisor flags unresolved
    ontology conflicts and recent meetings missing from the timeline; doctor
    gains `chronicle-projection-health`; a deterministic `memex eval
    chronicle` (6 tasks incl. source isolation) gates the feature in CI.

### Security
- **Diary content stays private.** Diary pages are excluded from fact
  extraction (the `journal` type joins the same never-mined invariant), all
  chronicle/ontology tools are unreachable from the public bearer, and
  non-operator callers get diary-sourced ontology values stripped — including
  conflicts that would degenerate to a single value after stripping (a
  surviving one-value "conflict" would leak that a diary value exists).
- **Self-registered OAuth clients now default to the consent-bearing
  `authorization_code` grant.** With Dynamic Client Registration enabled, a
  DCR client that asks for `client_credentials` — the grant that skips the
  `/authorize` approval screen — is refused (`invalid_client_metadata`)
  unless the operator opts in with `MEMEX_ENABLE_DCR_INSECURE=1` (implies
  `MEMEX_ENABLE_DCR`). Startup now prints a loud warning whenever DCR is
  open, and a second one in insecure mode. Clients registered via
  `memex auth register-client` or the admin API are unaffected.
- **Trigger functions pin their schema search path.** Migration 095 sets
  `search_path = pg_catalog, public` on memex-owned trigger/event-trigger
  functions (`chunks_update_search_vector`, `auto_enable_rls`), and a new CI
  guard (`scripts/check-search-path.sh`) fails any future trigger function
  that ships without a pinned search path. The same migration re-runs the
  RLS backfill with a privilege probe that recognizes superuser and
  inherited-role privileges, not just the role's own flag.

### Fixed
- **Empty environment values no longer clobber working defaults.** An empty
  `AWS_REGION` (as some hosts inject into subprocesses) used to reach the
  SDK as region `""`, and `MEMEX_LLM_TIMEOUT_MS=""` parsed to `0`, silently
  disabling the LLM request timeout. Trimmed-empty now means unset across
  the region/timeout reads (one shared helper).
- **An unsupported `MEMEX_EMBED_DIM` fails at startup, not mid-index.** The
  default Titan v2 embedder supports {256, 512, 1024}; other values used to
  boot fine and fail at the first embed call. The resolver now rejects them
  with a message naming the supported set.
- **Dimensional ontology rows are fenced out of the free-text fact
  pipelines.** Embedding backlog, consolidation, recall/list, supersession
  listing, pending counts, and contradiction mining all exclude
  `dimension IS NOT NULL` rows — ontology has its own read paths.

## [1.99.1] — 2026-07-10

### Fixed
- **Compiled-truth mirrors now re-chunk on a chunker-version bump.** The
  mirror reconcile's truth pass compared only content hash + tenant, so a
  `MARKDOWN_CHUNKER_VERSION` bump drained `page://` body mirrors but left
  `page-truth://` mirrors stamped at the old version forever (12 such v1
  mirrors found by a whole-DB audit). Freshness now also requires the
  mirror's `chunker_version` to be current, matching the body-mirror pass.

## [1.99.0] — 2026-07-10

### Fixed
- **Symbol-less code files no longer produce zero-chunk (unretrievable)
  documents.** A file whose symbol extraction yields nothing — a re-export
  barrel `index.ts`, a DML-only migration SQL — used to write a `documents` row
  with no chunks: dead to search and flagged as corrupt by `orphans-purge` on
  every cycle tick. The code indexer now falls back to plain text-window chunks.
  The windows are cut by a raw splitter, NOT the markdown chunker — a markdown
  parse would eat a leading `--- … ---` block as YAML frontmatter, silently
  dropping content from SQL files that use `---` comment separators.
  `CODE_CHUNKER_VERSION` bumped 1→2; existing zero-chunk docs drain via
  `reindex --source code --all` (the mtime-skipping code sweep does not force
  on a version bump — recorded as a follow-up).
- **`orphans-purge` no longer flags virtual or remote-namespace documents as
  missing on disk.** The cycle phase disk-probed every `documents.source_path`:
  DB-only rows (`page://` and `page-truth://` mirrors, `gmail:`/`gcal:` channel
  items) and remote-ingested docs whose path namespace (e.g. `/vault/…` from
  the operator's laptop) does not exist on the host were all permanently
  flagged — hundreds of unactionable report entries per tick. Now only
  absolute paths whose top-level root exists on this host are probed; a
  missing file under a present root is still flagged (the real signal). Same
  latent class as the v1.83.0 rechunk-sweep `page://` fix.

## [1.98.0] — 2026-07-09

### Added
- **Migration runner retries a transient statement_timeout / connection reset.**
  A migration whose SQL trips a `statement_timeout` (57014) or a connection
  reset is now retried up to 3 times (5s/15s backoff) instead of aborting the
  whole deploy on the first blip; the SQL and its bookkeeping `INSERT` share one
  transaction, so a rolled-back attempt records nothing and the retry re-runs
  atomically. A `lock_timeout` (55P03) stays fail-fast. On exhaustion the runner
  throws `MigrationRetryExhausted`, naming the idle-in-transaction PID most
  likely holding the lock with a paste-ready `pg_terminate_backend(<pid>)`.
  Backoff is collapsible via `MEMEX_MIGRATE_BACKOFF_MS` for tests. The retry
  logic is built into memex's file-based migration runner.

## [1.97.0] — 2026-07-09

### Security
- **`extract_facts` is now `scope:"write"`.** The op declared no scope, so the
  per-op scope gate defaulted it to `read`, letting a read-scoped OAuth tenant
  reach the paid Bedrock extractor in preview mode (the persist path was already
  write-gated, the preview was not). It now folds into the derived
  `WRITE_SCOPED_TOOLS` and the per-op gate, so a read token is rejected before
  the paid call — the op is now write-scoped end to end. The
  operator path and the public bearer (already forbidden from `extract_facts`)
  are unaffected; the op stays default-OFF (`MEMEX_FACTS_EXTRACTION`).

### Fixed
- **MCP `notifications/initialized` is acknowledged with an empty HTTP 204.**
  The standard post-`initialize` notification previously fell through to a
  JSON-RPC `-32601` method-not-found (wrapped at HTTP 200); it now returns a
  bodiless 204, matching the MCP handshake contract. Tolerated
  by existing clients, but now spec-conformant.

## [1.96.0] — 2026-07-08

### Security
- **`stats` + `jobs_list`/`jobs_get`/`jobs_logs` forbidden from the public bearer.**
  All four are admin-scoped tools; they previously leaned on
  `OPERATOR_ONLY_TOOLS` (which only gates OAuth-tenant callers), leaving them
  reachable by the static public bearer — whole-brain counts (`stats`, unredacted)
  and the job queue (redacted to metadata). Added to
  `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`. The public read surface
  no longer exposes operational state.

### Added
- **Notability write policy (`notabilityFilter`) on `writeExtractedFacts`.** Adds
  a facts-backstop knob (`'all'` | `'high-only'`). memex defaults to `'all'`
  (keep every extracted fact) — the safe default, since memex is DB-canonical
  and has no file-vault sync path to filter for. Behavior-neutral; adds the
  filter for a future bulk surface.

## [1.95.0] — 2026-07-07

### Added
- **HNSW index lifecycle manager (`core/vector-index.ts`) + `memex hnsw`.** A full
  pgvector index lifecycle surface built on memex's Engine + its
  `embeddings_vector_idx` (mig 001): `checkActiveBuild`
  (pg_stat_activity probe), `dropZombieIndexes` (sweep of `indisvalid=false`
  indexes, guarded against an active build), `dropAndRebuild` (build a temp index
  `CONCURRENTLY` then DROP+RENAME atomically — the old index stays intact and
  search keeps serving if the build fails), and `monitorBuild`. Exposed as
  `memex hnsw <status|sweep|rebuild>`. Recovers an HNSW index left invalid by an
  aborted `CREATE INDEX CONCURRENTLY` or an OOM mid-build. An opt-in startup sweep
  (`MEMEX_HNSW_ZOMBIE_SWEEP=1`, default-OFF) auto-drops invalid indexes at boot.

### Fixed
- **`tool_defs` contract test (pre-existing CI red).** The frozen
  `tool_defs.snapshot.json` had drifted from the live `TOOL_DEFS` — two MCP tools
  (`log_ingest`, `get_ingest_log`) plus five param-schema updates (search,
  page_list, entity_facts, takes_scorecard, takes_calibration) shipped after the
  snapshot was frozen but the fixture was never regenerated, so the contract test
  failed on deployed-and-working code. Re-baselined the snapshot to the current
  81-tool surface; the test now guards future accidental drift again.

## [1.94.0] — 2026-07-07

### Added
- **`invalid-indexes` doctor check.** A failed or interrupted index build (a
  killed `CREATE INDEX CONCURRENTLY`, or an OOM mid-build) leaves the index
  `indisvalid=false`: Postgres keeps it but never uses it, so the HNSW vector arm
  (or any indexed lookup) silently falls back to a sequential scan with no error —
  a quiet retrieval-quality regression. `memex doctor` now flips ok:false and names
  the index; recover with `REINDEX INDEX CONCURRENTLY <name>` (online, no write
  lock). Read-only; wired into both the MCP and CLI doctor surfaces.

## [1.93.0] — 2026-07-07

### Added
- **`related_to` typed-link inference from `related`/`see_also` frontmatter.** The
  typed-link schema-pack now derives a `related_to` edge from a `related:` or
  `see_also:` frontmatter list on ANY page type (an ANY-type bucket merged under
  the per-type rules). Symmetric-safe — a reciprocal edge is a distinct row, so it
  does not breach the single-origin invariant that keeps `investors`/`key_people`
  out. Default-OFF (`MEMEX_TYPED_LINKS`), so no behavior change until enabled.

## [1.92.0] — 2026-07-07

### Added
- **Typed-claim fields on the LLM turn-extractor.** The conversation fact
  extractor now emits + parses `metric`/`value`/`unit`/`period` and threads them
  through `writeExtractedFacts`→`addFact` into the `claim_*` columns (mig 070)
  that the fence and trajectory/drift analysis already consume. Previously
  conversation-extracted facts always landed with NULL `claim_*` — the
  quantitative-fact pipeline was starved on the automated path. Additive:
  non-quantitative facts pass all-null and are unchanged.

### Security
- **eval-capture PII scrubber now masks JWT + Bearer tokens.** The scrubber
  masked email/IBAN/card/phone/IP but not auth tokens; on a bearer/JWT-authed
  system a token pasted into a query could land unmasked in the persisted
  `eval_candidates` table. Added the two token patterns (`[token]` placeholder,
  Bearer matched before JWT so `Bearer <jwt>` masks whole).

### Fixed
- **`facts_decay` public-bearer test.** The "forces decay OFF on the public
  bearer path" case seeded facts at the column default `visibility='private'`
  then expected them visible on the public path; the mig-085 world-visibility
  floor (a deliberate deviation) correctly hid them, so the test failed on clean
  main. It now seeds `visibility='world'` to match its real intent (decay OFF on
  the public path, ON internally). No production behavior change.

### Removed
- **Dead `output/transcript.ts` stub.** A 30-line empty-interface placeholder
  ("friction adds real persistence") with zero importers in `src/` or tests,
  long superseded by `transcripts-read.ts` / `subagent_ledger.ts` /
  `eval-capture.ts`. Deleted.

### Changed
- **`concurrency.ts` doc comment corrected.** Its header claimed the `Semaphore`
  was "used by the file sweep"; no sweep/indexer path imports it (the v1.90 LLM
  gateway inflight cap covers today's concurrency ceiling). The comment now
  states it is an unwired generic primitive kept for future embed-batch gating.

## [1.91.0] — 2026-07-07

### Added
- **`contradiction-trend` doctor check.** The suspected-contradictions probe
  already writes per-run Wilson-CI rows to `synth_contradiction_runs`, but they
  were written and never read back. `memex doctor` now surfaces the last run's
  detection rate + 95% CI + cost so an operator sees quality drift without
  re-running the paid probe (informational, never fails the report).

## [1.90.0] — 2026-07-07

### Added
- **Unified model-tier resolver + opt-in deep tier.** `resolveModel(tier)` is now
  the single seam for choosing a Bedrock model by tier (utility/reasoning/deep);
  the two per-helper env lookups delegate to it. The new `deep` tier
  (`MEMEX_DEEP_MODEL`, e.g. Opus) is opt-in and falls back to the reasoning model
  (Sonnet) when unset, so enabling it is a deliberate cost-guarded choice and
  disabling it never regresses. `budget.ts` gains an `opus` pricing row.
- **LLM gateway.** A per-process inflight concurrency cap
  (`MEMEX_LLM_MAX_INFLIGHT`, default 4) stops the parallel synthesis phases from
  stampeding Bedrock; the Bedrock client factories gain SDK-native adaptive
  retry/backoff + a request timeout (`MEMEX_LLM_TIMEOUT_MS`, default 30s), and an
  `isLlmAvailable()` probe. (memex is Bedrock-only, so it carries no
  multi-provider gateway machinery.)

### Fixed
- **Cycle OOM that took the brain down.** The `lint` cycle phase (first in the
  phase list, default-ON, runs every tick) loaded the entire `frontmatter` JSONB
  column for every document into one array. Voicenote/gcal docs carry 18–30 MB
  frontmatter each, so materializing the whole corpus spiked RSS to ~3.4 GB and
  tripped the 3000 MB container cgroup limit → OOM-kill → restart, recurring
  roughly every 40 minutes (the intermittent downtime). `lintCorpus` now
  projects only the four fields it actually reads (`title`/`tags`/`created`/
  `updated`) via `jsonb_build_object`, bounding each row to a few bytes —
  mirroring the identical fix already applied in `extract.ts`.

## [1.89.0] — 2026-07-07

### Added
- **Admin observability endpoints.** `/admin/api/agents/spend` (per-OAuth-client
  committed + pending spend today vs `budget_usd_per_day` — the mig-081 ledger
  finally has a read surface), `/admin/api/stats` (connected agents, active
  tokens/API keys, requests in the last 24h), and `/admin/api/health-indicators`
  (OAuth tokens expiring within 24h, 24h error-rate %). Read-only.
- **Per-token-id rate limiter.** After the per-IP check, an authenticated OAuth
  client is additionally capped by its `clientId`
  (`MEMEX_MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE`, off by default) — so a client
  rotating egress IPs (claude.ai / ChatGPT fleets do) can no longer defeat the
  per-IP bucket. Unauthenticated callers are unaffected.

### Changed
- **`/admin/api/requests` gains `agent` / `operation` / `status` filters and the
  redacted `params` column**, so an operator can isolate and inspect exactly
  what one agent called; `total` honours the same filter.
- Migration 094 adds `oauth_clients.deleted_at` (a soft-delete
  column the admin reads filter on; memex probed for it defensively before).

## [1.88.0] — 2026-07-07

### Added
- **Fenced-code extraction.** A ```lang code fence in a markdown page whose tag
  maps to a supported grammar (typescript/tsx/python/bash/go/sql, plus common
  aliases) is now chunked by the tree-sitter code chunker and stored as a
  searchable `chunk_source='fenced_code'` chunk with its language and symbol —
  so "how do we import from the engine" ranks the actual code example above the
  prose about it. Bounded by `MEMEX_MAX_FENCES_PER_PAGE` (default 100); a parse
  failure on one fence never fails the page. Migration 093 adds
  `chunks.chunk_source`. Existing pages gain fenced chunks on their next edit /
  reindex (no forced corpus re-embed).

## [1.87.0] — 2026-07-06

### Added
- **`memex version` / `--version`** — prints the build stamp (a `git describe`
  baked into the image at build time via `MEMEX_VERSION`, or `dev` locally).
- **`entity_facts` `entity_slug` is now optional** — omit it for a cross-entity
  recall ("what did I learn recently / this session") across all entities. The
  visibility floor and source scoping still gate a scoped reader's entity-less
  scan, so it can never widen exposure.
- **`takes_scorecard` gains `holder` + `since`/`until`; `takes_calibration`
  gains `holder`.** Grading accuracy can now be sliced per belief-holder and per
  time window over MCP. The explicit holder filter ANDs with the token's
  takes-holder allow-list (fail-closed: asking for a holder outside the
  allow-list returns an empty scorecard, never a bypass).

### Changed
- **Migrations run under a generous `statement_timeout`** (default `30min`,
  override `MEMEX_MIGRATION_STATEMENT_TIMEOUT`) applied as a transaction-scoped
  `SET LOCAL`, so a large `ADD COLUMN` backfill or `CREATE INDEX` isn't killed
  at the 30s interactive limit. Interactive queries are unaffected.
- **Bulk DB writes retry transient connection errors.** The indexer transaction
  and the embed-backfill insert now retry a dropped RDS socket / "too many
  clients" blip with decorrelated backoff instead of dropping the batch.
  Statement/lock timeouts are excluded (a retry would just re-wait).
  `MEMEX_BULK_MAX_RETRIES=0` disables retries.

## [1.86.0] — 2026-07-06

### Added
- **Four ops-facing `memex doctor` probes.** `stale-locks` (cycle locks past
  their TTL — an orphaned holder), `queue-health` (job queue depth plus a
  wedged-running-job flag, threshold `MEMEX_DOCTOR_JOB_WEDGE_SEC`, default 1h),
  `schema-version` (highest applied migration vs the highest bundled migration —
  flags unapplied ones), and `embedding-width` (stored `vector(N)` width vs the
  configured `EMBED_DIMENSIONS` — catches a `MEMEX_EMBED_DIM` change that never
  reached the column). Surfaced in both `memex doctor` and the MCP `run_doctor`
  tool. Read-only, no LLM — the substrate (cycle_locks, jobs, migrations,
  embeddings) already existed; only the surfacing was missing.

## [1.85.0] — 2026-07-06

### Added
- **Reranker candidate window (`MEMEX_RERANK_WINDOW`, default 30).** The opt-in
  two-pass reranker now reorders a candidate window WIDER than the return size,
  so a genuinely relevant hit fused below the
  return cutoff can be promoted into the returned set instead of being stuck
  there. The trim to `k` happens after the rerank; the un-reranked tail keeps
  its fused order. The window is part of the query-cache ranking signature.
- **Env-tunable Postgres pool + statement timeout.** `MEMEX_PG_POOL_MAX`
  (default 10) and `MEMEX_PG_STATEMENT_TIMEOUT_MS` (default 30000) so a long
  migration, a whole-corpus re-embed backfill, or a big rechunk transaction
  isn't killed at the short interactive `statement_timeout`. Previously the
  factory hard-coded both even though the engine already accepted overrides.

## [1.84.0] — 2026-07-06

### Changed
- **MCP `search` default `k` 5 → 20.** A client that passes no `k` now gets the
  a wider recall window from hybrid search (the reranker's
  autocut/adaptive-return still trims to the confident cluster when it runs), so
  callers relying on the default no longer silently get a quarter of the results.

## [1.83.0] — 2026-07-06

### Fixed
- **DB-canonical pages now re-chunk on a chunker-version change.** The vault
  rechunk-sweep reads each document off disk, so `page://` mirror docs (which
  have no file) were silently skipped — a change to the markdown chunker never
  reached DB-authored pages. `reconcilePageMirrors` now also re-mirrors a page
  whose search doc is stamped below the current chunker version, draining
  through the existing bounded `mirror-pages` cycle backstop.

### Changed
- **Markdown chunker version → 2.** The indexer strips the `## Takes` fence
  before chunking (v1.82.0); bumping the version re-chunks the existing corpus
  so already-embedded pages purge any fenced-takes content from search. Vault
  docs drain via the rechunk-sweep; DB pages via the page-mirror backstop.

## [1.82.0] — 2026-07-06

### Fixed
- **Operator takes no longer leak into search.** The indexer stripped the
  `## Facts` fence before chunking but not the `## Takes` fence, so
  operator-authored takes — including holder-scoped rows the takes read-path
  caps at `world` — were chunked, embedded, and retrievable by any principal
  with read scope on the source. The indexer and the ambient-context synopsis
  now strip both fences. Existing pages heal on their next re-index (a
  `reindex --force` or edit purges already-embedded fence content eagerly).
- **Untrusted callers can no longer plant gate-owned frontmatter markers.** A
  write-scoped or public-bearer caller could send `quarantine` (hide a page
  from search), `embed_skip` (keep content out of the vector arm), or a
  `content_flag.detail` (inject text into the agent-trusted "this looks odd"
  channel) in a page's frontmatter, and the content-sanity gate — which only
  *adds* markers, never removes caller-supplied ones — let them through. The
  ingest path now carries a trust flag: the remote MCP `index` inline form and
  the remote/public `page_put`/`page_append` search mirror strip those three
  keys before the gate runs, so only the gate and trusted local CLIs own them.
- **`memex merge` is reachable again.** The entity-merge command shipped in the
  v1.81 wave but was never wired into the CLI dispatch, so `memex merge
  <from> <to>` printed `unknown command`. The case is connected; the CLI now
  folds a duplicate/stub page onto its canonical.

## [1.81.0] — 2026-07-06

The overnight gap-closing wave: a 10-subsystem review produced 77 ranked gaps;
the 57 core/useful ones ship here (migrations 073-091). Highlights by area:

### Added
- **Retrieval**: compiled-truth pages mirrored into search with a ×2.0 boost;
  exact slug/title-match, alias-canonical and mattering-salience boosts;
  boost-capable hyperbolic recency (fresh content can now win); full 14-prefix
  source-boost tier map applied inside arm SQL + default hard-excludes;
  reranker scores the full return window with a 5s timeout + failure audit;
  dedup allows 2 chunks/doc with a 0.6 type-diversity cap; zero-LLM regex
  intent classifier (drops a paid Haiku call per search); search mode bundles
  (conservative/balanced/tokenmax); `search --explain` wired end to end.
- **Synthesis**: operator-authored takes model (page-fence canon, resolution
  tuple, active/superseded lifecycle, holder allow-list enforcement at every
  read path); grade evidence via time-bounded hybrid search; wider
  contradiction probe with typed resolution proposals + trend rows; voice gate
  and take-commit bias nudges; `think --save` persists synthesis pages with
  citation rows; atoms are written as searchable pages with provenance.
- **Facts**: lifecycle columns (visibility, superseded_by, consolidated_into,
  context, session), supersession audit surface, confidence decay default-ON
  internally, `extract_facts` opt-in persistence, durable ingest failure log.
- **MCP**: `think` and a `query` op; sources/status/doctor
  operator wraps; jobs retry/progress; raw_data put/get; page_list/page_get
  and insights/takes param coverage; DB-backed spend ledger with per-client
  daily budget enforcement on paid ops.
- **HTTP**: `POST /ingest` webhook capture (write-scope, rate-limited,
  byte-capped, idempotent by content hash); liveness-only `/health`;
  streaming body cap; CORS/OPTIONS on OAuth + MCP routes; RFC 9728
  protected-resource discovery + WWW-Authenticate challenge.
- **CLI**: `config show|get|set`, `capture`, `quarantine`, `search
  stats|tune|diagnose`, `eval compare|run-all`, `embed` targeting
  (slug/--stale/--source), `lint --fix`, jobs prune/delete/submit, `auth test`
  HTTPS-only smoke.
- **Admin**: unified credentials view over OAuth clients + personal tokens
  with usage, api-key mint/list/revoke, client register/revoke, token-TTL
  editor.

### Fixed
- Remediation job handlers are registered at worker startup (doctor
  --remediate jobs no longer dead-letter).
- Query-cache ranking signature covers all ranking knobs; per-call flag flips
  can no longer serve stale cached orderings.
- Remote credentials without a takes-holder allow-list are floored to
  `world`; scoped fact reads are floored to world-visible rows; `/ingest`
  honors the tenant fail-closed policy; spend reservations serialize under a
  per-client lock.

### Security
- page_list clamps at 100 rows (was 1000); rate-limit rejections no longer
  force a DB write per 429; `auth test` refuses to send tokens over plain
  http to non-local hosts.

### Fixed (post-review hardening, same release)
- **The 1.80.1 jsonb double-encode bug class is now closed repo-wide**: 32
  call sites bound `JSON.stringify`'d strings to bare `$N::jsonb` positions
  (including `pages.compiled_truth` — double-encoded on live Postgres since
  the column shipped). All string-param sites now cast `::text::jsonb`;
  migration 092 repairs every already-double-encoded jsonb string scalar in
  the database (information_schema-driven, try-parse guarded, idempotent);
  a new guard test fails the suite if the unsafe pattern ever returns.
- Curation tiers no longer apply twice (arm SQL + post-fusion) — the tier
  factor acts only inside arm SQL.
- `log_ingest` / `get_ingest_log` exposed over MCP (tenant-scoped), and
  `POST /ingest` writes an audit row per accepted event.

## [1.80.1] — 2026-07-05

### Fixed
- **PAT permissions were written double-encoded**: `auth create` and `auth
  permissions` bound `JSON.stringify`'d strings to `$N::jsonb` params, which
  postgres.js stores as a jsonb *string* — so `permissions.source_id` tenant
  scope silently failed to resolve (a well-known jsonb double-encode bug
  class — binding raw objects avoids it).
  Both call sites now bind JS objects, and the tests assert
  `jsonb_typeof(permissions) = 'object'` so a regression cannot hide behind
  a lenient string-parse.

## [1.80.0] — 2026-07-05

### Added
- **Personal access tokens — `auth create` / `auth list` / `auth revoke` /
  `auth permissions`**. `auth create <name>
  [--takes-holders a,b]` mints a long-lived bearer (`memex_…`, printed once,
  only the SHA-256 hash persists) into `access_tokens`; `list` shows tokens
  without hashes; `revoke <name>` soft-revokes; `permissions <name>
  set-takes-holders a,b` replaces the takes-visibility allow-list. Tenant
  scope comes from the row's `permissions.source_id` (operator-set): a scalar
  is write + sole read source, an array is a federated read set anchored on
  its first element — resolved by the existing verify fallback.
- **Migration 072**: `access_tokens.permissions JSONB NOT NULL DEFAULT
  '{"takes_holders":["world"]}'` — the column the verify fallback already
  read; without it every PAT fell to the `default` floor.

### Fixed
- **/mcp accepts personal access tokens**: the ingress offered only
  `memex_at_…` bearers to the verifier, so `access_tokens` PATs could never
  authenticate remotely. Every bearer now goes to `verifyAccessToken`
  (`/mcp` sits behind `requireBearerAuth` with no prefix
  filter); a non-token string misses both hash lookups and still 401s.
- **Stale systemd unit tests**: `tests/test_systemd_units.py` predated the
  container-exec unit form and failed on `memex-eval-probe.service` since it
  shipped — `/usr/bin/docker exec …` ExecStart and implicit-root (no `User=`)
  are now accepted.

## [1.79.5] — 2026-07-05

### Reverted
- **`auth rescope-client` (added in 1.79.4) is removed** to keep the `auth`
  command surface minimal — there is no in-place client rescope (only register +
  revoke). Client read/write scope is the `federated_read` field; to change it,
  re-register the client or edit the row.
  No data change — any client already rescoped stays as-is.

## [1.79.3] — 2026-07-04

### Fixed
- **Backfill un-tagged content so it stops being invisible (migration 071).**
  322 documents + 3014 chunks (mostly the Obsidian vault, ingested before source
  tagging existed) carried a NULL `source_id`. A scoped read filters
  `source_id = ANY(...)` and NULL matches nothing, so those notes were invisible
  to every scoped reader. They are now stamped from their ingest path
  (`/vault`,`/memory` → `obsidian-vault`; `/repo-source` → `repo-source-code`;
  else `default`), rejoining the source they belong to. Idempotent.

## [1.79.2] — 2026-07-04

### Fixed
- **`list_concepts` is operator-only.** Its table (`synth_concepts`) has no source
  axis — its narratives are clustered across every tenant's notes — so a tenant
  token could read concepts derived from another tenant's notes. Now gated
  operator-only, closing the last cross-tenant read for a multi-tenant setup.
- **`add_timeline_event` ownership guard corrected against shared pages.** A scoped
  caller may only append a timeline event to a page its own source owns (regression
  test updated to the owned-page model).

## [1.79.1] — 2026-07-04

### Fixed — cross-tenant + public-exposure divergences
An exhaustive function-by-function audit found seven behaviour/default/guard
divergences of the same class as the OAuth default; all are now closed:
- **`takes_search` and `set_take_status` are no longer reachable from the public
  bearer.** The take-search read returned the same private synthesized claims as
  the already-forbidden `list_takes`, and `set_take_status` was a tenancy-unscoped
  write — both are now internal-only.
- **`think` / `auto_think` scope the calibration profile to the tenant.** It was
  fetched whole-brain, so a scoped run could inject another tenant's forecasting
  record into its prompt (and persist it). Now scoped like every other retrieval.
- **`grade_takes` grades each take against its own source's evidence only** — the
  evidence scan was whole-corpus, so a take could be graded against another
  tenant's chunks.
- **`add_timeline_event` verifies page ownership** before writing — a scoped
  caller can only append to a page its own source owns.
- **OAuth tool calls are scope-gated per operation** — a `read`-scoped token can
  no longer invoke a `write` tool.
- **The admin bootstrap token must be 32+ chars** (`[A-Za-z0-9_-]`); the server
  refuses to start on a weak value instead of relying on the login rate limit.
- **Facts-fence forget is keyed by row, not claim text** — forgetting one fence
  row no longer collaterally drops a same-text sibling on another row.

### Changed — OAuth posture hardened
- **Dynamic Client Registration is now OFF by default** (`MEMEX_ENABLE_DCR=1` to
  enable). With it off, `POST /register` returns 404 and the discovery document
  omits `registration_endpoint`, so no one can self-register a client over the
  network — the only way a client exists is an operator creating it via
  `memex auth register-client`. This closes an open self-registration surface.
- **`/authorize` auto-approves by default**, so a standard MCP
  client completes the authorization-code flow unattended. The stricter
  operator-login gate is now opt-in via `MEMEX_OAUTH_REQUIRE_LOGIN=1`.
- **`auth register-client` gains `--redirect-uris`** (CSV). Passing one makes it an
  authorization-code (browser) client and defaults its grants to
  `authorization_code,refresh_token` — so an operator can hand-register a
  confidential client for a hosted MCP connector (e.g. a Claude.ai callback).
- When DCR is enabled, a registration requesting elevated scopes is **clamped** to
  `read`/`write` (not rejected), so a real client that copies the full advertised
  scope list still registers — but never as an elevated client.

## [1.79.0] — 2026-07-04

### Added — wave 3
- **Full OAuth 2.1 for standard MCP clients.** memex now serves the whole
  authorization surface a client like Claude.ai / ChatGPT / Cursor auto-discovers:
  `/authorize` (authorization-code + **PKCE S256**), `/token` (authorization_code
  / refresh_token / client_credentials), `/register` (RFC 7591 Dynamic Client
  Registration), and `/revoke` (RFC 7009 soft-revoke). The discovery document
  now advertises all four so a client configures itself with no manual endpoint
  entry. Codes are single-use, PKCE-verified, `redirect_uri`-allowlisted, and
  scope-bounded; revocation invalidates both access and refresh tokens.
  Authorization requires a logged-in operator (the resource owner) — `/authorize`
  issues no code without an admin session — and Dynamic Client Registration can
  only mint `read`/`write` clients (never `admin`), so the public registration
  path can't self-escalate.
- **Admin: one-click agent onboarding.** The Agents page gains a **Config** drawer
  that emits ready-to-paste MCP client config (Claude Code / Claude Desktop /
  ChatGPT / Cursor / raw JSON) filled with your brain's public URL + the agent's
  scope. The token is always a placeholder — no secret is ever emitted.
- **`rechunk-sweep` cycle phase.** When the markdown chunker version bumps, an
  opt-in (`MEMEX_RECHUNK_SWEEP=1`), count- and budget-capped, resumable phase
  re-chunks + re-embeds stale documents a bounded batch per tick — so a chunker
  change propagates automatically instead of needing a manual full reindex.
- **`memex merge` — merge a duplicate entity.** Re-points a stub page's facts,
  links, timeline, tags, and aliases onto the canonical page, soft-deletes the
  stub, and records a durable redirect (audit-trailed) — tenant-scoped, all in one
  transaction. Fills the gap where `rename` refused when the target already existed.

### Changed
- **Embedding backfill is keyset-paginated + resumable.** The backfill walks
  un-embedded chunks by an `id` cursor in bounded pages instead of a single
  in-memory load, so a very large backfill can't spike memory and resumes from
  where it left off.

## [1.78.0] — 2026-07-04

### Added — wave 2
- **Deeper calibration.** The calibration profile now reports a **Brier score**
  (how well-calibrated your confidence is, not just accuracy), a partial-rate, a
  **per-domain scorecard** (so "geography missed 4 of 6" is visible, not hidden
  in a pooled average), and a grade-completion fraction. Surfaced through
  `get_calibration_profile` / `takes_calibration`. (migration 069)
- **Numeric metric claims + trajectory analysis.** Facts can now carry a typed
  numeric claim (`metric` / `value` / `unit` / `period` / `event_type`), and
  `find_trajectory` gains metric filters, **regression detection** (flags a ≥10%
  drop across a metric's history) and an embedding **drift score**. The plain
  chronological "how did X change" trajectory is unchanged by default. (migration 070)
- **Three new opt-in synthesis phases** (paid, default-OFF, single-model, budget-
  capped, tenant-scoped): **`enrich_thin`** trickle-develops thin/stub pages so the
  brain gets smarter not just bigger; **`auto_think`** runs configured questions on
  a schedule and saves each answer as a draft; **`drift`** flags takes whose
  underlying evidence changed after the take was made. All excluded from paid
  fact backfill (no synthesis-feeds-synthesis loop).
- **Retrieval depth (deterministic, no new LLM cost):** an optional **relational
  4th RRF arm** (fuses edge-derived candidates into a normal `query`,
  `MEMEX_RELATIONAL_ARM=1`); **per-page max-pool** so a page's single strong chunk
  can't be crowded out of the candidate set before ranking (`MEMEX_MAXPOOL=1`);
  and a **`--explain`** search view that stamps which boost fired on each hit.
- **`doctor` remediation.** `memex doctor --remediation-plan` maps ranked health
  issues to fix actions (remediable / human-only / blocked); `--remediate` submits
  the safe, deterministic fixes (re-run a stale phase, re-embed an empty source)
  as jobs on memex's own durable queue — dry-run by default, budget-capped. The
  fast read-only probe stays the default.

## [1.77.0] — 2026-07-04

### Added — wave 1
- **OAuth discovery endpoint.** `GET /.well-known/oauth-authorization-server`
  (RFC 8414, public/no-bearer) lets a standard MCP OAuth client auto-configure
  against your brain — issuer, token endpoint, scopes, and the supported grant
  (today `client_credentials`). The issuer is your declared `MEMEX_PUBLIC_URL`;
  a host-derived fallback is served `no-store` so a shared cache can't be
  poisoned into pointing clients at another host. (Only wired endpoints are
  advertised; the auth-code / DCR / revoke fields return once those routes land.)
- **New MCP read tools:** `takes_scorecard` + `takes_calibration` (hit/miss +
  accuracy/Brier/reliability rollups over your takes), `extract_facts` (run the
  fact extractor on demand without persisting; paid, default-OFF), `list_skills`
  + `get_skill` (browse the brain skillpack), `get_recent_transcripts` (recent
  ingested transcripts as a retrieval surface). All read-scoped, tenant-scoped,
  and internal-only (never exposed to the public bearer path).
- **Code graph now indexes bash, Go, and SQL** (`.sh`/`.bash`/`.go`/`.sql`) in
  addition to TypeScript/Python, so more of your own stack shows up in the code
  call graph. (YAML + HCL/Terraform grammars are pending a wasm rebuild.)
- **Page salience now counts takes.** The salience recompute feeds take density +
  average take weight into the score, so pages you've formed opinions about rank
  higher — link-degree stays the base signal.
- **Admin: per-agent usage.** The Agents page now shows `requests_today`,
  `total_requests`, and `last_used_at` per provisioned subject.

## [1.76.0] — 2026-07-04

### Fixed
- **Take grading fed the judge `[object Object]`.** Both grade paths interpolated
  the `sanitizeForPrompt` result object instead of its `.text`, so the ensemble
  and single-pass judges scored an empty claim + evidence — every verdict was
  garbage. Fixed to `.text`; a regression test now captures the judge prompt and
  asserts it carries the real claim + evidence. (Default-OFF, so no prod impact.)
- **Recency decay now uses the content date, not `updated_at`.** A backfill /
  re-ingest / rechunk bumps `updated_at`, which made stale content score as fresh
  in ranking. The recency multiplier now decays on `effective_date`
  (`COALESCE(effective_date, updated_at)`), so freshness tracks the content, not
  the last write.
- **Superseded facts no longer suppress a legitimate fence re-insert.** The
  insert-time dedup supersede path now stamps `forgotten_cause = 'supersede'`
  (migration 062's discriminator), and fence reconciliation's tombstone skip-set
  honors only genuine forgets (`cause = 'forget'` or legacy `NULL`) — a superseded
  claim the operator still declares in a `## Facts` fence re-enters on re-put.

### Added — brain-only
- **Unchanged-chunk embedding reuse on re-index.** Editing one line of a page no
  longer re-embeds the whole document: a chunk whose raw text is byte-identical to
  the stored version at the same index (under the same embedding model) reuses its
  vector, skipping both Bedrock and the paid contextual-LLM tier for that chunk.
- **Zero-result broadened retry.** When an `exact`-intent search returns nothing
  and the caller permitted expansion, the query re-runs once as `topic` — the only
  lever that can turn an empty set non-empty (synonym expansion). Capped at one
  retry; never fires for filtered, structural, or `noExpansion` (LLM-free) queries.
- **`reflections` cycle phase — reflection writer.** One budget-capped Sonnet pass
  over recent un-reflected transcripts writes `reflections/<topic-slug>` pages
  (cited, `source_id`-pinned), giving the `patterns` phase (v1.75) a source to
  mine. Paid, default-OFF (`MEMEX_REFLECTIONS`). Runs before `patterns` so a fresh
  brain populates then mines in the same tick.
- **`takes_search` MCP tool.** Keyword/trigram search over take claim texts
  (tenant-scoped), so a client can find prior takes by topic instead of listing.
- **`set_take_status` MCP tool.** Flip a take's review status to `accepted` /
  `rejected` (tenant-scoped, enum-validated), closing the take review lifecycle.
- **`memex export`.** Dump every live page to a markdown tree (frontmatter + body,
  slug directory structure), with `--source` tenant scoping — the portability /
  backup / tenant-data-export escape hatch for a DB-only substrate.
- **Link hygiene (deterministic, no LLM).** `[[page#anchor]]` heading anchors are
  stripped before slug resolution; fenced + inline code is masked before link and
  entity extraction (no more phantom edges from code snippets); `[Name](dir/slug.md)`
  markdown links are extracted as edges (resolver-gated); and prose citing a code
  path (`src/foo.ts:42`) links to the indexed code page.
- **Content-sanity operator-literal channel.** `MEMEX_SANITY_LITERALS_FILE` (one
  case-insensitive junk substring per line) now feeds the ingest gate, so
  site-specific boilerplate the built-in patterns miss is quarantined. Fail-open.
- **`doctor` retrieval-quality trend + `eval-probe --max-usd`.** `memex doctor`
  now surfaces the latest nightly `eval-probe` snapshot (informational), and the
  probe takes a per-run USD ceiling that converts to a query cap.

### Changed
- **One-shot `memex cycle` takes the daemon's cycle lock.** A manual `cycle` run
  now shares the periodic loop's `memex-cycle` advisory lock (with a heartbeat),
  so a one-shot and a mid-tick daemon can't overlap and double Bedrock spend; the
  one-shot skips with a message when the daemon holds the lock.
- **Anti-loop guard.** Synthesis-written pages (`reflections/`, `patterns/`) are
  excluded from the paid conversation-facts backfill selector, so synthesis output
  can't feed paid re-extraction of itself.

## [1.75.0] — 2026-07-03

### Added — the last two Tier-2 items (operator-approved)
- **`think` auto-anchor.** When you ask a temporal question ("when did X change,
  is it still…") and don't name an anchor, `think` now derives candidate entities
  from the question text + the retrieved entity-page slugs, resolves them to
  canonical slugs (dropping fallback-slugify guesses), and injects each one's
  `<trajectory>` how-it-changed log. Deterministic, default-ON
  (`MEMEX_THINK_AUTO_ANCHOR`), temporal/knowledge_update intents only, fail-soft.
- **`patterns` cycle phase — cross-session theme miner.** Reads recent reflection
  pages (configurable slug prefix, `MEMEX_PATTERNS_REFLECTION_PREFIX`, default
  `reflections/`), runs one budget-capped Sonnet pass to surface themes recurring
  across ≥`MEMEX_PATTERNS_MIN_EVIDENCE` distinct reflections, and writes one
  `patterns/<topic-slug>` page each (citing its evidence). Paid, default-OFF
  (`MEMEX_PATTERNS`). This is the one synthesis phase that writes real pages;
  reads and writes are pinned to a single `source_id` so one tenant's reflections
  are never mined into another's pattern page.

## [1.74.0] — 2026-07-03

### Fixed
- **Whole-brain `get_chunks` now returns a tenant page's chunks.** A page's
  search mirror is keyed `page://<sourceId>/<slug>`, but the whole-brain / static
  bearer / multi-source read path fell back to the bare `page://<slug>` id and
  found nothing. `getChunksForPage` now resolves the page's real owner from the
  pages store (single-source tenant reads keep the no-query fast path); the
  `source_id` scope filter still gates every read. Fixes the long-standing red
  `tenant_fail_closed` CI test.

### Added — brain-only Tier-2
- **Facts: on-write extraction** (`MEMEX_FACTS_EXTRACTION`, default-OFF) — the
  conversation→facts extractor now runs on page writes via a bounded, best-effort,
  budget-capped queue (page-type eligibility, prompt-sanitized, tenant-scoped,
  never blocks the write). Plus opt-in cycle phases: **`consolidate-facts`**
  (deterministic — clusters facts per entity by embedding cosine and promotes a
  cluster to a take, mig 061) and **`conversation-facts-backfill`** (paid, backfills
  transcripts unattended). Forget now records a **`forgotten_reason`** (mig 062) so
  a dedup *supersede* never suppresses an operator's fence claim.
- **Synthesis: richer `think`** — gathers takes via VECTOR search (mig 063 adds an
  opt-in take embedding) fused with the page/keyword arms, injects a `<trajectory>`
  block for temporal questions, and validates citations against the gathered
  evidence (drops fabricated refs, never fails synthesis). **Take lifecycle**: a
  min-age grading gate (`MEMEX_GRADE_MIN_AGE_DAYS`, default 182d), a real
  `queued→graded` status advance, and the calibration profile is now injected into
  the `think` prompt as an anti-bias block. **Latent-contradiction probe**
  (`MEMEX_PROBE_CONTRADICTIONS`, default-OFF, mig 064) — a paid cycle phase caches
  LLM-suspected fact conflicts that `find_contradictions` now surfaces.
- **Search/embeddings: semantic query-cache** (`MEMEX_QUERY_CACHE_SEMANTIC`,
  default-OFF, mig 065) — a paraphrase hits the cache on query-embedding cosine
  ≥0.92, keeping memex's stronger freshness model. **Embedding provenance
  signature** (mig 066) auto-invalidates embeddings on a model/dim swap.
  **Concurrent embed workers** (`MEMEX_EMBED_CONCURRENCY`, default 8) make a full
  re-embed ~10× faster. Default sentence-aware chunk **overlap** for newly indexed
  pages (existing chunks unchanged until reindexed).
- **Substrate: `slug_aliases` redirect table** (mig 067) — a renamed/merged page
  leaves a durable source-scoped redirect resolved before the fuzzy cascade. A
  **page rename** primitive preserves history within the slug-PK model. Opt-in
  **hot-memory `_meta` injection** (`MEMEX_HOT_MEMORY_META`, default-OFF) surfaces
  decay-weighted top facts on MCP responses. A **nightly eval quality probe**
  (`memex eval-probe` + systemd timer, mig 068 `eval_snapshots`) that doctor can read.

## [1.73.0] — 2026-07-03

### Added — brain-only
- **Content-sanity ingest gate.** memex had the full quarantine/`content_flag`/
  `embed_skip` read+filter substrate but nothing WROTE the markers, so scraper
  junk, oversize, and markup-heavy content entered the vector index unimpeded.
  A new deterministic, LLM-free assessor (`content-sanity.ts`) now gates every
  ingest through `indexDocument`: junk (Cloudflare/CAPTCHA/error-page patterns)
  is hidden by default (quarantine + `embed_skip`), oversize soft-blocks
  (`>500KB`), markup-heavy flags. Kill switch `MEMEX_NO_SANITY=1`; opt-in hard
  reject via `MEMEX_SANITY_DISPOSITION=reject`; thresholds overridable. Runs
  before any Titan spend.
- **Search: filter pushdown + two ranking signals.** `lang`/`since`/`until`/
  `symbol_kind` filters are now folded into the keyword and vector SQL WHERE
  clauses (parameterized, tenant-scoped) so a filtered match ranking below the
  fan-out pool is no longer dropped. New always-on log-scaled backlink-count
  boost (`1 + 0.05·ln(1+in_degree)`, floor-gated; `MEMEX_BACKLINK_BOOST=0` to
  disable) gives hub pages a standing boost. New opt-in cosine re-score blend
  (`0.7·RRF + 0.3·query-chunk cosine`, `MEMEX_COSINE_RESCORE=1`).
- **`find_experts` topic ranking.** Optional `topic` param answers "who in my
  brain knows about X" — person/company pages ranked by topic match (via the
  page→search mirror) × recency decay × salience. Deterministic, no LLM; absent
  `topic` keeps the prior link-degree behavior. Tenant-scoped.
- **Facts: canonicalization, metadata retention, durable forget.** Extracted
  entity names now run the slug-canonicalize cascade before insert (reattach to
  the canonical page on a confident match instead of minting a phantom);
  `kind`/`notability` (mig 037 columns) are now threaded through `addFact` so
  facts decay correctly; a `forget_fact` on a fence-owned fact now survives a
  page re-put (reconcile spares tombstoned claims).
- **Facts: opt-in insert-time dedup/supersede** (`MEMEX_FACTS_DEDUP`, default
  OFF; paid classifier `MEMEX_FACTS_DEDUP_LLM`). Cosine-0.95 fast-path collapses
  duplicates; a budget-capped Haiku classifier resolves duplicate/supersede/
  independent, retiring the superseded fact. Candidate reads are tenant-scoped;
  fact text is prompt-sanitized before the Haiku call.

### Fixed
- **Calibration profiles scoped per source_id** (mig 060). `synth_calibration_
  profile` had no source axis, so the calibration phase blended all tenants into
  one global profile that `get_calibration_profile` then exposed. Profiles are
  now per-source; `getCalibrationProfile` honors the caller's read-source set;
  the single-tenant `default` path is unchanged (additive/idempotent backfill).

## [1.72.0] — 2026-07-03

### Security
- **Closed four latent multi-tenant read-scope holes** (found by an adversarial
  review; all latent because the OAuth/multi-tenant path is dormant today, but they
  must close before a second tenant):
  - **Operator-only tools.** `stats`, `advisor`, and the `jobs_*` queue tools expose
    brain-wide state with no per-source axis (another tenant's job payload/logs,
    whole-brain counts, migrations, internal-auth config). They are now refused for
    any authenticated tenant token (`authInfo` present) — the static daily bearer and
    the trusted-local/internal path (`authInfo === undefined`) keep full access.
    `source_health` stays tenant-scoped and reachable.
  - **Fail-closed floor made reachable.** `MEMEX_TENANT_FAIL_CLOSED` gated its sentinel
    on `auth.isPublic === true`, but every live OAuth caller is `isPublic:false`, so a
    scopeless authenticated principal still fell through to whole-brain read / `'default'`
    write. The floor now triggers for ANY authenticated principal with no grant
    (`auth !== undefined`); the static bearer (`auth === undefined`) is still never scoped.
  - **`resolveRequestedScope` IDOR landmine** (dead code, unwired) keyed "trusted" on
    `isPublic === false`, letting a future handler treat an OAuth tenant as trusted-local
    and hand it any/all sources; an empty grant also passed a requested source verbatim.
    Now keys trust on `auth === undefined` and fails closed on an empty grant.

### Added
- **Bedrock prompt caching for the contextual-LLM tier (~3x cheaper re-embed).**
  The Haiku client already uses the Converse API, so the per-chunk contextual call
  now places a `cachePoint` after the `<document>` block; consecutive chunks of the
  same document reuse the cached doc prefix (they run in one loop, inside the ~5min
  cache TTL). A full 4371-chunk re-embed's dominant doc-input cost drops ~two-thirds
  (cache reads bill ~10x cheaper). Fail-safe: a `ValidationException` on the cached
  attempt retries once uncached, and a sub-minimum prefix is silently uncached — so
  a region/model without caching degrades to the old cost, never an error. Cache
  read/write token usage is folded into the budget so the cap reflects real spend.
- **`scripts/init.sh` defaults to the Max-quality tier.** The installer now prompts
  for a feature tier (Max / Balanced / Free) with per-tier cost notes and writes the
  chosen flags into the generated `.env`; bare Enter = **Max** (the full paid
  experience), or set `MEMEX_INIT_TIER=free|balanced|max` non-interactively.
  The app's runtime code defaults stay OFF — a blind `git clone` never bills; the
  opt-in is the conscious `init.sh` run.

### Fixed
- **contextual-LLM cachePoint split now carries the `\n\n` separator** so the
  cached wire form is byte-identical to the uncached one — backfilled chunks and
  future index-time embeds feed Haiku the same prompt (the re-embed's whole point).
- Corrected the `MEMEX_RERANK` config-reference row: it is the cheap Haiku two-pass
  rerank (~$1–3/mo), not a free retrieval knob — moved to the Haiku section.

### Fixed
- **Green CI: the `jobs.test` quiet-hours case was a wall-clock time-bomb.** It
  enqueued jobs at the real clock but claimed them with a hard-coded `2026-07-01`
  date; once that date passed, `next_attempt_at <= now` excluded every job and the
  test failed (`Expected "L", Received undefined`). Anchor the enqueue `runAt` to a
  fixed past date so the case is time-independent. Production claim logic unchanged.

## [1.71.0] — 2026-07-02

### Added
- **Documented quality/cost tiers + the cheap `MEMEX_RERANK` alternative in the
  compose allowlist.** `docs/CONFIGURATION.md` now opens with a Free / Balanced /
  Max-quality tier table (paid = better quality, the recommended setup once usage
  is known) and `.env.example` mirrors it. The Haiku two-pass rerank
  (`MEMEX_RERANK`, ~$1-3/mo) is now allowlisted as the budget alternative to the
  paid Sonnet `MEMEX_GRAPH_RERANK` (the dominant per-search cost) — near-identical
  ranking quality at a fraction of the price. All runtime defaults stay OFF (a
  clone never surprises you with a bill); a tier is an explicit opt-in.

## [1.70.0] — 2026-07-02

### Added
- **Paid per-chunk contextual-retrieval LLM tier (`MEMEX_CONTEXTUAL_LLM`).** The
  full Anthropic "Contextual Retrieval" technique on top of the free deterministic
  wrapper: each chunk gets a unique Claude Haiku-generated blurb situating it within
  its whole document, prepended before embedding (better recall on ambiguous chunks).
  Opt-in, default-OFF, bounded by `MEMEX_CONTEXTUAL_LLM_BUDGET_USD` (default 5.0) —
  ONE shared budget across a whole `reindex --contextual` run. Fail-open: any budget
  skip / exhaustion / Bedrock error falls back to the deterministic `<context>title +
  synopsis</context>` prefix, so indexing never breaks; the run reports `llmContext`
  vs `deterministicFallback` counts, and a later `--contextual --force` with more
  budget upgrades the fell-back chunks. Document text is a stable leading prompt block
  (Bedrock prompt-caching left as a ~10x cost-saver follow-up). Covers `page://` docs
  (mail/calendar) the same as the deterministic tier.

## [1.69.0] — 2026-07-02

### Added
- **`memex reindex --contextual` — whole-corpus contextual-retrieval re-embed.**
  Turning on `MEMEX_CONTEXTUAL_RETRIEVAL` only wraps *newly indexed* documents, so
  the flag alone left the existing corpus on un-wrapped vectors (a mixed vector
  space). This new command re-embeds every embeddable chunk FROM THE DATABASE with
  the deterministic `<context>title + synopsis</context>` prefix — including
  `page://`-sourced docs (e.g. mail/calendar) that have no file on disk and that
  `reindex --all` (a disk sweep) can never reach. It is idempotent and resumable:
  it writes migration 057's previously-unused `chunks.contextual_embedded` marker,
  skips already-wrapped chunks (unless `--force`), and commits per-document so a
  crash never leaves a document half-wrapped. `--dry-run` sizes the workload,
  `--limit N` caps a batch. Code/`embed_skip` docs stay out of vector search (never
  given an embedding row). The wrapper is free/deterministic — no per-chunk LLM
  call — so a full re-embed costs only Titan embeddings. Run once after enabling
  the flag: `reindex --contextual`.

## [1.68.0] — 2026-07-02

### Added
- **Complete configuration reference (`docs/CONFIGURATION.md`) and a self-host
  deployment guide (`docs/DEPLOYMENT.md`).** The config reference enumerates every
  `MEMEX_*` flag grouped by concern with its default and a free/paid cost tag; the
  deployment guide is a linear zero-to-live how-to (Bedrock model access, terraform,
  secrets, Cloudflare Tunnel, MCP hookup, verify). README/llms.txt corrected: 61 MCP
  tools (was 55/25), Claude Haiku not Nova for utility calls, and the multi-source
  tenant-isolation posture (was mis-stated as "no multi-tenancy / single-user").

### Fixed
- **Paid Sonnet slices no longer silently refuse to spend when `MEMEX_FACTS_MODEL`
  is passed as an empty string.** A `${MEMEX_FACTS_MODEL:-}` docker-compose
  passthrough injects an empty string (not "unset") when the operator hasn't set
  the override. Every paid slice resolved its model with
  `?? process.env["MEMEX_FACTS_MODEL"] ?? DEFAULT_SONNET_MODEL` — and `??` does
  NOT fall through on `""`, so the model id became `""`, which is unpriced, so
  the budget guard refused every call ("budget exhausted before synthesis",
  `$0.0000` spent). Introduce `resolveFactsModel()` (uses `||`, treating an empty
  env value as unset) and route all seven paid-tier call sites (think, deep-synth,
  graph-rerank, relational-llm, take-ensemble, conversation-facts, and the base
  `callSonnet`) through it. Verified live: `memex think` now synthesizes.

## [1.67.0] — 2026-07-02

### Changed
- **Write-time tenant isolation: cross-tenant resolution, edge/tag tamper, and
  write fail-closed (multi-tenant hardening, migration 059).** The remaining
  adversarial-audit write-path holes are closed, all additive/behavior-neutral for
  the single-tenant deploy:
  - **Wikilink/verb/typed-link canonicalization is now source-scoped at write
    time.** `makeSlugResolver` gained an optional `sourceIds`; every DB stage
    (exact-tail, prefix-expansion, trigram, alias, existence) filters by it when
    set, threaded from the write call sites (`syncWikilinksForPage`,
    `syncVerbLinksForPage`, `syncTypedLinksForPage`). Previously a tenant's
    `[[people/alice]]` could resolve to another tenant's page; now it resolves
    within the writer's source. Unset (local/CLI) → whole-brain, unchanged.
  - **`links` and `tags` unique keys now include `source_id`** (migration 059:
    `UNIQUE(source_slug,target_slug,type,source_id)` and `UNIQUE(slug,tag,source_id)`),
    so a second tenant's `link`/`add_tag` for a triple/tag another tenant already
    has creates its OWN row instead of overwriting or no-op'ing the other tenant's.
    Collision-safe on live data — every existing row is `source_id='default'`, so
    the wider key is functionally identical on single-source data. All `ON CONFLICT`
    sites updated to match.
  - **Write-side fail-closed** (`effectiveWriteSourceIdForIngress`, gated on
    `MEMEX_TENANT_FAIL_CLOSED`, default-OFF): a non-local principal with no resolved
    write source is rejected (`permission_denied`) instead of silently defaulting
    to `default`; `appendPage` now requires the target page's `source_id` to match
    the caller's scoped write source and never adopts the found row's source.
  - **Gazetteer auto-link entry table is source-scoped** when a write source is
    present, so a tenant's auto-linking only sees its own entities; the cycle's
    corpus-wide sweep stays whole-brain.

## [1.66.0] — 2026-07-02

### Changed
- **Destructive write tools now scope by the caller's write source (multi-tenant
  hardening).** An adversarial audit found the destructive mutations operated by
  bare slug/id with no tenant filter — isolation rested on the `MEMEX_INTERNAL_TOKEN`
  env gate, not the caller's grant, so a future multi-tenant OAuth writer could
  delete/revert/forget another tenant's content by slug. `deletePage`,
  `restorePage`, `revertPage`, `removeLink`, `removeTag`, `forgetFact`, and
  `purgeDeletedPages` now thread the caller's single write source
  (`effectiveWriteSourceId`) and add `AND source_id = ...` to the mutation — a
  destructive op on a row outside the caller's write source matches zero rows (a
  clean no-op, never a cross-tenant delete). Symmetric to the v1.58 read
  leak-close and additive: an unscoped (local CLI / internal) caller behaves
  exactly as before. Write scope is the caller's SINGLE write source, never the
  federated read set (a tenant may read a union but only delete within its own).

## [1.65.0] — 2026-07-01

### Added
- **`eval-replay run` CI regression gate.** The captured-query replay now exits
  non-zero when a run WITH a persisted baseline drops meaningfully — mean
  reciprocal-rank or hit-rate below the baseline by more than
  `EVAL_REPLAY_REGRESSION_EPS` (default 0.01) — so a pipeline can block a merge
  that silently degrades retrieval quality. A `--promote` run (which rewrites the
  baseline) and a baseline-less first run never gate. Exposed as pure predicates
  `isReplayRegression` / `evalRegressionEps` for testing; the fixture-eval hard
  gate (`eval`) is unchanged, this catches what real captured queries surface.

## [1.64.0] — 2026-07-01

### Added
- **Per-source (per-tenant) health breakdown.** In a multi-tenant deploy one
  tenant's broken ingestion/embedding was invisible inside the whole-brain
  average — you couldn't tell "which tenant is broken". `collectPerSourceHealth`
  reports, per `documents.source_id`, the document/chunk counts, embeddable vs
  embedded chunks, embed-coverage %, code-chunk count, and lag — with the NULL
  source folded into a visible `(unclassified)` bucket. Exposed as a new
  `source_health` MCP tool (scoped: a granted remote caller sees only its own
  sources; the whole-brain roll-up is added only for trusted-local/internal
  callers) and a `memex status --per-source` CLI view. An opt-in doctor check
  (`MEMEX_DOCTOR_PER_SOURCE=1`, non-blocking) WARNs when any single source has
  chunks but zero embeddings (a tenant whose embedding is broken). The existing
  whole-brain `BrainHealthMetrics` and the default doctor run are unchanged.

## [1.63.0] — 2026-07-01

### Changed
- **Source-aware page mirror identity (composite-PK precursor, additive).** The
  page→search-document bridge now keys each page's mirror document by tenant:
  `pageSourcePath(slug, sourceId)` returns `page://<sourceId>/<slug>` for a
  non-`default` source and the legacy `page://<slug>` for `default`/unset — so two
  tenants' same-slug pages map to DISTINCT search documents instead of colliding
  on one id. The 14 existing `default` pages keep their exact legacy mirror id
  (no live re-mirror, no orphans). A shared `PAGE_MIRROR_PATH_SQL` reconstructs
  the id from `(source_id, slug)` in both `reconcilePageMirrors` passes (the
  orphan-detection join is rewritten to be scheme-symmetric so a non-`default`
  mirror is never mis-flagged). `getChunksForPage` builds the tenant-aware id for
  a scoped read. This is the additive, reversible precursor to a future composite
  `(source_id, slug)` primary key — NO primary key is dropped and no migration is
  added here; the global `pages.slug` PK + `putPage`'s cross-source reject remain
  the deliberately deferred, operator-gated final step before two tenants can hold
  the same slug as separate rows.

## [1.62.0] — 2026-07-01

### Added
- **Fail-closed unprovisioned-tenant read policy (opt-in, default OFF).** With
  `MEMEX_TENANT_FAIL_CLOSED=1`, an authenticated PUBLIC principal that presents a
  token but resolves to NO source grant reads nothing instead of the redacted
  whole brain — `effectiveReadSourceIdsForIngress` returns an unownable sentinel
  source (`__memex_no_source__`) that keeps every read handler's `source_id`
  filter engaged and matches zero rows (closing the `[]`-means-all bypass where an
  empty scope array would skip the filter). Provably does NOT touch the daily
  static-bearer path (dispatched with no `authInfo`, so the guard is unreachable)
  nor trusted-local/OAuth-with-grant callers — all keep their exact current view.
  Default OFF: behavior is identical to today until the operator flips the flag
  for a multi-tenant deploy.
- **`reindex --reconcile-deletes` (opt-in).** A note deleted from the vault no
  longer lingers as stale evidence: after the on-disk walk, `reconcileDeletedDocuments`
  soft-deletes (via the existing `softDeleteDocuments` guard — `deleted_at`, clock
  invalidation, TTL purge cascade) every live document whose `source_path` is under
  the swept root but no longer exists on disk. Three safety guards prevent a
  partial sweep from over-deleting: a separator-safe under-root check, an
  existence probe, and a hard skip when the walk was truncated by a file/budget
  cap. Default OFF; the code-root sweep is intentionally not wired (its `--paths`
  can be a subset).

## [1.61.0] — 2026-07-01

### Added
- **Contract-level multi-tenant isolation test harness.** A systematic sweep
  (`tenant_isolation_contract.test.ts`, 22 read tools / 23 cases / 136 assertions)
  that seeds two tenants with deliberately colliding identifiers (shared entity
  name, shared code symbol, shared source path, shared page title, shared graph
  start node with per-source edges) and asserts every read tool — graph traversal,
  insights, facts/resolution, code graph, synthesis, search, whoami — honors the
  caller's `source_id` scope: a scoped read never returns the other tenant's
  content, always returns its own (positive control), and an unscoped local caller
  still sees both. **Result: no leaks** — proves the read-surface scoping holds
  across the full MCP surface. Documents two by-design facts: `list_concepts` is a
  global aggregate (no `source_id` on `synth_concepts`), and `pages.slug` is a
  global primary key (two tenants can't yet literally share a slug).

## [1.60.0] — 2026-07-01

### Added
- **`chunks.source_id` mirror (migration 058, Item 2 batch).** A nullable
  `chunks.source_id` column mirrors the parent `documents.source_id`, backfilled
  once from the parent and kept in sync by the write path (`indexer-tx.ts` stamps
  the authoritative post-upsert source on every chunk). No default (a NULL-source
  document's chunks stay NULL rather than freezing to `'default'` and mis-scoping),
  no FK (a cheap denormalized mirror), partial index on non-NULL. Behavior-neutral
  — retrieval still scopes transitively through the documents join today; the
  per-chunk mirror is for future per-chunk tenant scoping and targeted re-embed.

## [1.59.0] — 2026-07-01

### Changed
- **Utility LLM tier swapped from Amazon Nova Lite to Bedrock Claude Haiku.**
  memex now runs ONLY Anthropic models through AWS Bedrock. The utility tier —
  query intent classification, query expansion, friction-propose, skillify, and
  the quiet-hours synthesis chain (atoms/concepts/takes/calibration) — moves from
  `amazon.nova-2-lite` to `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (verified
  ACTIVE + IAM-granted in eu-west-1). The shared helper `core/llm/nova.ts` is
  renamed to `core/llm/haiku.ts` (`callHaiku`, `DEFAULT_HAIKU_MODEL`, env
  `MEMEX_UTILITY_MODEL` — was `MEMEX_NOVA_MODEL`). Caching, count-caps, fail-open
  behavior, and the injectable test seams are unchanged. Note: Haiku is materially
  pricier per token than Nova Lite and intent runs per query, so utility spend
  rises; the synthesis chain stays count-capped, not USD-capped.

## [1.58.0] — 2026-07-01

### Changed
- **Multi-tenancy read-surface scoping (behavior-neutral, Item 2 batch).** Every
  remaining unscoped read arm now filters by `source_id` when a caller passes
  `sourceIds`, closing tenant-leak paths ahead of multi-tenant go-live. The chunk
  hydrate and the cache-hit `hydrateByIds` path gain a `documents.source_id`
  guard; graph-signals adjacency filters `links.source_id`; the structural
  code-edge frontier is NULL-tolerantly scoped; and the `query`, `get_tags`, and
  `page_versions` MCP tools now thread the caller's read-sources into their
  queries. Unscoped/local callers keep whole-brain behavior unchanged — no
  default change, inert on the single-tenant brain. Leak-lock cases added to
  `tenant_isolation` (query tool, get_tags, page_versions, hydrate, a poisoned
  cross-source cache row, graph-signals adjacency).

## [1.57.0] — 2026-07-01

### Added
- **Paid opt-in Sonnet slices S2–S6 (default OFF, budget-capped).** Five
  agent-layer slices, each gated behind its own env flag and a
  USD `BudgetTracker` — nothing runs, and no Bedrock call is made, until the
  operator sets the flag. All follow the proven conversation→facts / take-
  ensemble template (pre-flight `wouldExceed`, `record` hard ceiling,
  `sanitizeForPrompt` on untrusted text, tolerant JSON parse, injectable
  `SonnetFn` seam so tests never touch Bedrock):
  - **`think` — deep-synthesis pipeline (`MEMEX_THINK`).** New `memex think
    <question>` command + `core/synthesis/think.ts`: GATHER (hybrid page search
    + a keyword scan of `synth_takes`) → one Sonnet synthesis → structured
    `{answer, citations, gaps}` with `[ref]` citations to source paths / take
    keys. Reports across the corpus; never instructs. `MEMEX_THINK_BUDGET_USD`
    (default $1).
  - **Relational-recall LLM fallback (`MEMEX_RELATIONAL_LLM`).** When the
    deterministic regex arm misses a phrasing, `core/search/relational-llm.ts`
    asks Sonnet to extract the same `{kind, seeds, linkTypes, direction}` intent
    (validated against `KNOWN_LINK_TYPES`), then reuses the SAME edge fanout
    (`fanoutRelational`, refactored out of `relationalRecall`). Wired as an
    opt-in fallback in the `relational_recall` MCP tool.
  - **Graph-aware Sonnet rerank (`MEMEX_GRAPH_RERANK`).** Post-fusion reranker
    (`core/search/graph-rerank.ts`) that reorders the top hits with one Sonnet
    call given each hit's excerpt + a link-graph connectivity hint. Fail-open —
    any error/budget-skip returns the pre-rerank order. Distinct from the Haiku
    two-pass `MEMEX_RERANK`. Wired into `hybridSearch` before the trim.
  - **Deep-synthesis cadence (`MEMEX_DEEP_SYNTH`).** `core/synthesis/deep-synth.ts`
    runs the `think` pass over the top `synth_concepts` as standing questions,
    on quiet-hours cycle ticks only, under one shared USD cap; results are
    returned + logged (memex writes nothing back). Distinct from the Nova
    `MEMEX_DREAM_SYNTHESIS` tick.
  - **Contextual-retrieval embed wrapper (`MEMEX_CONTEXTUAL_RETRIEVAL`,
    migration 057).** LLM-FREE tier: `core/search/contextual-embed.ts` prepends a
    `<context>{title}\n{synopsis}</context>` header to each chunk's EMBEDDING
    INPUT only (canonical chunk text untouched); synopsis is the deterministic
    first two sentences of the page; code chunks bypass. Marker column
    `chunks.contextual_embedded` tracks re-embed targeting. The bulk
    `reindex --contextual` re-embed stays operator-gated (not shipped active).

## [1.56.0] — 2026-07-01

### Added
- **Multi-judge Sonnet ensemble for take grading (opt-in, default OFF).** With
  `MEMEX_TAKE_ENSEMBLE=1`, each queued forecasting take is graded by N Bedrock
  Claude Sonnet judges (temperature-diversified) instead of a single Nova pass;
  the verdict is the majority vote with the median confidence of the winners.
  Budget-capped (`MEMEX_TAKE_ENSEMBLE_BUDGET_USD`, default $1) with a per-call
  pre-flight estimate from the real prompt size, `MEMEX_TAKE_ENSEMBLE_JUDGES`
  (default 3). Ensemble grades carry provenance (`grader_model`, `judge_count`,
  migration 056) and a distinct `prompt_version` so they never collide with
  single-pass rows. Paid path — nothing runs until the flag is set; the default
  cycle is unchanged.

### Added
- **`near_symbol` + `walk_depth` structural search expansion (default OFF).**
  The `search` op gains two optional params: `near_symbol` anchors retrieval at
  a qualified symbol name, and `walk_depth` (0-2) expands the fused anchors
  through the code call graph (`code_edges_symbol`), scoring each structural
  neighbor `anchorScore × 1/(1+hop)`. New `core/search/structural-expand.ts`
  walks callers (direct `from_chunk_id`) + callees (resolve-phase
  `resolved_chunk_id`, else name-resolved) in batched per-hop queries, bounded
  by depth ≤ 2, a 50-wide frontier, and ≤ 200 fresh chunks/hop; tenant scope is
  enforced on `documents.source_id` (code edges carry none). Wired into
  `hybridSearch` pre-hydrate (cache bypassed; per-doc dedup widened for the
  walk). Inert on a prose corpus — code chunks only.

### Changed
- **Embedding width is configurable.** `core/embedding.ts` reads
  `MEMEX_EMBED_DIM` (fail-loud, default 1024 = Titan v2) instead of a hardcoded
  literal, so a future embedder swap is an env change, not a code hunt. No
  behavior change at the default.

### Fixed
- **`tool_defs` contract snapshot refreshed** to the current tool set (the
  v1.53 code-intel tools + `whoami` + the new structural-search params), so the
  generated-vs-frozen equality test reflects the live MCP contract again.

## [1.54.1] — 2026-06-30

### Fixed
- **Conversation→facts model id.** `MEMEX_FACTS_MODEL` default corrected to the
  real EU Bedrock inference profile `eu.anthropic.claude-sonnet-4-6` (no
  `-v1:0` suffix), verified ACTIVE + invokable in eu-west-1. The EC2 instance
  role's `bedrock:InvokeModel` was widened (terraform `iam.tf`) to that
  inference profile + the `anthropic.claude-sonnet-4-6` foundation model, so
  the live container can run the extractor once `MEMEX_FACTS_EXTRACTION=1` is
  set. Sonnet stays region-locked via the existing off-region deny.

## [1.54.0] — 2026-06-30

### Added
- **Conversation→facts extraction (opt-in, paid).** A new
  `memex extract-conversation-facts <transcript>` command parses a chat
  transcript into turns (the deterministic conversation parser) and extracts
  structured facts from each turn with Bedrock Claude Sonnet, writing them into
  the `entity_facts` ledger. Default-OFF: a live run requires
  `MEMEX_FACTS_EXTRACTION=1`. Every run is bounded by a USD budget
  (`--budget`, default $1, `MEMEX_FACTS_BUDGET_USD`) — the `BudgetTracker` is a
  hard ceiling that stops the run when spend is reached, and refuses to invoke
  an unpriced model. Untrusted turn text is run through the prompt-injection
  sanitizer and DATA-fenced before the model sees it. The model is the EU
  Bedrock inference profile (`MEMEX_FACTS_MODEL`, default Sonnet 4.6); notes
  never leave AWS. Requires Bedrock model access for Claude Sonnet + an
  `iam.tf` invoke-permission widening before it can run live.

## [1.53.0] — 2026-06-30

### Added
- **Code-intelligence tools (`code_def`, `code_refs`, `code_blast`,
  `code_flow`).** Four deterministic, LLM-free MCP tools over the already-indexed
  code graph. `code_def` lists where a bare symbol is defined; `code_refs` lists
  all references (imports / type uses / non-call); `code_blast` walks the
  transitive callers (blast radius) grouped by hop depth; `code_flow` walks the
  transitive callees with terminal side-effect tagging (db / http / file_io /
  process_exec). The recursive walks are bounded by `depth` + `max_nodes` with
  cycle detection. Internal-ingress only (they surface private repo paths).
- **`whoami` MCP tool.** Introspects the calling identity — `client_id`,
  granted scopes, the write source, and the readable sources — for debugging the
  `client_credentials` multi-client setup. Returns only the caller's own auth
  context; `read_sources` is null when unscoped.
- **Content-date search filters (`since` / `until` / `lang` / `symbol_kind`).**
  `search` now accepts optional filters: `since`/`until` rank on a document's
  CONTENT date (new `documents.effective_date`, parsed at ingest from
  frontmatter `date`/`event_date`/`published` or a `YYYY-MM-DD` filename,
  falling back to `updated_at` via COALESCE), and `lang`/`symbol_kind` filter
  code chunks by language / symbol kind. Filters apply post-ranking and bypass
  the query cache. Migration 055 adds the column + a COALESCE expression index
  (grandfathered, no backfill).
- **Intent-gated recency.** Canonical/definitional queries ("who is X",
  "define X", a bare symbol) now skip the recency + salience decay multipliers,
  so an old-but-authoritative page is no longer buried by freshness on exactly
  the queries that want it. An explicit temporal bound ("…today", "…last week")
  re-enables freshness. Pure regex, no LLM.
- **Slug-prefix curation boost + hard-exclude.** An optional per-prefix
  authority multiplier (`MEMEX_CURATION_BOOST`) lets curated originals outrank
  bulk feeds inside one store, and a hard-exclude denylist
  (`MEMEX_SEARCH_EXCLUDE`, default empty) keeps fixtures / attachments / raw
  sidecars out of results.
- **Eval confidence bounds + per-query isolation.** `memex eval` now reports a
  hit-rate with a Wilson 95% CI (and a small-sample note below n=30), and one
  query throwing no longer aborts the whole run — it scores 0 and the run
  continues, with failures collected in an `errors[]` block.
- **Conversation/chat-transcript parser.** A pure, deterministic
  `parseConversation` turns an exported chat log (iMessage / Slack / Telegram /
  WhatsApp / Discord / IRC / plain transcript) into structured
  `{ speaker, timestamp, text }` messages. No LLM.

### Security
- **DSN / credential redaction in logs.** A new scrubber strips postgres DSNs,
  `password=` / `user=`, and bare IPv4s from error text before it is logged, so
  a postgres-js connection error can no longer write the live credential to the
  operator log on the public-ingress error path.
- **Prompt-injection sanitizer for untrusted corpus.** Note/skill/search-miss
  text injected into the Nova synthesis and friction-propose prompts is now run
  through a shared injection-pattern scrubber + length cap, cutting the trivial
  "ignore prior instructions" surface.

### Fixed
- **Frontmatter empty-scalar bug.** A bare `key:` with no value (e.g. a blank
  `date:`) was stored as `[]` (an array) instead of `""` (a string), breaking
  every `typeof === "string"` reader. It now yields `""`, and is promoted to an
  array only when list items actually follow.

## [1.52.0] — 2026-06-29

### Added
- **Opt-in auto-think (background synthesis).** A new `MEMEX_DREAM_SYNTHESIS=1`
  flag opts memex's existing Nova synthesis chain (atoms → concepts → takes →
  grading → calibration) into the maintenance cycle, running during quiet hours
  only and writing to the isolated `synth_*` store (read via `list_concepts` /
  `list_takes` / `get_calibration_profile`). Default-OFF — the brain stays
  pure-retrieval unless you enable it. Count-capped per phase
  (`MEMEX_DREAM_SYNTHESIS_MAX_*`), Nova Lite, idempotent (re-runs on an unchanged
  corpus are no-ops).

## [1.51.0] — 2026-06-29

### Added
- **Self-issued OAuth 2.1 (`client_credentials`).** memex is now its own
  authorization server — no external identity provider required. Register a
  client with `memex auth register-client <name> --scopes "read write" --source
  <id>`, exchange its credentials at `POST /token` for a `memex_at_…` access
  token, and present that token as `Authorization: Bearer` on `/mcp`. Each token
  is scoped to its client's source set. New CLI: `auth register-client`,
  `list-clients`, `revoke-client`, `grant-token`. Enable with
  `auth.selfIssued.enabled: true` in `memex.yml` (default-off). The `/token`
  endpoint is per-IP rate-limited.

### Removed
- **External-IdP JWT auth path.** The optional third-party JWT/JWKS verifier is
  gone, superseded by the self-issued provider above. Removes a network
  dependency and the need to run a separate identity provider.

### Fixed
- **Bloated `frontmatter` from a bad ingest path.** A document whose metadata
  arrived as a non-object (raw content mis-passed as frontmatter) was stored as a
  multi-megabyte JSON scalar, wasting space and reading back as empty metadata.
  Ingest now coerces any non-object frontmatter to `{}` at the write boundary.

## [1.50.0] — 2026-06-29

### Changed
- **Cycle entity-extraction is now INCREMENTAL.** The extractor re-processes
  only changed docs instead
  of the whole corpus; memex re-walked EVERY
  document every tick (the cycle's heaviest phase, ~1.4 GB / 30 s). memex has no
  cycle sync phase to source a changed-set, so it uses its OWN watermark idiom
  (the one migration 051 already uses for link extraction): migration 054 adds
  `documents.entities_extracted_at`, and `core/extract.ts` selects only stale
  docs — never extracted, extractor version (`ENTITY_EXTRACTOR_VERSION_TS`)
  bumped, or re-indexed since. The cycle runs incremental by default; `extract
  --all` forces a full walk. Each processed doc is stamped to
  `GREATEST(read updated_at, versionTs)` — the `updated_at` arm gives the D4 race
  fix (a concurrent re-index re-stales it), and lifting to the version floor
  stops a doc edited before the current extractor version from re-extracting
  forever. First run after the migration is one final full walk (NULL
  grandfathers every doc), then steady-state incremental.

## [1.49.0] — 2026-06-29

### Changed
- **Frontmatter inference moved to ingest; the recurring cycle phase removed.**
  Inference now runs ONCE per file at import (a pure `inferFrontmatter(path,
  content)`) with NO frontmatter cycle phase; memex had drifted into a recurring
  DB phase that re-scanned every document each tick (the OOM source). New
  `core/frontmatter-inference.ts` (`inferFrontmatter` / `serializeFrontmatter` /
  `applyInference` + the date/title helpers) is wired into `indexDocument` —
  content lacking a `---` header gets an inferred one (title from first H1 /
  filename, type `note`, date from filename) before chunking;
  `IndexFileOptions.inferFrontmatter` (default on) opts out. The
  `core/cycle/frontmatter-inference.ts` phase is DELETED and dropped from the
  cycle (now 12 phases, not 13), so the
  `MEMEX_CYCLE_SKIP_PHASES`/`FM_BATCH`/`FM_MAX_BYTES` OOM band-aids are no longer
  needed. NOTE: `DIRECTORY_RULES` ships empty — the default rule keeps inference
  path-agnostic; operators extend it locally. Retroactive backfill of
  already-stored headerless docs is `reindex --all` (re-ingest re-infers), not a
  timer.

## [1.48.0] — 2026-06-29

### Fixed
- **Ingest content-size cap on the in-memory path (the 30 MB-frontmatter root
  cause).** The 5 MB ingest cap must sit at BOTH entry points — the file path
  AND the in-memory content path (the remote MCP write passes caller-supplied
  content straight in and bypasses the file-size check). memex had only the
  file-path cap (`indexFile`); `indexDocument` — reached by the remote `index`
  tool, the page mirror, and embed-stale — had none, so an unbounded document
  could be stored (the live brain accumulated 18–30 MB-frontmatter voicenote/gcal
  docs this way, which then OOM-killed the cycle). Added the guard: `indexDocument`
  now rejects `Buffer.byteLength(text) > 5 MB` (hardcoded). Covers every
  in-memory caller in one place. NOTE: this stops NEW oversized docs; the ~436 MB
  already stored needs a separate one-off cleanup.
- **Cycle lock TTL 30 → 5 min + sub-TTL refresh + fast skip-retry.** A crashed
  container left a 30-min cycle lock; a new container (different Docker hostname →
  cross-host, not reap-eligible) couldn't supersede it until the TTL lapsed, and a
  skipped tick re-armed a full 6 h later — so the cycle stalled. The fix drops
  the lock TTL 30 → 5 min with an active sub-TTL
  refresh: `LOCK_TTL_MINUTES = 5`, the heartbeat refresher fires every 30 s (was
  10 min) to keep a healthy long run alive under the short TTL, and a lock-
  contended tick now re-arms within the TTL window (`nextTickDelayMs`) instead of
  the full interval. A crashed cross-host holder's row now TTL-expires within
  5 min and the next tick's host-agnostic `tryAcquireDbLock` upsert reclaims it.

## [1.47.0] — 2026-06-29

### Fixed
- **`frontmatter-inference` cycle phase — keyset-paginated to stop the OOM
  SIGKILL (the real fix behind the v1.46.0 skip).** Frontmatter inference belongs
  at import, ONE file at a time (`inferFrontmatter(path, content)`) — not as a
  cycle phase; memex had added it as a DB phase that materialised EVERY doc + its
  chunk-0 content in a single query, which spiked anon memory enough to OOM-kill
  the cycle process at this phase's start on the small live host. Reworked to a
  bounded-iteration pattern: keyset-paginate by id (`MEMEX_CYCLE_FM_BATCH`,
  default 100), pull chunk-0 via a `LIMIT 1` correlated subquery capped at 64 KB
  (`LEFT()`), so peak memory is O(batch) not O(corpus). Re-enables the phase
  without the `MEMEX_CYCLE_SKIP_PHASES` workaround.

## [1.46.0] — 2026-06-29

### Added
- **`MEMEX_CYCLE_SKIP_PHASES` — operator escape hatch to drop a defective cycle
  phase.** A CSV of phase names removed from every tick (`recipes/cycle.ts`
  `parseSkipPhases`), so a phase with a live defect can be isolated WITHOUT
  losing the rest of the maintenance cycle while the defect is root-caused. Used
  on the live brain to skip `frontmatter-inference` — the phase whose start
  consistently SIGKILLs the tick (a hard OOM the GC + 3000m cap of v1.45.0
  reduced but did not eliminate; needs a local heap-profile to root-cause). With
  it skipped the cycle runs end-to-end (lint → … → snapshot) and writes a fresh
  `cycle_snapshots` row again, so re-embed / link-reconcile / salience / the
  `cycle-freshness` signal all resume; the optional frontmatter back-fill is the
  only deferred phase. Wired through the compose env.

## [1.45.0] — 2026-06-28

### Fixed
- **Cycle GC between phases + raise the memory cap — the cycle was being
  SIGKILLed mid-tick by its own container limit.** The per-phase RSS telemetry
  (v1.44.0) + the container logs nailed it: the serve PID 1 dies silently (NO JS
  exception — a SIGKILL signature) right as `frontmatter-inference` starts, then
  the boot sequence reappears (Docker restarts it). The cycle's cumulative
  working set (un-GC'd phase garbage + page cache) climbs across phases —
  lint 1080MB, extract 1367MB, … — and trips the cgroup `mem_limit`, OOM-killing
  the process before a snapshot is written. Two fixes: (1) `core/cycle/index.ts`
  forces a full GC after every phase (`Bun.gc(true)`, `MEMEX_CYCLE_GC=0` to
  disable) so each phase's intermediate allocations are reclaimed before the next
  starts, lowering the cumulative peak; (2) the `mem_limit` default rises 2600m →
  3000m (the kernel had tolerated ~3.48 GB before the cap; 3000m gives the cycle
  room while still leaving headroom for cloudflared + the system on the ~3.7 GB
  host). The standing `cycle-freshness` doctor check (v1.41.0) verifies recovery.

## [1.44.0] — 2026-06-28

### Fixed
- **Contain the cycle OOM + add per-phase memory telemetry.** Diagnosed the live
  cycle stall to a kernel OOM-kill: a bun cycle process reached 3.48 GB RSS on
  the ~3.7 GB host (dmesg `Out of memory: Killed process … (bun) anon-rss:3478424kB`,
  `global_oom`), which killed the process mid-tick, took its in-process timers
  with it (so neither the phase timeout nor the lock refresher could fire), and
  stranded the cycle lock — the maintenance cycle never wrote a snapshot. Two
  changes: (1) `docker-compose.yml` gains `mem_limit` (default 2600m, tunable via
  `MEMEX_MEM_LIMIT`) so a runaway is a clean cgroup OOM-kill + restart of the
  memex container instead of a kernel global-OOM that kills an arbitrary process
  and strands the lock; (2) the cycle logs `rss=<MB>` after each phase
  (`MEMEX_CYCLE_RSS_LOG=0` to silence) so the spiking phase is named — the
  small live corpus (658 docs / 4303 chunks / ≤21 KB chunks, no duplicate
  chunk-0 rows) means the 3.48 GB is not a simple materialisation, and the
  per-phase RSS pins down the real allocator for a targeted follow-up fix.

## [1.43.0] — 2026-06-28

### Fixed
- **Per-phase cycle timeout — a hung maintenance phase can no longer wedge the
  whole tick.** Found live after the v1.42.0 first-tick fix made the cycle run
  again: a phase (the live tick stalled around `frontmatter-inference`) hung in
  an `await` that never resolved — the phase loop never advanced, `runCycleOnce`
  never returned, and the cycle loop's `finally` never released the db-lock, so
  the cycle stalled (no snapshot, lock stuck past its TTL, healthy container).
  `core/cycle/index.ts` now wraps each phase in `withPhaseTimeout` (default 15
  min, `MEMEX_CYCLE_PHASE_TIMEOUT_MS=0` disables): a phase that exceeds the
  deadline rejects, is recorded as a `fail`, and the cycle proceeds through its
  remaining phases (including `snapshot`) and releases the lock — liveness over
  the leaked in-flight work, bounding each phase with its own deadline.
  The underlying reason a specific phase hangs (likely a Bedrock/Nova call with
  no client timeout) is a follow-up; this bounds the blast radius so one phase
  never stalls the cycle again.

## [1.42.0] — 2026-06-28

### Fixed
- **Maintenance cycle starved on a frequently-redeployed brain — first tick now
  fires 60s after boot, not a full interval later.** Root-caused from the
  v1.41.0 `cycle-freshness` check flagging the live cycle 53h stale: the loop
  scheduled its FIRST tick a full `intervalMs` after boot (the prod default is
  6h), and every container recreation (deploy / OOM restart) reset that timer —
  so a brain redeployed more often than its interval never completed a tick, and
  its snapshots / re-embed / link-reconcile / salience passes never ran.
  `recipes/cycle.ts` now defers the first tick by `firstTickDelayMs(intervalMs)`
  = `min(intervalMs, 60s)` (tunable via `MEMEX_CYCLE_FIRST_TICK_DELAY_MS` for a
  tiny instance where 60s of boot contention is still too eager); subsequent
  ticks keep the full interval. A sub-minute test interval keeps its own
  cadence. Deploying this also remediates the live symptom: the 60s tick's
  `tryAcquireDbLock` reclaims the stranded TTL-expired lock and writes a fresh
  snapshot.

## [1.41.0] — 2026-06-28

### Added
- **`cycle-freshness` doctor check — maintenance-cycle liveness probe.** The
  cycle (re-embed, reconcile-links, recompute-salience, snapshot) appends a
  `cycle_snapshots` row every tick, but nothing watched its liveness: a wedged
  loop (stuck db-lock, exception loop) surfaced only via the downstream
  `links-extraction-lag` proxy. `core/cycle-freshness.ts` `checkCycleFreshness`
  reads `MAX(captured_at)` and classifies it warn (>6h) / fail (>24h), thresholds
  overridable via `MEMEX_CYCLE_FRESHNESS_WARN_HOURS` / `_FAIL_HOURS`. Zero
  snapshots is informational (`ok`), not a failure — a fresh brain or a deploy
  that never enabled the cycle loop has none; the signal is an established
  stream going stale. Wired into `memex doctor` (brain category). Staleness is
  WARN-only by default — a deploy that ran the cycle then disabled it keeps old
  snapshots, and a hard `exit 1` there would cry wolf; `MEMEX_CYCLE_FRESHNESS_ENFORCE=1`
  opts into a real failure for a deploy that wants `doctor` to gate on cycle
  liveness. A brain-only `cycle_freshness` check over memex's single snapshot
  stream. The timestamp is projected via `to_char` ISO, not the DateStyle-fragile
  `::text`. Surfaced by the gap-review workflow sweep.

## [1.40.0] — 2026-06-28

### Fixed
- **`pages.last_retrieved_at` write-back — the missing producer for the
  context-volunteer "used" stat.** Migration 024 added `last_retrieved_at` and
  `core/context/volunteer.ts` consumes it (the `stats:true` per-arm precision
  feedback derives `used` from `pages.last_retrieved_at > volunteered_at`), but
  nothing ever wrote the column — so it stayed NULL and the `used` count was
  structurally always 0. `core/last-retrieved.ts` `bumpLastRetrievedAt` now
  stamps `last_retrieved_at = NOW()` when the `page_get` op surfaces a page,
  making the volunteer precision feedback real. The producer uses a 5-minute
  throttle (a hot page surfaced by many fetches doesn't pile up MVCC row
  versions), is best-effort (any failure is swallowed with a warn — the op result
  is never affected), and is default-on with a `MEMEX_TRACK_RETRIEVAL=0` opt-out.
  It is keyed on the `slug` PK (the consumer joins on slug) and awaited in the op
  handler rather than fire-and-forget (memex is single-holder, so it needs no
  dangling-promise drain apparatus, for negligible added latency). `page_get` is
  the only call site — search hits are chunk/document-
  level and carry no page slug, so they don't feed the page-level signal.

## [1.39.0] — 2026-06-28

### Added
- **`memex reindex --rechunk-stale` — targeted chunker-version remediation.**
  Completes the chunker half of the shared version-watermark follow-up (the link
  half shipped in v1.38.0). A `chunker_version` bump (migration 052) was
  DETECT-ONLY: the doctor `chunker-version-lag` count rose but only a natural
  reindex cleared it, and `reindex --all` re-embeds the WHOLE corpus.
  `--rechunk-stale` re-indexes ONLY the documents whose stamped
  `chunker_version` is below the current value for their kind — re-chunking +
  re-embedding just the stale subset. `listStaleChunkerDocIds` (sharing the
  `countStaleChunkerDocs` predicate so the two never drift) feeds a
  `forceStaleChunker` mode in `sweepVault`: a walked vault file whose document
  is stale is re-indexed regardless of mtime, which re-stamps the current
  version and clears staleness. Because memex stores no full document body (only
  `chunks.content`), remediation re-reads the source file from the vault —
  `--rechunk-stale` targets the subset worth re-reading. Operator-
  triggered (no surprise Bedrock cost); markdown/vault only (the code corpus is
  a follow-up). Inert until a chunker constant is bumped (both are 1 today).

## [1.38.0] — 2026-06-28

### Added
- **`memex extract --stale` — incremental link re-extraction sweep.** Bumping
  `LINK_EXTRACTOR_VERSION_TS` (or any page edit) marks pages stale; until now
  that was DETECT-ONLY (the `links-extraction-lag` doctor count rose and only
  fell as each page was next written). The sweep re-runs the SAME link-sync set
  the MCP `page_put` path runs — wikilinks + gazetteer mentions + typed-NER +
  verb-context, each behind its own opt-in gate — over every stale page in
  keyset batches, then advances the watermark. `core/links-stale-sweep.ts`
  (`extractStaleLinks`) + `listStalePagesForExtraction` /
  `markPagesExtractedBatch` in `core/links.ts`; flags
  `--source-id S`, `--catch-up`, `--dry-run`, `--json`. It keysets on the `slug`
  PK, uses one `engine.query` (no postgres/pglite branch), and has no timeline
  arm (memex's put path extracts links only). The D4 race fix stamps
  each page's READ `updated_at` (full-µs `to_char`, not a ms-truncated JS Date)
  so a concurrent edit keeps the page stale for the next run; the stamp is
  lifted to `GREATEST(updated_at, versionTs)` so a page last edited BEFORE the
  current extractor version still clears memex's version-staleness arm and the
  sweep converges (code-reviewer caught the version-arm gap; fixed + regression
  test). Default batch 50 (`MEMEX_EXTRACT_STALE_BATCH`), 30-min budget
  (`MEMEX_EXTRACT_TIME_BUDGET_MS`, `--catch-up` to ignore). Closes the
  link half of the shared version-watermark auto-remediation follow-up.

## [1.37.0] — 2026-06-28

### Added
- **Admin Calibration page — the SPA's sixth page; admin surface complete.**
  `GET /admin/api/calibration/profile` (requireAdmin-gated, null-safe) reads the
  latest `synth_calibration_profile` scorecard via the existing
  `getCalibrationProfile` (the synthesis calibration the cycle already computes);
  `admin/src/pages/Calibration.tsx` renders accuracy + the
  correct/incorrect/partial/unresolvable breakdown, the model id, bias tags, and
  pattern statements (all React-escaped text). Empty-state until a synthesis
  calibration run exists. SVG calibration charts are a follow-on; the scorecard is
  the core. The admin dashboard now carries its full six-page nav (Dashboard ·
  Agents · Request Log · Jobs Watch · Calibration, behind Login).

## [1.36.0] — 2026-06-28

### Added
- **Admin SSE live-activity feed (`/admin/events`) + Dashboard live tail.**
  `src/http/admin-events.ts`
  adds a process-local pub/sub bus (capped at 50 concurrent streams, 25s
  keepalive). Every MCP tool call publishes a REDACTED event (known-only
  operation name, caller identity, latency, ok status — never raw params) from
  the dispatch site, fire-and-forget so it can never block or fail the call. The
  `GET /admin/events` route (requireAdmin-gated, `text/event-stream`) streams
  them to each connected admin browser; the Dashboard's Live Activity table
  consumes the feed via `EventSource`. Backpressured clients drop the frame (not
  the connection); dead clients are evicted on first failed write. Reviewed by
  codex + security-engineer: no CRITICAL/HIGH — hot-path-safe, redacted,
  auth-gated, DoS-capped; the `agent` field is React-escaped on render.

## [1.35.0] — 2026-06-28

### Added
- **Opt-in DB request-log sink (`MEMEX_REQUEST_LOG_DB`).** Populates the
  `mcp_request_log` table (migration 046) the admin Request Log page reads —
  memex's default request observability stays the JSONL audit trail + console
  line; this adds a third, opt-in sink (default OFF). `src/mcp/request-log-db.ts`
  `logToolCallToDb` inserts one redacted row per tool call (known-only operation
  name, caller identity, latency, ok status, the param SUMMARY — never raw
  values), wired fire-and-forget at the MCP dispatch site so a logging failure
  can never fail the call. The Request Log page goes live once the flag is set.

### Changed
- Scrubbed stray private identifiers from `CHANGELOG.md`, `TODO.md`,
  and the entity-salience example fixtures (neutral sample names) to keep the
  public repo free of any non-public project/person names.

## [1.34.0] — 2026-06-28

### Added
- **Admin surface — increment B3: Request Log + Jobs Watch (feed pages).** Two
  read-only A2b endpoints + their SPA pages complete the admin dashboard's
  five-page nav. `GET /admin/api/requests?page=N` paginates `mcp_request_log`
  (the table exists from migration 046; a request-logger populates it — empty
  until then); `GET /admin/api/jobs/watch` returns job status counts + the 25
  most-recent jobs. Both behind the single `requireAdmin` gate; `LIMIT`/`OFFSET`
  are bound params and `error_message`/`last_error` are capped at 300 chars in
  SQL (codex hardening). New `RequestLog.tsx` (paginated table) + `JobsWatch.tsx`
  (status metrics + a 15s-polling recent-jobs table). codex reviewed (no
  injection; perf-at-scale + error-truncation LOWs addressed). An SSE
  `/admin/events` live feed and a Calibration page are deferred — they
  need an event bus and a calibration backend that memex does not have; the
  Jobs Watch poll + the Dashboard 30s refresh cover the live-status need.

## [1.33.0] — 2026-06-28

### Added
- **Admin surface — increment B2: the Agents provisioning page.** A new
  `admin/src/pages/Agents.tsx` + sidebar nav: lists the tenant `source_grants`,
  with modals to register a tenant source and provision a JWT-subject grant
  (write source + comma-separated federated-read ids), and a per-row revoke.
  Drives the already-shipped A2 endpoints (`/admin/api/grants`, `sources`,
  `revoke-grant`) — no new backend. The page is modeled on memex's `sources` +
  `source_grants` tenancy, reusing the existing admin CSS. codex reviewed (no XSS — React
  auto-escapes server data; a duplicate React-key LOW was fixed). Built into the
  served SPA. The live feed pages (B3) are next.

## [1.32.0] — 2026-06-28

### Added
- **Admin surface — the dashboard is live at `/admin` (increments B1 + C).** The
  Vite/React admin SPA (`admin/`, React 19 + Vite 6) now builds in a dedicated
  Dockerfile `admin-builder` stage and is served at `/admin` from Bun.serve.
  B1 ships the scaffold + Login (bootstrap-token / magic-link model) + Dashboard
  (corpus counts + brain health from `/admin/api/full-stats`), with `api.ts`
  wrapping the A2 endpoints. C adds `src/http/admin-static.ts` — it serves the
  built `admin/dist` (resolved relative to the module, `/app/admin/dist` in the
  container) with an `index.html` SPA fallback, dispatched only for `GET /admin*`
  AFTER the auth routes (A1) and the data API (A2) so those always win. A
  `resolve()`+`relative()` path-boundary guard blocks traversal out of `dist`
  (the string-prefix form codex flagged is fixed). Only the static `dist` crosses
  from the builder stage — React/Vite/node_modules never reach the runtime image.
  The Agents provisioning page (B2) and the live feed pages (B3) extend the SPA
  next. codex reviewed the static serve + Dockerfile.

## [1.31.0] — 2026-06-28

### Added
- **Admin surface — increment A2: data + provisioning endpoints.** The
  `/admin/api/*` routes the admin SPA reads, on Bun.serve (`src/http/admin-api.ts`).
  Shaped around memex's tenancy model — memex provisions tenant `sources` +
  JWT-subject `source_grants`, so the handlers wrap the SAME provisioning core
  the `tenant` CLI uses (`core/sources.ts`,
  `core/tenant-grants.ts`) plus the brain stats: `GET /admin/api/full-stats`
  (brain health + corpus counts), `GET /admin/api/grants` (list), `POST
  /admin/api/sources` (register a tenant source), `POST /admin/api/grants`
  (provision a subject grant), `POST /admin/api/revoke-grant`. A single
  `requireAdmin` gate fronts the whole surface before any engine work, with
  per-route checks kept as defense-in-depth. Reviewed by codex +
  security-engineer: no CRITICAL/HIGH; the LOWs (generic 500 instead of leaking
  SQL error text, strict `read[]` validation, auth-before-engine) were fixed.
  Increment B (the SPA) and C (embed + serve) follow.

## [1.30.0] — 2026-06-28

### Added
- **Admin surface — increment A1: cookie + magic-link auth.** First slice of the
  full admin surface. `src/http/admin.ts`
  (`createAdminAuth`) mounts the `/admin` auth routes on Bun.serve, an
  express→Bun adaptation: `POST /admin/login` (bootstrap token → constant-time
  `sha256` compare → 24h session cookie), `POST /admin/api/issue-magic-link`
  (`Authorization: Bearer <bootstrap>` → a 5-minute single-use nonce URL),
  `GET /admin/auth/:nonce` (single-use redemption → 7d session + redirect),
  `POST /admin/api/sign-out-everywhere`, and a `requireAdmin` check. Sessions +
  nonces are in-memory (LRU-capped); the cookie is HttpOnly + SameSite=Strict +
  conditional-Secure. The public bearer guard exempts `/admin*` (admin carries
  its own auth); `serve.ts` mints the bootstrap token from `MEMEX_ADMIN_BOOTSTRAP`
  or an ephemeral per-run value. Reviewed by codex + security-engineer: no
  CRITICAL/HIGH; the MEDIUM (rate-limit `/admin/login`) and LOWs (cf-connecting-ip
  rate key, malformed-nonce 401-not-500) were fixed. Increments A2 (data +
  provisioning endpoints), B (the SPA), and C (embed + serve) follow.

## [1.29.0] — 2026-06-28

### Added
- **Verb-context inference wired into the edge writer (`syncVerbLinksForPage`).**
  Completes the v1.28.0 inference core: with `MEMEX_LINK_VERB_INFER=1` (default
  OFF), a page write derives typed edges (`works_at` / `invested_in` / `founded`
  / `advises`) from the prose around each `[[wikilink]]` and persists them.
  Migration 053 widens the `links.link_kind` CHECK to add a distinct `verb_ner`
  origin, so prose inference DELETE-replaces ONLY its own edge set — it never
  touches `plain` (wikilink + gazetteer) or `typed_ner` (frontmatter typed-links)
  edges, and yields to an explicit/frontmatter edge on the same
  `(source, target, type)` via `ON CONFLICT DO NOTHING`. Wired as a separate
  source after `syncTypedLinksForPage` at `page_put` / `page_append` /
  `page_revert`. Reviewed: codex confirms the DELETE scoping is collision-free,
  the CHECK swap is lock-safe on the single-connection boot apply, and the
  yield-to-frontmatter loop is stable. `verb_ner` is an internal raw-SQL origin
  (not a valid explicit `addLink` input). This closes the bare-wikilink +
  verb-context backlog item — the full link-extraction surface.

## [1.28.0] — 2026-06-28

### Added
- **Verb-context link-type inference core (`inferLinkType`).** A deterministic
  (LLM-free) wikilink edge-typing pass: `inferLinkType`
  classifies a `[[target]]` edge from the prose around the mention —
  `founded > invested_in > advises > works_at` per-edge verbs, then a
  person→`companies/*` page-role prior (`investor > advisor > employee`), else
  `mentions`. `src/core/link-verb-infer.ts` carries the verb regexes
  (calibrated against a rich-prose corpus),
  `edgeContextWindow` (the ~240-char per-edge window), and the opt-in flag
  `MEMEX_LINK_VERB_INFER` (default OFF). Reviewed: codex confirms the regexes +
  precedence are internally consistent. This ships the inference KERNEL with
  unit tests; the live edge-writer wiring is deferred (see below) because
  prose-inferred types collide with the existing frontmatter typed-links and
  gazetteer edges in the wikilink DELETE-replace and need a distinct edge-origin
  discriminator first.
- **`[[bare-name]]` wikilink resolution — confirmed already covered (no change).**
  A generic bare-wikilink pass + basename matching is already
  covered by memex's `extractWikilinks` (which captures every `[[…]]`, not just
  dir-qualified) feeding the `slug-canonicalize` resolver's exact-tail and prefix
  basename stages. memex's 5-stage confidence cascade already handles this
  (arguably richer); nothing to add.

## [1.27.0] — 2026-06-28

### Added
- **Per-document chunker version (`chunker_version`).** Re-chunk-on-bump
  detection for memex's document/chunk model. Migration 052 adds
  `documents.chunker_version SMALLINT NOT NULL DEFAULT 1` (grandfather: every
  existing doc reads version 1). `MARKDOWN_CHUNKER_VERSION` (recursive.ts) and
  `CODE_CHUNKER_VERSION` (code.ts) — both start at 1; bump one when its splitter
  logic changes to mark the affected corpus for re-chunk + re-embed. The version
  is stamped onto the document in the index UPSERT (a reindex re-chunks under the
  current splitter and advances the stamp; a metadata-only re-put preserves it).
  `core/chunker-version.ts` `countStaleChunkerDocs` counts documents below the
  current version for their kind (the predicate branches on
  `frontmatter->>'kind' = 'code'` — independent markdown/code namespaces), and a
  new informational `chunker-version-lag` doctor check surfaces the backlog
  (ok:true). Implementation notes: single `engine.query`; no OpenAI
  cost-prompt (memex is Bedrock). Distinct from the inert
  source-level `sources.chunker_version` stub (migration 024), left untouched.

## [1.26.0] — 2026-06-27

### Added
- **Link-extraction freshness watermark (`LINK_EXTRACTOR_VERSION`).** A
  `links_extracted_at` freshness design. Migration 051 adds a
  nullable `pages.links_extracted_at TIMESTAMPTZ` (+ a `(source_id,
  links_extracted_at)` index, no backfill — every existing page reads stale until
  next written, which is the point). `core/links.ts` gains
  `LINK_EXTRACTOR_VERSION_TS` (bump it when extractor logic changes to force a
  re-sweep), `stampLinksExtracted(engine, slug)`, and
  `countStalePagesForExtraction(engine, {sourceIds, versionTs})` with the
  staleness predicate — a page is stale when `links_extracted_at IS NULL OR <
  VERSION_TS OR updated_at > links_extracted_at`. The watermark is stamped after
  the full link-sync set (wikilinks + gazetteer mentions + typed-NER) on
  `page_put` / `page_append` / `page_revert`, so it advances past the page's own
  `updated_at` and reads clean until the next edit. A new informational
  `links-extraction-lag` doctor check surfaces the stale backlog (ok:true — a
  brain can legitimately run with un-extracted pages). Implementation notes:
  single `engine.query` (no postgres/PGLite branch), stamp at the dispatch put
  paths (memex syncs links there, not in a bespoke engine method). Known
  limitation (no batch `extract --stale` sweep yet): the watermark
  advances only on a page write, so bumping `LINK_EXTRACTOR_VERSION_TS` is
  detect-only — it surfaces the version backlog in the doctor but does not
  auto-remediate untouched pages until a stale-sweep command lands (tracked in
  TODO). The NULL and edited-since arms are fully remediated by the inline stamp.

## [1.25.0] — 2026-06-27

### Added
- **db-lock full lifecycle: active auto-takeover, cleanup-registration, and an
  inspect/reap surface.** The cycle lock shipped as a simplified TTL+steal-grace
  primitive; this completes the `db-lock` lifecycle.
  `tryAcquireDbLock` now reclaims a provably-dead **same-host** holder
  immediately (PID-probe + grace window, `classifyHolderLiveness` /
  `isHolderDeadLocally`) instead of waiting out the 30-min TTL, and registers a
  cleanup callback so abnormal termination releases the lock. New
  `src/core/process-cleanup.ts` installs
  SIGHUP/SIGPIPE/uncaughtException/unhandledRejection handlers that run
  registered releases on a 3s deadline (NOT SIGINT/SIGTERM — memex's `serve`
  owns those via its graceful `shutdown()`, so a competing handler would race
  the drain); the cycle daemon's `startCycleLoop.stop()` now also releases the
  in-flight tick's lock deterministically before the engine closes (so a deploy
  SIGTERM mid-tick can't strand the lock). Added the operational surface `inspectLock`,
  `listStaleLocks`, `deleteLockRow`/`deleteLockRowIfStale`/`deleteLockRowExact`
  (snapshot-matched, PID-reuse-safe), `isLockHolderLive`, and a host-scoped
  `reapDeadHolderLocks` background sweep run at cycle start. Implementation notes:
  memex uses a single `engine.query` (no separate postgres/PGLite branch or
  second pool); `cycle_locks` table, `memex-cycle` namespace. No migration (the
  columns already exist).

## [1.24.1] — 2026-06-27

### Fixed
- **alias-hop returns every claimant of an exact alias (fidelity re-audit).**
  `resolveAliasCandidates` capped the fetch at `LIMIT 8` with no `ORDER BY`, so a
  query alias claimed by more than 8 pages fetched a nondeterministic 8 before
  `applyAliasHop` sorted them by `(source_id, slug)` and took the top
  `MAX_ALIAS_INJECT` — the true ordered survivors could be missed. The cap is
  removed and the fetch is `ORDER BY source_id, slug` (an unbounded, ordered
  resolve); the injected set is still bounded downstream by
  `MAX_ALIAS_INJECT`. An exact-alias match has few claimants in practice.

## [1.24.0] — 2026-06-27

### Added
- **`content_flag` WARN marker surfaced on search hits.** A
  `getContentFlagsByPageIds` + `stampContentFlags`
  agent-warning channel. A document whose frontmatter carries a `content_flag`
  marker stays fully searchable, but each result it produces is now stamped with
  `SearchHit.content_flag = { reason, detail }` so the MCP client can decide
  whether to trust the page (the WARN tier of `quarantine.ts`, vs the HIDE tier
  `quarantine`). `src/core/search/content-flag.ts` reads `reason`/`detail` in SQL
  with `->>`; `stampContentFlags` runs post-fusion
  on the final sliced set (bounded by `k`) on both the live and cache-hit search
  paths, mutating hits in place, and is fail-open — a flag-fetch error never
  breaks retrieval. Implementation notes: doc-keyed over `documents.frontmatter`
  (memex search is chunk→document keyed), TEXT ids, `engine.query`.

## [1.23.0] — 2026-06-27

### Added
- **`embed_skip` frontmatter marker.** An embed-skip predicate, sibling to the
  existing `quarantine`/`content_flag`
  markers: a document whose frontmatter carries `embed_skip` is indexed and
  fully keyword-searchable but never embedded. `src/core/embed-skip.ts` exposes
  `isEmbedSkipped(frontmatter)` (key-existence — marker contents are diagnostic)
  and `embedSkipFilterFragment(docAlias)` (a `NOT (frontmatter ? 'embed_skip')`
  SQL fragment, reusing `quarantine.ts`'s `assertSqlAlias`). Wired into the two
  memex embed paths: the inline indexer skips embedding an `embed_skip` page's
  chunks (they land with a null vector), and `embed-backfill` excludes them from
  its missing-chunk candidate set. The cycle re-embed phase re-indexes via the
  indexer, so it inherits the gate. Note: only the embed PATHS honour
  the marker — the embed-coverage METRIC still counts these chunks. The
  oversized-page auto-writer is a separate
  deferred content-sanity increment; this ships the operator-declared path.

## [1.22.0] — 2026-06-27

### Added
- **Advisor surfaces graph-hygiene gaps (orphan pages + dead links).** The
  graph-hygiene half of the `usage-shape` advisor
  collector (the embedding-coverage half already lives in `collectEmbedCoverage`).
  A new `collectUsageShape` collector emits an `orphan_pages` finding (pages with
  no inbound AND no outbound link — islanded, invisible to graph traversal; fix:
  `memex orphans`) and a `dead_links` finding (a live-source link whose
  `target_slug` resolves to no live page; fix: `memex doctor`). Both counts come
  from one read-only round trip; it runs on the explicit
  `advisor` pass, not a hot sync path. Soft-delete handling: because memex
  soft-deletes pages (keeping the link rows), it gates every edge on a
  live page at both ends — a link to/from a soft-deleted page counts as a
  non-edge. Empty brain → no findings.

## [1.21.0] — 2026-06-27

### Added
- **Bounded query-embed deadline → keyword-only fallback.**
  `embedQueryBounded`/`makeQueryEmbedDeadline` bound the query embed: `hybridSearch`
  races the query embed against `MEMEX_QUERY_EMBED_TIMEOUT_MS` (default 6000,
  floored at a 2s minimum budget) via `AbortSignal.timeout`; `embedText` accepts
  the signal so the in-flight Bedrock request is actually cancelled. On timeout
  or error the vector arm is dropped and retrieval proceeds keyword-only. Success
  path unchanged.
- **DB-backed cycle concurrency lock.** A
  `db-lock` primitive: `src/core/db-lock.ts` (`tryAcquireDbLock` — an upsert with
  a TTL + heartbeat steal-grace, `holder_pid`/`holder_host` scoped
  refresh/release) over a new `cycle_locks` table (migration 050). The
  maintenance cycle acquires `memex-cycle` before each run, skips if another
  holder is live, and releases in `finally`; a crashed holder is reclaimed after
  the TTL/grace lapses.
- **`Retry-After` on inbound 429.** Standard 429 response shape:
  the per-caller token-bucket limiter now exposes a read-only `retryAfterSeconds`
  (seconds until the caller's bucket refills one token, ≥1, clamped to avoid an
  `Infinity` header), and the MCP 429 response carries it as a `Retry-After`
  header.

### Fixed
- **Alias-hop reworked for full-fidelity resolution (corrects v1.20.0).**
  The first cut resolved a single candidate, boosted an injected page by ×1.10,
  and skipped the final sort on the absent path. It now resolves ALL claimants
  (`resolveAliasCandidates`), orders them by `(source_id, slug)` and caps at
  `MAX_ALIAS_INJECT=3` (collision handling), boosts a present page ×1.10, injects
  an absent page at top-of-organic + ε (a small bump, never an absolute or
  boosted score — aliases are not a ranking sledgehammer), and always re-sorts.

## [1.20.0] — 2026-06-26

### Added
- **Alias-hop — search resolves a query that is exactly a page's declared
  alias.** A page can declare free-text aliases in `compiled_truth.aliases`
  (migration 034, indexed in `page_aliases`); the wikilink resolver already used
  them, but search did not, so a query that is exactly an alias (e.g. "Bobby"
  for `people/bob`) missed the page when the alias never appears in its body.
  `hybridSearch` now runs an alias-hop after rerank: it normalizes the whole
  query, requires an EXACT match to a declared alias (≤6 tokens, unique
  resolution — a collision resolves to nothing), then boosts the canonical page
  ×1.10 if it is already in the results or injects its representative chunk at
  the head if absent. Source-scoped and visibility-filtered, so it never
  surfaces another tenant's or a soft-deleted page. Default ON (the exact-match
  gate keeps the blast radius tiny — a normal query is a no-op); `MEMEX_ALIAS_HOP=0`
  disables it. Folded into the query-cache ranking signature (version `5`).

## [1.19.0] — 2026-06-26

### Security
- **Defensive Row-Level Security enable (migration 049).** Flips
  `relrowsecurity` on across every content + auth data table (the `migrations`
  ledger excluded) as a defense-in-depth marker — tenancy isolation itself stays
  enforced at the application layer (the `source_id` scope filter from migration
  047 + the dispatch wiring). The enable is deliberately inert today: no policy
  is created and `FORCE` is not set, and the `ALTER`s run only when the migrating
  role holds `BYPASSRLS` (such a role is itself exempt, and table owners are
  exempt without `FORCE`), so the brain's behaviour is unchanged. On a managed
  Postgres where the app role lacks `BYPASSRLS`, the migration raises a NOTICE
  and touches nothing. PGLite-safe (its `postgres` role has `BYPASSRLS`; the full
  suite runs unchanged). This lays the groundwork for a future per-row policy
  without altering current reads or writes.

### Fixed
- **Graph-signals score floor is now wired (was a no-op).** The opt-in
  graph-signals ranking stage carried a `floorThreshold` gate — "a hit below the
  floor is exempt from every graph signal" (adjacency/cross-source boost **and**
  session demotion) — but `hybridSearch` never computed or passed a threshold, so
  the gate never fired. `hybrid.ts` now derives a relative floor,
  `topScore × MEMEX_GRAPH_SIGNALS_FLOOR` (a ratio in `[0,1]`), via the new
  `computeFloorThreshold`, and threads it into `applyGraphSignals`. Unset (the
  default) resolves to `-Infinity`, so the gate stays inert and ranking is
  byte-identical to before — the floor only bites when an operator opts in
  alongside `MEMEX_GRAPH_SIGNALS=1`. The ratio is folded into the query-cache
  ranking signature (bumped to version `4`) so a floor change can't serve a
  stale ordering. Env parse is fail-loud on a malformed/out-of-range value.

## [1.18.1] — 2026-06-26

### Added
- **`tenant` provisioning CLI — onboard multi-tenant users.** Makes the v1.18.0
  tenancy operable by populating the `source_grants` table:
  `tenant add <id> [--name]` registers a tenant source, `tenant grant <sub>
  --source <id> [--read a,b]` grants a JWT subject a write source + federated
  read set (validates every id against `sources` before writing — no dangling
  grants, since Postgres can't FK an array), `tenant list`, `tenant revoke
  <sub>`. Until a grant row exists for a subject the brain stays unscoped
  (single `default` tenant), so this is the switch that turns isolation on
  per user.

## [1.18.0] — 2026-06-26

### Added
- **Multi-tenancy foundation (auth tables + scope model).** First slice of the
  company-deployable, multi-user brain (see `docs/tenancy.md`). Adds the OAuth
  scope hierarchy (`src/core/scope.ts`: `admin > sources_admin/users_admin/write
  > read`, `agent` standalone) and migration `046_oauth.sql` — `access_tokens`,
  `mcp_request_log`, `oauth_clients` (with `source_id` write-scope +
  `federated_read[]` read-scope), `oauth_tokens` (revocable), `oauth_codes`.
  Purely additive: the tables sit empty until the `source_id` data-model
  migration and the auth wiring land, so this is safe on a single-holder brain.
  A multi-tenant scope model, reviewed by
  security + architecture passes before merge.

- **Tenancy data model + auth primitives (migration 047 + ports).** `source_id`
  added to `pages`/`links`/`entity_facts`/`timeline_events`/`tags`
  (+`page_versions`); pages keep the `slug` PK with a new `UNIQUE(source_id,
  slug)` (incremental path); the system `default` tenant is seeded.
  `documents.source_id` is left nullable so the existing path-prefix source
  classifier keeps working. Write paths now stamp `source_id` (indexer, the
  page→search bridge incl. the cycle re-mirror, and `page_put` with a
  cross-tenant overwrite guard); `page_get`/`page_list` take a source filter and
  the search arms already scope on `documents.source_id`. Ports landed:
  `core/auth-info.ts` (AuthInfo + fail-closed source-scope resolvers) and
  `core/oauth-provider.ts`. Full Bun suite green (1353/0).

- **Tenancy activated end-to-end (dispatch + http wiring).** `dispatchTool`
  resolves the caller's source grant from `DispatchOptions.authInfo`
  (`effectiveReadSourceIds`/`effectiveWriteSourceId`) and threads it through the
  read/write handlers — search, pages, facts, timeline, links, graph,
  backlinks, resolve_slugs, tags. The HTTP ingress builds an `AuthInfo` from a
  verified Cognito JWT's `source_id` + `federated_read` claims; the static
  public bearer and the internal token stay unscoped (whole-brain) for
  back-compat. New `tests/tenant_isolation.test.ts` is the cross-tenant contract
  (tenant B cannot read A's pages/facts/timeline/links). Full Bun suite green
  (1360/0).

- **Tenant isolation hardened across the full read/write surface + server-side
  entitlement floor.** Migration `048_source_grants.sql` adds a `source_grants`
  table (`sub` → `source_id` + `federated_read[]`); the HTTP ingress now
  resolves a caller's grant from that table by the JWT `sub` — token claims are
  **no longer trusted** for tenancy (the IdP only proves identity). Every
  remaining read path is source-scoped: `get_chunks`, `relational_recall`,
  `find_orphans/experts/contradictions/trajectory`, `get_recent_salience`,
  `find_anomalies`, `code_callers/callees`, `list_takes`, `entity_recall` (incl.
  its page-body fetch), `backlinks`. Derived writes from `page_put`/`page_append`
  (wikilink/mention/typed-link edges, fence facts) stamp the page's `source_id`
  instead of landing in `default`. `tests/tenant_isolation.test.ts` now has 12
  cross-tenant leak-lock cases. Two adversarial security passes; full Bun suite
  green.

### Notes
- `list_concepts` / `get_calibration_profile` are global synthesis aggregates
  (no `source_id`, mig 045) — not per-tenant by design. Remaining for go-live
  (tracked in `docs/tenancy.md` / `TODO.md`): the RLS backstop (defense-in-depth)
  and an operator policy call on un-provisioned subjects (today: unscoped
  *redacted* read; consider fail-closed). No live deploy without an explicit
  decision.

## [1.17.0] — 2026-06-25

### Added
- **Public-ingress constructive writes (opt-in, default OFF).** The
  `MEMEX_PUBLIC_WRITE=1` flag now opens *only* the constructive knowledge-write
  tools to the public/authenticated `/mcp` path (static bearer or OAuth):
  `index`, `page_put`, `page_append`, `add_fact`, `add_timeline_event`,
  `add_tag`, `link`. This lets a remote MCP client record into the brain over
  an authenticated remote-write surface. Destructive ops
  (`page_delete`, `page_restore`, `page_revert`, `unlink`, `remove_tag`,
  `purge_deleted_pages`, `forget_fact`) and privacy-sensitive content/identifier
  reads stay internal-only regardless of the flag — hard deletes stay
  local-CLI-only. Previously the flag was all-or-nothing (it
  un-forbade the entire set, including destructive ops and private reads); it is
  now surgical. Bearer/OAuth auth is still enforced before any write. Wired into
  compose as `MEMEX_PUBLIC_WRITE=${MEMEX_PUBLIC_WRITE:-0}`.

## [1.16.2] — 2026-06-23

### Fixed
- **`global.amazon.nova-2-lite-v1:0` now invokes — un-degrades intent
  classification, query expansion, and synthesis.** The `BedrockDenyOffRegion`
  IAM statement denied every Nova call: the `global.*` inference profile routes
  the underlying foundation-model invocation region-less, so the deny's
  `aws:RequestedRegion` allowlist never matched and Bedrock returned
  `AccessDeniedException`. Scoped the deny to `anthropic.claude-*` only — Nova
  (cheap, credit-eligible) may now route worldwide, while the expensive Claude
  models stay region-locked. `var.bedrock_allowed_regions` now governs Claude
  alone.

## [1.16.1] — 2026-06-23

### Fixed
- **`memex cycle --phases` now accepts the synthesis phases.** The opt-in
  synthesis phases (extract-atoms / synthesize-concepts / propose-takes /
  grade-takes / calibration-profile) were valid in the run switch but rejected
  by the CLI's phase validator (which only knew `ALL_PHASES`), so they were
  unreachable from the command line. Added `SYNTHESIS_PHASES` and widened the
  validator to `ALL_PHASES ∪ SYNTHESIS_PHASES`.

### Added
- **`terraform/cognito.tf`** — optional AWS Cognito user pool for the OAuth path
  (Wave 6). Gated by `var.enable_oauth` (default **false** → creates nothing);
  fully additive. Outputs `cognito_issuer` / `cognito_jwks_uri` /
  `cognito_app_client_id` to drop straight into `auth.oauth`.
- **`memex.yml.example`** documents the `auth.oauth` block (default-OFF, rides
  the existing /mcp ingress, lock to your own `sub` for a private test).

## [1.16.0] — 2026-06-23

### Added
- **OAuth/JWT bearer auth — app-layer** (Wave 6).
  **Default-OFF / config-gated**: when `auth.oauth.enabled !== true` (the
  default), behaviour is byte-identical to today's static-bearer auth. When
  enabled, an `Authorization: Bearer <jwt>` that fails the static check is
  verified against the configured issuer's JWKS (RS256/ES256 via WebCrypto — no
  new dependency), with `iss`/`aud`/`exp`/`nbf` + optional `sub` allowlist +
  clock-skew checks; a valid token maps to the **public (redacted) read scope
  only** — never internal, never a write path. Fail-closed (any verify error
  keeps the original 401). New `http/oauth.ts` + `auth.oauth` config block.
  Two security passes CLEAN (alg pinned before key import, signature before
  claims, no creds logged, no network when disabled).
  **NOT enabled / needs the operator:** (a) terraform public ingress
  (ALB/SG/TLS + JWKS egress) — app-layer can't open the port; (b) a
  tenancy/data-partitioning decision if true multi-tenant is wanted (memex has
  no per-user data model — every token currently maps to the one shared brain);
  (c) pick an IdP + fill `auth.oauth`. Until then it stays off.

## [1.15.0] — 2026-06-23

### Added
- **LLM synthesis** (Wave 5) — the brain now derives
  higher-level knowledge from the corpus via Bedrock Nova. **Opt-in,
  default-OFF** (the five phases are NOT in `ALL_PHASES`; they run only when
  explicitly requested). **Source notes are never touched** — all output lands
  in dedicated `synth_*` tables (migration 045), each row carrying provenance +
  `generated_at` + `model_id`.
  - Cycle phases (order: atoms → concepts → takes → grade → calibration):
    **`extract-atoms`** (distil notes into atomic claims), **`synthesize-concepts`**
    (cluster atoms into concept pages), **`propose-takes`** (derive opinionated
    claims to a review queue), **`grade-takes`** (evidence-ground each take),
    **`calibration-profile`** (narrative bias/calibration profile). Each is
    budget-capped, idempotent, and fail-open (an LLM error logs + skips, never
    corrupts the brain).
  - Read tools: **`list_concepts`**, **`list_takes`**, **`get_calibration_profile`**
    — internal-only (LLM-derived over private notes).
  - New `core/synthesis/{atoms,concepts,takes,calibration,reads}.ts` +
    `core/llm/nova.ts` (shared Nova helper with an injectable test seam — tests
    mock the LLM, zero Bedrock calls). **55 MCP tools.**
  Design notes: own-namespace `synth_*` tables instead of writing atoms/
  concepts into `pages`; Nova for the LLM calls; voice-gate / ensemble-judge /
  auto-apply machinery dropped — grades stay advisory.

## [1.14.0] — 2026-06-23

### Added
- **`advisor` + `list_brain_skillpack` MCP tools** (Wave 4) —
  deterministic, zero-LLM.
  - **`advisor`** — ranked, read-only "what to do next": pending migrations,
    version drift, stalled/failed jobs, low embedding coverage, and the
    `MEMEX_INTERNAL_TOKEN` setup smell. Each finding carries a severity
    (high/medium/low/info), a why-it-matters, and the exact fix command — it
    never mutates and never runs the fix. Reuses memex's existing doctor / status
    / jobs primitives (no parallel diagnostic engine). Internal-only (surfaces
    operational state). New `core/advisor/{types,run,collectors}.ts`.
  - **`list_brain_skillpack`** — lists the brain-resident skill pack
    (`deploy/skills/` slug + one-line description). Public-safe (catalogue only,
    like `list_link_sources`). New `core/skillpack/brain-resident.ts`.
  52 MCP tools. Design notes: no DB config-key plane → the public
  gate is `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`, not `mcp.publish_advisor`; no
  workspace/skill-install nagging; no `--apply` exec path — findings are
  human-runnable command strings.

## [1.13.0] — 2026-06-23

### Added
- **Push-based context** (Wave 3) — deterministic, zero-LLM.
  Given a rolling conversation window, the brain extracts entity candidates,
  resolves them to existing pages by **alias (0.9) / title (0.8) / slug-suffix
  (0.6)** with a +0.05 boost for newest-turn or repeated mentions, gates by
  confidence, caps to N, and volunteers pages — instead of waiting for a pull.
  - **`volunteer_context` MCP tool** — `window` → volunteered pages
    `[{slug,title,confidence,arm,rationale,synopsis}]`; `stats:true` returns the
    per-arm used/volunteered precision (derived from `last_retrieved_at`, no
    extra writes). Internal-only (surfaces slugs/titles/synopses).
  - **`memex watch` CLI** — streams `user:`/`assistant:` turns from stdin,
    maintains a rolling window, prints volunteered pointers as JSONL/text,
    suppresses already-volunteered slugs per session.
  - **`context_volunteer_events` feedback log** (migration 044) — one row per
    volunteered page (slug/confidence/arm/rationale/channel only — **never the
    conversation text**); pruned at 90 days by the `purge` cycle phase.
  - New `core/context/{entity-salience,reflex,volunteer,volunteer-events}.ts`.
  50 MCP tools. Design notes: single-source flat vault (no source_id
  federation); the PGLite-IPC reflex orchestrator is out of scope.

## [1.12.0] — 2026-06-23

### Added
- **Code-graph activation** (Wave 2). memex already shipped
  the tree-sitter code chunker, `code_edges_symbol` table, and the
  `resolve-symbol-edges` cycle phase, but they were dormant on a markdown-only
  corpus. Now:
  - **`memex index <path>` auto-detects code** — a recognised source extension
    (`.ts/.tsx/.mts/.cts/.py`) is routed through `indexCodeFile` (tree-sitter
    chunk + symbol + call-graph extraction) instead of the markdown path; the
    result reports `kind: "code" | "doc"`. (Whole trees still go through
    `memex reindex --source code`.)
  - **`code_callers` + `code_callees` MCP tools** — expose the call graph that
    was previously CLI-only. `code_callers(name)` returns who calls a symbol;
    `code_callees("<path>:<line>")` resolves the innermost code-def covering
    that line then returns what it calls (`resolved_symbol` reports the match).
    New `core/code-graph.ts`; deterministic, internal-only (they surface source
    paths + symbols). 49 MCP tools total.

## [1.11.0] — 2026-06-22

### Added
- **13 new deterministic MCP tools** (47 tools total) — read +
  admin surface, all zero-LLM, drafted in parallel via a dynamic workflow and
  integrated serially:
  - **`get_links`** — every typed edge touching a slug, grouped by type +
    direction (outbound/inbound). **`list_link_sources`** — the link-type
    catalogue with live per-type edge counts. (`core/links-read.ts`)
  - **`find_orphans`** (pages with no inbound links), **`find_experts`** (pages
    by graph link-degree), **`find_contradictions`** (pairs joined by a
    `contradicts` edge), **`find_trajectory`** (merged facts+timeline log for an
    entity, oldest-first). (`core/insights.ts`)
  - **`get_recent_salience`** (pages by the deterministic salience score),
    **`find_anomalies`** (structural outliers — `degree_outlier` hubs +
    `stale_salient` cold-but-important pages). (`core/usage-insights.ts`)
  - **`recall`** (read a fact by id), **`forget_fact`** (tombstone a fact;
    audit-preserving soft-delete, migration 043 adds `entity_facts.forgotten_at`/
    `forgotten_reason`). (`core/facts-recall.ts`)
  - **`get_brain_identity`** (version + engine + corpus counts, no slugs/bodies),
    **`purge_deleted_pages`** (hard-delete pages soft-deleted > N hours, the
    manual counterpart to the purge cycle phase), **`query`** (refinement search:
    bias a hybrid search toward a second term via weighted RRF, never widening
    the candidate set). (`core/identity.ts`, `core/pages-purge.ts`,
    `core/search/query-refine.ts`)

  Write/content/slug-surfacing tools (everything except `list_link_sources` +
  `get_brain_identity`, which return only type-names/counts) are internal-only
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`). Each: parameterized SQL, deterministic
  ordering, security-review CLEAN + code-review (one MEDIUM fixed: explicit
  `ESCAPE '\'`). First wave of the full tool-buildout program.

## [1.10.0] — 2026-06-22

### Added
- **`graph-signals` — deterministic graph-aware retrieval stage** (opt-in,
  default OFF). A post-fusion ranking stage that reads the `links` graph and
  applies three conservative multipliers to the top-K of a fused result set:
  - **adjacency hub boost (×1.05)** — a result page linked-to by ≥2 OTHER
    in-set result pages is a hub for this query;
  - **cross-source boost (×1.10)** — stacks on adjacency when a page is linked
    from ≥2 distinct other sources; **dormant on this single-source brain**
    (`pages` carries no per-page source → `cross_source_hits` is always 0), wired
    ahead for a multi-source brain and activates only if it becomes one;
  - **session diversification (×0.95 demote)** — when several results share a
    session prefix (a `chat/` marker or a `YYYY-MM-DD` segment) keep the
    highest-scoring one and demote the rest (MMR-lite). Entity/topic directories
    (`people/`, `docs/`) are never diversified.

  Operates on one representative (highest-scoring) chunk per page slug, so a
  hub's many chunks can't each be boosted. Enabled per-call via
  `SearchOptions.graphSignals` or `MEMEX_GRAPH_SIGNALS=1`; the live ranking model
  is unchanged unless explicitly enabled. Fail-open: any links-query error leaves
  scores untouched. New `core/search/graph-signals.ts` (inline slug-keyed `links`
  SQL — no engine-interface change, self-links excluded), wired into
  `hybridSearch` pre-dedup. Slug-keyed to match memex's `links` model; the
  score-distribution probe + JSONL failure-audit telemetry are intentionally
  omitted. Not an MCP tool, no migration. Found by an exhaustive re-comparison —
  a genuine retrieval-ranking gap earlier passes had missed.

## [1.9.0] — 2026-06-22

### Added
- **Six new MCP tools closing the remaining read-tool gaps** (drafted in
  parallel via a dynamic workflow, integrated + reviewed serially):
  - **`get_chunks`** (read) — return a page's (`slug` → its `page://<slug>`
    mirror) or a document's (`source_path`) content chunks, ordered.
  - **`resolve_slugs`** (read) — fuzzy-resolve a partial/informal string to
    canonical page slugs (exact-slug → score 1, else pg_trgm `similarity()` over
    title + slug, soft-deleted excluded). `core/slug-resolve.ts`.
  - **`add_tag` / `remove_tag` / `get_tags`** — first-class page tags over the
    previously-dormant `tags` table (normalized, idempotent, page-existence
    checked). add/remove are internal-only writes; `get_tags` is a read.
    `core/tags.ts`.
  - **`relational_recall`** (read) — deterministic relational query: parses a
    relationship question, resolves the seed entity, fans out typed edges — no
    LLM. Standalone (does not touch the hybrid search hot path).
    `core/search/relational-recall.ts`.
  Completes the deterministic read-tool gap list (#4–#7). 34 MCP tools total.

## [1.8.0] — 2026-06-22

### Added
- **`traverse_graph` — recursive N-hop graph walk.** memex's `graph_neighbors`
  and `graph_query` were single-hop only; multi-hop questions ("everyone within
  2 hops of Alice") were impossible despite the typed-edge graph already being
  stored. New `traverse_graph` MCP read tool walks the `links` graph from a start
  slug: depth-capped (`max_depth` 1..10, default 3), cycle-safe (a node already
  on the current path is never re-entered), returns each reachable node once at
  its shortest `depth`. `direction` = outbound|inbound|both (both = undirected),
  optional `type` edge filter, `limit` 1..1000. Deterministic; recursive CTE
  without LATERAL for PGLite/Postgres portability.

## [1.7.0] — 2026-06-22

### Added
- **`page_restore` + `page_revert` — page recovery (closes a data-loss
  asymmetry).** memex soft-deletes pages and stores a full body snapshot per
  version "for audit", but had no way to undo either: a soft-deleted page could
  never be undeleted, and version history was read-only with no rollback. Two
  new internal-only MCP write tools fix that:
  - `page_restore` clears `deleted_at` (the inverse of `page_delete`), re-derives
    the page's facts and search mirror (both torn down on delete; links survive),
    and records a restore event in the version chain. No-op if missing or live.
  - `page_revert` rolls a page's body back to a prior `page_versions` snapshot,
    creating a NEW version (history stays append-only). Reuses `page_put` so
    type/title are preserved and links/facts/search refresh. Refuses to revert
    to a delete/restore event version or a missing version.
  Both are in `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` (internal/stdio only).

## [1.6.1] — 2026-06-22

### Added
- **`memex status` now surfaces the job worker's heartbeat (durable-jobs part 2).**
  The snapshot gains a `worker` field — the active worker's `holder`, last
  `heartbeatAt`, `staleMs`, and a `stale` flag (heartbeat older than its TTL =
  the holder crashed or wedged). `null` when no worker has acquired the lock.
  Makes the wedge signal introduced in 1.6.0 observable at a glance; read-only.

## [1.6.0] — 2026-06-22

### Added
- **Single-active-worker guard + heartbeat (durable-jobs hardening, part 1).**
  The job queue's atomic claim already kept two workers off the same row, but
  nothing stopped two worker *processes* (a double-start, a second container, a
  restart overlap) from both polling and both running the maintenance cycle. A
  new singleton `worker_lock` row (migration 042) elects ONE active worker:
  each Worker (when given an `engine`) acquires the lock on its first tick,
  heartbeats it every tick, and releases on stop; instances that can't acquire
  idle and retry. A holder that crashes or wedges stops heartbeating, so its TTL
  (60s) lapses and a survivor steals the lock — the same heartbeat is the wedge
  signal (`readWorkerLock` exposes staleness). Each Worker instance gets a unique
  holder id so even two instances in one process elect a single active one.
  Helpers in `core/jobs/worker-lock.ts`; wired in `serve.ts`. (Deferred to later
  parts: PID-liveness probing, DAG fan-in, budget/rate-lease, inbox, status/
  doctor surfacing of the heartbeat.)

## [1.5.0] — 2026-06-22

### Added
- **Resolved code call-graph (`resolve-symbol-edges` cycle phase).** Code call
  edges, until now stored only as bare-name `code-caller`/`code-callee` entities
  (which alias same-named methods across classes), are now also written as typed
  `code_edges_symbol` rows anchored on the calling symbol's chunk (migration
  041, with a new `chunks.symbol_name_qualified` column). A new
  `resolve-symbol-edges` cycle phase links each edge's callee to its defining
  chunk WITHIN the same document — exactly one match → `resolved_chunk_id`, 2+ →
  `ambiguous` + `candidates[]`, 0 → left for cross-file/external. Incremental
  via a `chunks.edges_backfilled_at` watermark (a document is resolved once,
  then re-resolved only after a re-index). Existing entity-based
  `code-callers`/`code-callees` are unchanged. A two-table-no-promotion design
  (resolution writes into `edge_metadata`).
  (Receiver-type inference — upgrading `obj.method()` to `Class::method` before
  resolution — is a future enhancement; current resolution disambiguates within
  a document by defining-symbol name.)

## [1.4.1] — 2026-06-22

### Added
- **`lint` is now a maintenance-cycle phase, not just a CLI command.** The
  frontmatter-conformance ruleset moved into a shared core (`core/lint.ts`,
  used by both `memex lint` and the cycle) and runs as the first cycle phase
  each pass — a read-only audit that reports how many documents violate the
  ruleset (`title`/`tags`/`created`/`updated`). A non-zero count surfaces as a
  `warn` so conformance debt is visible without failing the cycle; the
  frontmatter-inference phase is what fixes it. Brings memex's cycle to
  12 phases.

## [1.4.0] — 2026-06-22

### Added
- **Document soft-delete, archive, and quarantine with a search visibility
  filter.** Retiring content no longer means a hard `DELETE` — a document can be
  soft-deleted (reversible, hard-purged after a 72h TTL), its source archived
  (with an expiry), or quarantined (a `frontmatter.quarantine` marker, no
  column). A single shared visibility filter (`core/visibility.ts`,
  `buildVisibilityClause`) is spliced into both retrieval arms
  (`search/keyword.ts`, `search/vector.ts`) so hidden documents can never appear
  in search — the exclusion lives in the WHERE clause, not post-processing, and
  cannot be bypassed by a verbosity flag. Migration `040` adds
  `documents.deleted_at`/`archived`/`archived_at`/`archive_expires_at` (additive,
  defaulted — existing rows stay fully visible). `core/destructive-guard.ts`
  provides the programmatic API: impact preview + confirmation gate, soft-delete/
  restore by document, archive/restore by source, and `purgeExpiredDocuments`.
  A new **`purge`** cycle phase hard-deletes documents and pages past the TTL
  (cascading to chunks/embeddings via FK). Quarantine helpers live in
  `core/quarantine.ts` (hide-from-search vs warn-but-show markers).

## [1.3.55] — 2026-06-22

### Fixed
- **Page-mirror cycle phase no longer burns Bedrock during quiet hours.** The
  new `mirror-pages` phase re-embeds stale/missing page mirrors, so it belongs
  with the other Bedrock-heavy phases that are skipped during the quiet-hours
  window — it is now in `COSTLY_PHASES` alongside `embed-stale`/`embed-facts`.
- **Backstop now detects a stale mirror after a title-only edit.**
  `pages.content_hash` is body-only, so a `page_put` that changes only the
  title left the body hash unchanged and the `mirror-pages` backstop could not
  tell the mirror was stale if the write-time embed failed. The mirror now also
  stamps `page_title`, and the reconcile query re-mirrors when either the body
  hash or the title drifts.

## [1.3.54] — 2026-06-21

### Added
- **Pages written via `page_put`/`page_append` are now searchable.** Until now
  the DB-canonical page store and the search index (`documents`/`chunks`/
  `embeddings`) were two disconnected lineages: a page written through the MCP
  write tools landed in `pages` but was invisible to `search`, which only reads
  file-indexed documents. A new bridge (`core/page-index.ts`) mirrors a page's
  body into the search store on every changed write by routing it through the
  same `indexDocument` pipeline the file sweep uses, keyed by a reserved
  `page://<slug>` source_path. The mirror is best-effort — the canonical page
  write is the source of truth and commits first; an embed failure is logged
  and surfaced as `search_indexed:false` rather than failing the write.
  `page_delete` drops the mirror. A new cycle phase, **`mirror-pages`**,
  reconciles the two stores: it re-mirrors any page whose mirror is missing
  (a write-time embed failed) or stale (`page_content_hash` drift) and drops
  orphan mirrors whose page was deleted. Page-derived hits are filtered out of
  PUBLIC search entirely (a page slug/title is author-written PII and `page_put`
  is internal-only); internal callers still receive them. Per-prefix recency
  decay now strips the `page://` scheme so a page decays like its slug twin.

## [1.3.53] — 2026-06-14

### Fixed
- **Wall-of-text notes were silently dropped from the index (oversized-chunk
  embedding 400).** The recursive markdown chunker sub-split an over-long
  section only on blank lines, so a single unbroken paragraph -- e.g. a
  voice-note transcript with no blank lines or newlines -- was emitted as one
  giant chunk. When that chunk exceeded the embedding model's hard cap (Titan
  v2: 8192 tokens / 50000 chars) Bedrock returned `400 Too many input tokens`
  and the indexer aborted the whole document, leaving it entirely unsearchable.
  `splitBySize` now pre-expands any paragraph over `maxChars` into
  sentence-bounded units (then a surrogate-pair-safe hard char-slice as the
  floor), and `chunkMarkdown` applies a final safety clamp (2x `maxChars`) after
  `mergeShort`/`addOverlap` so no chunk handed to the embedder can ever exceed
  the cap. Normal multi-paragraph documents are byte-identical (the new path
  only fires for a paragraph already over `maxChars`); a document that *did*
  contain an oversized paragraph will yield more, smaller chunks on its next
  reindex -- an expected, content-preserving id shift for those docs only.

### Changed
- **README rewritten for newcomers + adoption, with an animated architecture
  diagram.** The landing README now leads with the value wedge (a private,
  self-hosted brain for any MCP agent), shows a concrete "See it work"
  input/output example, adds a tight "how it's different" comparison, and embeds
  an animated SVG hero (`docs/assets/architecture.svg`), an animated terminal
  demo (`docs/assets/demo.svg`) in the "See it work" section, plus a
  request/response Mermaid sequence diagram. A 1280x640 social-preview card
  (`docs/assets/social-preview.png`, from `social-preview.svg`) is also provided
  for the GitHub repo's Open Graph image. Refined through CEO/positioning,
  developer-advocate,
  visual-design, and technical-writer review passes. The GitHub repo description
  and topics were also corrected (the old description still advertised a removed
  Telegram bridge). No code or behavior change.

## [1.3.52] — 2026-06-13

### Added
- **Per-job hard wall-clock timeout / dead-letter (migration 039).** A handler
  that wedges (never returns) held the single worker's one in-flight slot
  forever: `lock_until` + the stall sweep recover a job whose WORKER died, but
  not one whose HANDLER hangs while the worker is alive. A new nullable
  `jobs.timeout_ms` (settable via `Queue.enqueue`, `submitJob`, and the
  `jobs_submit` MCP tool; per-job, validated `> 0`) plus a worker-wide default
  (`MEMEX_JOB_TIMEOUT_MS`, OFF by default so a legitimately-slow Bedrock phase
  isn't killed) make the worker race the handler against a hard cap. On exceed
  the job is DEAD-LETTERED (terminal fail via the new `FailOptions.terminal`, no
  retry) and the worker is freed; JS can't cancel the orphaned handler, but its
  late settlement is swallowed (no unhandledRejection) and the job row is
  protected by `status='running'` write guards. When the timeout outlasts the
  claim lock the worker extends the lock (`Queue.extendLock`) so the stall sweep
  can't requeue the row before the timeout fires. `runJob` is now fully guarded
  so a persistence failure can't crash the worker tick. Reviewed by
  code-reviewer, bug-hunter, and codex (codex caught the unwired submit path, the
  lock-vs-timeout race, and an unhandled-rejection path across two rounds).

## [1.3.51] — 2026-06-13

### Added
- **Sliding-window chunk overlap (opt-in, `MEMEX_CHUNK_OVERLAP`, default 0 =
  OFF).** The markdown chunker split long sections by paragraph with ZERO
  overlap, so a fact straddling a size-split boundary lost its recall bridge.
  With the env (or the `overlapChars` option) set, each size-split continuation
  chunk is prefixed with the tail of the previous chunk -- snapped forward to a
  sentence boundary (else a word boundary), capped at `min(overlapChars,
  maxChars/2)`. The overlap is applied as the LAST chunking step, over the final
  chunk list, and skips any chunk that opens with an H1/H2 heading, so it (a)
  changes chunk CONTENT only, never the chunk COUNT mergeShort produced (so
  positional chunk ids stay stable vs the overlap-off output), and (b) never
  bridges a section boundary. Default 0 keeps output byte-identical; existing
  indexes are unchanged until re-indexed. Reviewed by ai-engineer, code-reviewer,
  and codex (codex caught that applying overlap before mergeShort would have
  shifted the chunk count).

## [1.3.50] — 2026-06-13

### Added
- **Fact confidence decay — the consumer that makes the migration-037 columns
  matter (opt-in, `MEMEX_FACT_DECAY=1`, default OFF).** Migration 037 added
  `kind`/`notability`/`valid_from`/`valid_until` to `entity_facts`, but until now
  nothing read them at recall: facts ordered purely by raw `confidence`. The new
  `core/facts-decay.ts` `effectiveConfidence(fact, now)` is a pure, LLM-free
  function: a fact past its `valid_until` (an explicit "stopped being true"
  marker) scores 0 regardless of kind, and a fact whose `kind` carries a
  half-life decays as `confidence * exp(-age_days / halflife)` — `event` 7d,
  `commitment`/`preference` 90d, `belief`/`fact` 365d — anchored on `valid_from`
  (falling back to `written_at`). A fact with no recognized `kind` does not
  decay, so a legacy row with NULL metadata is unchanged. When the flag is on,
  `listFacts` (and therefore `entity_facts` + `entity_recall`) drops decayed-to-0
  facts and re-ranks the rest by effective confidence; when off, ordering is
  byte-for-byte unchanged. Decay is **internal-ingress only**: on the
  public-bearer path it is forced off so the fixed confidence order is preserved.
  Otherwise a caller could diff the decayed order against `order:"recency"`
  (which disables decay) to infer which hidden fact expired or was demoted by
  `valid_until`/`kind` metadata they cannot see — the same content-oracle class
  as the v1.3.48 semantic-`query` gate. Reviewed by ai-engineer, code-reviewer,
  and codex (codex caught the public-ingress oracle).

### Changed
- **CI: shard the Bun test suite to bound runner memory.** The amd64 gate was
  OOM-killed (exit 137) as the PGLite-heavy suite grew — every PGLite (WASM
  Postgres) instance reserves WASM linear memory that is never returned to the
  OS even after `close()`, so ~100+ files in one `bun test` process eventually
  exceeded the 16 GB runner. `ci.yml` now runs the suite in fixed-size shards
  (20 files), each a fresh process, bounding peak memory as the suite grows. The
  local ship gate still runs the whole suite in one process.
- **CI: drop the dead `pip` Dependabot ecosystem.** The repo has no Python
  dependency manifest (pytest tooling is installed inline), so the `pip`
  ecosystem failed every run with `dependency_file_not_found`. Removed; the
  `github-actions` ecosystem stays.

## [1.3.49] — 2026-06-13

### Added
- **`memex cycle [--phases a,b,c] [--stale-days N]` — run one maintenance cycle
  on demand.** The periodic cycle loop schedules its FIRST tick one interval
  (default 6h) after boot, so a freshly-deployed cycle-driven feature (page
  salience, fact embeddings, link reconcile, …) isn't realized on live data
  until that tick. This one-shot command runs the same `runCycleOnce` once and
  exits, printing the per-phase result envelope as JSON — so an operator can
  realize a backfill immediately after a deploy/import and verify a phase on the
  live dataset. `--phases` limits the run to a comma-separated subset (validated
  against the known phase names), which is the way to run just the cheap new
  phases without the Bedrock-heavy `embed-stale`. Phases are idempotent and use
  atomic writes, so an on-demand run is safe alongside the periodic loop.

## [1.3.48] — 2026-06-13

### Added
- **Fact-text embedding + semantic `entity_recall` (migration 038).** Facts can
  now be recalled by MEANING, not just confidence. Migration 038 adds a nullable
  `vector(1024)` `embedding` column to `entity_facts`; a new `embed-facts`
  maintenance-cycle phase (`core/cycle/embed-facts.ts`) backfills NULL
  embeddings via the same Bedrock Titan v2 path the chunk embeddings use. It is
  FALLS-OPEN: a per-fact Bedrock failure is collected (the phase reports `warn`,
  same envelope as `embed-stale`) and the row is left NULL to retry next cycle,
  never blocking the cycle; the embedder is injectable so tests run offline. The
  `entity_recall` MCP tool gains an optional `query` param: when set, the
  entity's facts are ranked by cosine similarity (`embedding <=> queryvec`,
  embedded facts first via `NULLS LAST`, then the normal confidence tiebreak)
  instead of by confidence — answering "what do I know about Alice's *funding*?"
  rather than just "about Alice". Embedding the query is falls-open too: a
  Bedrock outage silently reverts to the confidence order. No ANN index —
  `entity_recall` filters by `entity_slug` first, so an exact scan of a small
  per-entity row set beats maintaining an index over the whole ledger. The
  `query` param adds no new data to the public-bearer surface (the embedding is
  never returned; facts text stays redacted as before). Reviewed by
  security-engineer, ai-engineer, and codex.

## [1.3.47] — 2026-06-13

### Added
- **Timeline extraction from meetings (opt-in, `MEMEX_MEETING_TIMELINE=1`).** A
  new `extract-timeline` maintenance-cycle phase (`core/timeline-meetings.ts`)
  walks every `meeting` page with a resolvable date and writes append-only
  `timeline_events` (migration 017) for the meeting itself (`Meeting: <title>`)
  and for each resolved attendee (`Attended <title>` on the attendee's page) at
  the meeting date — so a person's timeline shows the meetings they attended.
  Deterministic and LLM-free. Self-contained: attendees come straight from the
  meeting's `attendees` / `attended_by` `compiled_truth` fields, and the meeting
  date is resolved heuristically (explicit `date` field -> a `YYYY-MM-DD` in the
  slug -> the first body date-mention -> skip). Attendee names resolve through
  the slug resolver, accepting only the PRECISE stages
  (exact / alias / exact_tail / prefix) and resolved-only, so a fuzzy near-name
  never attaches a wrong meeting to someone's timeline. Idempotent — events
  dedupe on `(slug, occurred_at, source_chunk_id)` with a stable per-meeting
  source key. Migration-free (reuses `timeline_events` + `addTimelineEvent`).
  DEFAULT OFF: `timeline_events` is append-only (corrections are new events,
  never edits), so a mis-resolved attendee would leave a permanent stray entry;
  the operator enables it after confirming attendee resolution behaves on their
  vault. The phase no-ops when storage isn't threaded into the cycle.

## [1.3.46] — 2026-06-13

### Added
- **Typed-link inference from frontmatter (opt-in, `MEMEX_TYPED_LINKS=1`).** A
  deterministic, LLM-free schema-pack (`core/typed-links.ts`) derives TYPED
  graph edges — `works_at`, `founded`, `attended`, `located_at`, `advises`,
  `invested_in`, `knows` — from an entity page's `compiled_truth` frontmatter
  fields, beyond the generic `wikilink`/`mentions` edges. A fixed
  `FIELD_MAPPINGS` table maps a (page-type, field) pair to a relation + direction
  (e.g. a person's `company: [Acme]` → `works_at` person→company; a meeting's
  `attendees: [Bob]` → `attended` Bob→meeting). Field values resolve to canonical
  slugs through the slug resolver, accepting only the PRECISE stages
  (exact / alias / exact_tail / prefix) — the `trgm` fuzzy stage is excluded so a
  near-name never mints a wrong factual relation — and RESOLVED-ONLY (an
  unresolved value is skipped, never linked to a guess). Edges are stamped
  `link_kind='typed_ner'` + `origin_slug=<declaring page>`; on re-put the page's
  prior typed_ner edges are wiped (origin-scoped) and re-derived, and inserts
  `DO NOTHING` on an existing (source, target, type) so an explicit edge wins.
  Migration-free — it reuses the existing `links` table under a single-origin
  invariant (no triple is declarable by two pages, so origin-scoped cleanup is
  sound). DEFAULT OFF (a wrong inferred relation pollutes the graph — same
  posture as the gazetteer); wired into the `page_put`/`page_append` path only
  when enabled. The company-side `key_people`→`works_at` mapping and the
  typed_ner↔explicit-link coexistence are deferred to the `link_kind`
  UNIQUE-coexistence migration (#145). Reviewed by ai-engineer (trgm-precision
  HIGH → fixed), code-reviewer (field-key + resolve-cap), and codex
  (dual-origin HIGH → single-origin invariant).

## [1.3.45] — 2026-06-13

### Added
- **Fact metadata on the `## Facts` fence + `entity_facts` (migration 037).**
  The fence and the `entity_facts` index gain four optional metadata fields —
  `kind` (event / preference / commitment / belief / fact), `notability`
  (high / medium / low), `valid_from`, `valid_until` (ISO dates). The fence
  PARSER (`core/facts-fence.ts`) was rewritten from fixed-position to
  HEADER-DRIVEN column mapping: a legacy 4-column fence
  (`| # | claim | confidence | source |`) and a wide one parse with the same
  code, columns may be reordered, and new columns don't break old pages. A
  header row is identified by shape (`buildColMap` + `isHeaderShaped` — a data
  row whose claim text is literally "claim" is no longer absorbed as a header).
  Hand-edited cells normalize to NULL when they aren't a recognized enum or a
  strict-ISO calendar date (round-trip guard rejects `2024-02-30`), so the
  `DATE` / `CHECK`-constrained columns never see a poisoned value; the reconcile
  pass (`core/facts-reconcile.ts`) projects the metadata via parameterized
  INSERT. Migration 037 adds the four NULLABLE columns + catalog-guarded CHECK
  constraints mirroring the enums (NULL allowed); there is deliberately no
  `valid_until >= valid_from` CHECK (the hand-editable fence degrades
  gracefully). Recall ranking by notability/validity is a deferred consumer —
  this increment lands the fence→DB metadata pipeline. Reviewed by
  code-reviewer (caught + fixed a claim-named-"claim" header-absorption bug) +
  security-engineer (clean) + codex.

## [1.3.44] — 2026-06-13

### Added
- **Deterministic page salience + `recompute-salience` cycle phase + `memex
  salience` surface (migration 036).** A new `pages.salience` column holds a
  [0..1] importance score recomputed each maintenance cycle from a page's
  high-emotion tags + graph link-degree — LLM-free and deterministic.
  `computeSalience` (`core/salience-score.ts`) sums a tag-emotion boost
  (max 0.5 for any tag in a configurable high-emotion seed set, overridable via
  `MEMEX_SALIENCE_HIGH_TAGS`) and a ln-scaled link-degree boost (max 0.5,
  saturating at degree 20); an isolated page scores 0.0. The
  `recompute-salience` phase (`core/cycle/recompute-salience.ts`) reads tags
  from `compiled_truth.tags` and degree from the `links` table — distinct in+out
  neighbours, gated to EXISTING live pages (a dangling `[[wikilink]]` can't
  inflate a page's score) and aggregated in one CTE pass — then writes only the
  rows whose score changed in a single batched, `Math.fround`-quantised UPDATE
  (idempotent, exact against the float4 column). It runs before `snapshot` in
  the cycle and is cheap enough to run in quiet mode. The new read-only
  `memex salience [--type T] [--days N] [--limit N]` CLI ranks live pages by
  salience — the "what matters" surface. A salience score over tags and
  emotional weight: this brain has no takes, so
  link-degree replaces the takes-derived half. Salience ranks PAGES (graph
  entities) and is deliberately SEPARATE from document hybrid-search ranking
  (which keeps its frontmatter `weight`/`pinned` multiplier) — so the phase does
  NOT touch the document query-cache generation/clock. ai-engineer +
  code-reviewer + codex reviewed (float4-exactness, batched UPDATE, bare-flag
  rejection, tag-trim, dangling-target gate — all applied).

## [1.3.43] — 2026-06-12

### Added
- **Slug-based page-type inference.** `page_put`'s `type` is now OPTIONAL: when
  omitted, `putPage` infers it from the slug's first segment via
  `inferPageType` (`people/…` → person, `companies/…` → company, `meetings/…`
  → meeting, etc.), defaulting to `note` for an unrecognized prefix. An
  explicit type always wins — fully backward-compatible. The vault's folder
  convention now drives typing, which feeds the gazetteer's `person`/`company`
  entity filter (v1.3.41) without the caller having to spell the type out.
  Inference applies only when CREATING a page with no explicit type — an
  omitted-type re-put PRESERVES the page's existing type (it is resolved
  inside the write transaction after the current row is read), so a typed page
  is never silently re-typed. Migration-free. code-reviewer (ship) + codex,
  which caught the re-type-on-update bug (now preserved) and the blank-type
  case (treated as omitted); both handled.

## [1.3.42] — 2026-06-12

### Added
- **Facts-fence reconciliation — the `## Facts` fence becomes the system of
  record (migration 035).** The `## Facts` markdown fence (v1.3.32) was inert.
  Now, on every page write, the page's fence is parsed and projected into the
  `entity_facts` index: the page's fence-owned fact rows are wiped and the
  active (non-struck) rows re-inserted, keyed by two new NULLABLE columns
  (`source_markdown_slug` + `row_num`). This is LLM-FREE and deterministic —
  the fence is canonical structured markdown (a deterministic fact projection,
  minus optional fact embedding).
  The wipe is scoped to `source_markdown_slug = <page>`, so a legacy or
  explicitly-asserted fact (NULL, e.g. via `add_fact`) is invisible to it and
  survives — the column scoping is the empty-fence guard. Reconciliation runs
  on EVERY put (a no-op re-put is the repair path) and re-reads the page's
  current body, guarding on `content_hash` so a concurrent newer write is never
  overwritten with a stale projection. A malformed fence (markers present but
  zero parseable rows) does NOT wipe — a syntax typo can't silently destroy the
  prior facts; only a genuinely absent fence clears them. `page_delete` purges
  the page's fence facts. The `## Facts` fence is also now stripped before
  document chunk-indexing (`indexDocument`) so the table is not double-
  represented as searchable prose. Default-on; `MEMEX_FACTS_FENCE=0` kill
  switch. Reviewed by code-reviewer (no blockers) + codex, which caught a
  reconcile-only-on-change gap (re-put now repairs), the separate-tx
  stale-projection race (now content_hash-guarded), a missing page_delete
  purge, malformed-fence destruction, INTEGER row_num overflow, an unbounded
  insert loop, and the un-stripped fence in the chunk path; all fixed.

## [1.3.41] — 2026-06-12

### Added
- **Gazetteer auto-linking (opt-in, default OFF).** Beyond the explicit
  `[[wikilink]]` syntax, memex can now derive `mentions` graph edges from a
  page body by matching plain-text references to KNOWN entity pages. A
  gazetteer is built from existing `person`/`company` page titles + their
  declared aliases (#3); the body is scanned with maximal-munch (longest phrase
  wins) at unicode word boundaries, and each first mention of an entity becomes
  a `mentions` edge resolved to that page's canonical slug. Built on the slug
  canonicalizer (#1) + aliases (#3) — the matches ARE existing pages, so no
  fuzzy guessing. **DEFAULT OFF** (`MEMEX_GAZETTEER=1` to enable): auto-linking
  prose against page titles is false-positive sensitive, and memex's single flat
  vault has no page-type/source scoping to contain a bad match. Conservatively guarded: only named-entity
  types; a min phrase length, stop-word list, and ambiguity drop (two pages
  claiming one title → no link); a **proper-noun heuristic** (a match whose
  surface form is lowercase in the prose — the common-word sense — is skipped);
  existing `[[wikilink]]` spans masked out; first-mention dedup; the gazetteer
  replaces only its own `link_kind='plain'` edges and never clobbers an
  operator-asserted `mentions` edge (`INSERT … ON CONFLICT DO NOTHING`).
  Reviewed by security-engineer (no Crit/High/Med — regex escaping bounded,
  SQL parameterized, write-path is internal-token-gated, no redaction bypass),
  ai-engineer (drove the proper-noun heuristic + unicode boundaries + the
  maximal-munch test), and codex.

## [1.3.40] — 2026-06-12

### Added
- **Warn-state envelope for cycle phases.** A maintenance-cycle phase result was
  binary `ok: boolean` — a phase that COMPLETED but with non-fatal issues (e.g.
  embed-stale re-embedded most chunks but a few hit a transient Bedrock error,
  or snapshot computed but couldn't persist) reported `ok: true` and the partial
  failure was invisible. `PhaseResult` and `CycleResult` now carry a three-state
  `status: "ok" | "warn" | "fail"` (a three-state envelope) alongside the
  unchanged `ok` (back-compat: `warn` is still
  `ok: true`, and a warn does NOT fail the cycle). A small `deriveStatus(phase,
  detail)` with explicit per-phase rules computes warn (embed-stale + extract
  per-document errors, snapshot non-persist, orphans-purge a zero-chunk/corrupt
  doc); by-design informational signals (reconcile-links `unresolved`,
  orphans-purge `docs_missing_on_disk` routine churn) stay `ok`. The cycle
  runner emits a `warn`-level progress log on a warned phase and the `cycle`
  recipe renders `status=ok|warn|FAIL` per phase. memex's functional `runPhase`
  wrapper already gave uniform error handling, so a base-CLASS
  refactor was intentionally NOT adopted (it would be churn) — only the
  observability kernel landed.

## [1.3.39] — 2026-06-12

### Added
- **Wall-clock budget on a single tree-sitter parse.** The code chunker already
  caps input by byte size, but a small-yet-pathological file can still make the
  WASM parser spin — and `parser.parse()` is synchronous, so a `Promise.race`
  can't interrupt it. `parseWithBudget` now runs every code parse under a
  wall-clock budget via tree-sitter's `progressCallback` (the in-process cancel
  lever: returning truthy from the periodically-invoked callback aborts the
  parse to null). On overrun `parseWithBudget` resets the parser and throws
  `ParseTimeoutError`, which propagates out of `chunkCode`/`extractCodeEntities`
  *before* the reindex write — so the per-file `try/catch` in the code sweep
  skips that one file and PRESERVES its prior chunks/edges, rather than hanging
  the sweep or silently overwriting a reindex with a half-parsed symbol's edges.
  Default 5s, override with `MEMEX_PARSE_TIMEOUT_MS` (0 disables). Used the
  progress callback rather than `setTimeoutMicros` because the latter's i64
  argument mis-marshals under Bun's WASM bridge. Reviewed by code-reviewer +
  codex; codex reproduced a parser-poisoning bug (a cancelled tree-sitter parser
  is left resumable, so the next parse on the cached instance returned a
  spurious `hasError` — fixed by `parser.reset()` on cancel) and flagged the
  partial-overwrite and the sub-1ms-floors-to-disabled edges; all fixed. The
  budget is cooperative, not hard preemption (the callback fires ~every 100
  parser ops, so a trivially-short parse or a pure-lexer hang isn't interrupted)
  — documented in the helper.

## [1.3.38] — 2026-06-12

### Added
- **Declared page aliases (migration 034).** A page can now name its
  alternate identities in `compiled_truth.aliases` (e.g. a `people/bob` page
  with `aliases: ["Robert", "Bobby"]`), and a `[[Robert]]` wikilink resolves
  to `people/bob`. A new `page_aliases` index table is kept in lockstep with
  every `putPage` (the alias set is replaced inside the same write
  transaction; a hard page delete cascades, a soft delete is filtered out by
  the resolver and restored automatically). The wikilink slug canonicalizer
  gains an authoritative **alias** stage — ranked just below an exact slug
  match and above the fuzzy tail/prefix/trigram cascade — so a declared alias
  always wins over a fuzzy guess. Aliases are normalized as free-text phrases
  (NFKC + lowercase + whitespace-collapse, length- and count-capped), not
  slugified. Collision-safe: when two pages claim the same alias the resolver
  returns no match and falls through to the cascade rather than arbitrating
  (same safe-by-default posture as the canonicalizer). Cross-page edges
  re-resolve on their own next wikilink sync (eventual consistency, the same
  model as the slug canonicalizer); the migration needs no backfill since
  declared aliases are a new convention. Reviewed by code-reviewer + codex —
  codex caught a self-exclusion-before-collision-detection bug (a source-vs-
  other alias clash now correctly falls through), a catch-all that could mask
  a real DB error into a wrong-slug fuzzy match (now only the pre-migration
  table-missing case is swallowed), key truncation that could collapse two
  long aliases (over-limit aliases are dropped, not cut), an unsanitized
  NUL/surrogate reaching the `page_aliases` TEXT insert (now derived from the
  same well-formed value as the jsonb payload), and a missing `slug` index for
  the per-page replace; all fixed.

## [1.3.37] — 2026-06-12

### Added
- **Entity-slug canonicalization for wikilinks (migration 033).** A
  `[[wikilink]]` mention is now resolved to an EXISTING canonical page slug
  before its graph edge is written, instead of always minting a slugified
  target — so `[[Alice Smith]]` lands on `people/alice-smith` rather than a
  dangling `alice-smith`. A new deterministic, LLM-free resolver
  (`core/slug-canonicalize.ts`) runs a confidence-ordered cascade: (1) exact
  slug match; (2) unique exact-tail match on a namespaced slug's basename
  (`[[Acme]]` → `companies/acme`); (3) unique prefix expansion
  (`[[alice]]` → `people/alice-smith`); (4) a pg_trgm `similarity()` fuzzy
  match on title + slug basename, gated by both a threshold AND a margin over
  the runner-up; (5) the legacy slugify floor (always yields a slug, so an
  edge is still created). Resolved edges are stamped
  `resolution_type = 'qualified'`, the slugify fallback `'unqualified'`
  (migration-029 columns), and `link_kind = 'plain'`. Migration 033 enables
  the `pg_trgm` extension (loaded as a PGLite contrib for tests); stage 4
  uses `similarity()` with an explicit threshold, so no GIN trigram index is
  required at this vault's scale. **Safe-by-default** (ai-engineer +
  code-reviewer + codex review): because memex is a single flat vault with no
  source-scoping or dir/page-type hints, the fuzzy stage runs LAST, the
  tail/prefix stages resolve ONLY when the match is unique (genuine ambiguity
  falls through to the slugify floor rather than being silently arbitrated),
  the fuzzy threshold defaults to a conservative `0.7` with a runner-up
  margin, and connection_count tie-breaking was deliberately NOT adopted (a
  rich-get-richer bias whose wrong `qualified` edge would compound across
  future resolutions). Canonicalization is default-on with a
  `MEMEX_WIKILINK_CANONICALIZE=0` kill switch and a `MEMEX_WIKILINK_TRGM`
  threshold override. The boost is dormant on existing live edges until a page
  is re-synced; a future `[[mention]]` rewrite lights it up. codex caught a
  resolver-contract self-resolution leak (stage 1 now skips a self-match) and
  the unnamespaced-prefix sprawl (tail/prefix restricted to namespaced slugs);
  both fixed.

## [1.3.36] — 2026-06-12

### Added
- **Code doc-comment extraction + weighted FTS (migration 032).** The code
  chunker now extracts a symbol's documentation comment — the JSDoc/`//` block
  immediately above a JS/TS function/class/method (climbing past an `export`
  wrapper, capturing only a contiguous run of comments adjacent to the symbol so
  a file-level license header is not mistaken for a doc) or the leading
  docstring of a Python `def`/`class`. It is stored in a new `chunks.doc_comment`
  column and folded into the chunk FTS at weight `A` (migration 032 extends the
  migration-030 `search_vector` trigger), so a query that uses a function's DOC
  vocabulary — not its identifier — ranks that function's chunk above chunks
  that only mention the term incidentally in prose. NULL-safe and markdown-safe:
  markdown chunks and symbols without a doc comment leave `doc_comment` NULL, so
  their weight-`A` segment is empty and their matched set + relative order (and
  thus the rank-based RRF contribution) are unchanged — only code chunks with a
  doc comment gain the differential boost. The extraction is length-capped
  (2000 chars) so a long doc can't dominate ranking. Config stays `simple` for
  tokenization parity with the existing keyword read path. This completes the
  forward note left in migration 030 ("when doc_comment lands, fold it into the
  'A' segment"). Reviewed by ai-engineer + code-reviewer + codex.

## [1.3.35] — 2026-06-12

### Added
- **Two-layer query-cache invalidation (migration 031).** The exact-match query
  cache previously gated only on the global `document_generation_clock`: any
  document write bumped the clock and invalidated the WHOLE cache, even queries
  that never touched the changed doc. This adds a second, finer layer. A new
  per-document `documents.generation` counter is bumped (folded into the
  indexer's UPSERT) only for the document actually re-written, and each cache
  row records a `query_cache.doc_generations` snapshot — `{document_id:
  generation}` for every document its result chunks belong to. On read, Layer 1
  (the clock bookmark) serves a row that is fresh corpus-wide; when the clock
  has advanced, Layer 2 still serves the row iff every referenced document
  still exists with an unchanged generation. A write to an UNRELATED document
  no longer evicts the query. An empty snapshot (empty-result queries and
  pre-migration rows) cannot disprove staleness, so it relies on Layer 1
  exclusively. A single shared SQL freshness clause drives read, prune, and
  stats so all three agree on "servable". Every writer that changes a
  ranking-relevant field of a document now bumps that document's generation +
  the global clock so Layer 2 stays sound: `indexer-tx` (content/frontmatter),
  the `frontmatter-inference` cycle phase (salience), and
  `backfillDocumentSources` (source-boost + scope). `memex embed` re-embeds
  chunks WITHOUT bumping any generation, so it clears the cache outright rather
  than just bumping the clock. `putCachedQuery` persists a row only when the
  live clock still equals the clock the caller read before ranking — a
  mid-search write therefore never produces a servable-but-stale cache row.
  Accepted tradeoff (inherent to the two-layer gate): a document
  NOT in the cached result set that becomes relevant does not invalidate the
  row until one of its referenced docs changes or it is pruned — a bounded
  staleness window traded for a higher hit rate. Reviewed by ai-engineer +
  code-reviewer + codex (codex caught the mid-search race and the two
  non-indexer writers; ai-engineer independently flagged the same writers).

## [1.3.34] — 2026-06-12

### Fixed
- **Well-form lone UTF-16 surrogates + NUL before a `::jsonb` cast.** A document
  whose frontmatter carried an unpaired UTF-16 surrogate (e.g. a truncated emoji
  or mis-encoded source) or a NUL would make Postgres reject the `::jsonb` cast
  and abort the whole index transaction — a single bad file could wedge
  indexing. A new `core/well-form.ts` sanitizer (`wellFormForJsonb` /
  `wellFormJsonbValue`) replaces lone surrogates with U+FFFD (via
  `String.prototype.toWellFormed`) and drops NUL, deep-walking object keys and
  values; valid surrogate pairs (real emoji) are preserved. Applied at every
  frontmatter writer (`indexer-tx`, the `frontmatter-inference` cycle phase) and
  the page `compiled_truth` jsonb write, generalized to cover the NUL case.
  Reviewed by code-reviewer.

## [1.3.33] — 2026-06-12

### Added
- **`memex search modes` — read-only ranking-config view.** A new diagnostic
  subcommand that prints the ACTIVE post-fusion ranking knobs (title-phrase
  boost, per-prefix recency decay, near-dup Jaccard threshold, opt-in rerank,
  query cache) with each one's resolved value, default, and `MEMEX_*` env
  override, plus the intent taxonomy and the cheap-heuristic rules and the
  query-cache ranking signature. It resolves the SAME getters the live search
  path uses (so it can't drift), runs no search and touches no storage, and
  doubles as a config validator — a malformed `MEMEX_*` value fails loudly here
  before it can break a real search. `commands/search-modes.ts`.

## [1.3.32] — 2026-06-12

### Added
- **`## Facts` fence parser/renderer (LLM-free).** A new pure markdown
  <-> structured-rows boundary (`core/facts-fence.ts` + the generic
  `core/fence-shared.ts` table-row primitives): `parseFactsFence` /
  `renderFactsFence` / `stripFactsFence` round-trip a `## Facts` fenced table
  (`| # | claim | confidence | source |`, a `~~struck~~` claim marks the fact
  inactive) on an entity's page. This makes the page markdown the
  system-of-record for facts so they stop being DB-only and reset-fragile; the
  `entity_facts` table (migration 018) becomes a derived index. No DB, no LLM,
  no I/O — and INERT until a future `extract_facts` cycle phase consumes it.
  Projected onto memex's simpler fact model (no
  kind/visibility/notability/typed-claim columns). The pipe/backslash escape
  (`escapeFenceCell`) and the
  cell split (`parseRowCells`, a character scanner) are a true round-trip
  inverse. Reviewed by code-reviewer (escape-inverse hardened for trailing
  backslashes).

## [1.3.31] — 2026-06-12

### Changed
- **Contract-derived param validation at the MCP boundary.** Every tool call is
  now checked against the `OPERATIONS` contract before dispatch: a present param
  must match its declared type, enum membership, and numeric min/max, else the
  call returns a structured `invalid_params` `OperationError`. This enforces, in
  one place, the constraints the advertised `inputSchema` already declares but
  individual handlers checked unevenly. Safe by construction: the MCP client
  derives its params from the same contract, so a well-formed call can never be
  rejected (a per-operation parity test pins this) — only a malformed one, which
  a handler would have rejected anyway. Required-presence is still owned by the
  handlers (their messages are richer); unknown/undeclared params are not
  rejected. One real tightening: an `object`-typed param now rejects a JSON
  ARRAY (arrays were previously accepted by the `typeof === "object"` handler
  guards), matching the schema's `type:"object"` for the loose write-tool fields
  (`compiled_truth` / `payload` / `extra`). Reviewed by security-engineer (ship
  — no new oracle, no injection, no DoS) + code-reviewer. `validateParams` in
  `mcp/operations.ts`.

## [1.3.30] — 2026-06-11

### Added
- **Per-family retrieval eval gate (test-only).** A new hermetic gate groups
  the retrieval qrels into named query FAMILIES — `body_term` (a control),
  `alias_synonym` (reachable only through the embedder's synonym bridge), and
  `multi_chunk_dilution` (the relevant phrase lives in one chunk of a 3-chunk
  document, competing with a partial-match distractor) — and asserts each
  family's Hit@3 independently. Aggregate metrics can stay green while a single
  retrieval MODE silently regresses; per-family gating catches that. Includes a
  differential probe proving the `alias_synonym` family is a true vector-arm
  sentinel (the keyword arm alone provably cannot satisfy it), so a dead vector
  arm fails the gate. Complements the aggregate hybrid gate; no production code
  changes. `tests/retrieval_quality_families.test.ts`.

## [1.3.29] — 2026-06-11

### Added
- **Structured `OperationError` envelope for known MCP failures.** A known,
  validated failure (bad params, unknown tool) now returns a machine-readable
  envelope — `{error: <code>, message, suggestion?, docs?}` — instead of a bare
  string, so the calling agent can branch on a stable code and act on the
  recovery hint. On PUBLIC ingress the free-text `message` is withheld (the
  only field that could carry runtime detail); the constrained `error` code and
  author-static `suggestion`/`docs` pass through, a net improvement over the
  previous single generic public string. Raw exceptions stay on the
  fully-redacted path unchanged. The `search` param validations (`q`, `k`,
  `token_budget`) and the unknown-tool path now throw it. Reviewed by
  security-engineer (ship — message-drop is a structural control, no
  enumeration/XSS/prototype-pollution) + code-reviewer. A structured
  `OperationError`, with memex's public message-redaction contract
  added. New `core/operation-error.ts`.

## [1.3.28] — 2026-06-11

### Changed
- **Rate limiter: LRU eviction + TTL instead of fail-closed at capacity.** The
  per-IP token-bucket limiter used to refuse all new keys once its `maxKeys`
  cap (10 000) filled — so a flood of distinct source IPs could lock out every
  new legitimate caller (a trivial denial of service). It now evicts the
  least-recently-used bucket to admit a new key, so a new caller is always
  admitted while memory stays bounded; per-key throttling is unchanged, and an
  active caller is self-healing (each request re-marks it most-recently-used,
  out of eviction range). A TTL sweep (`ttlMs`, default 15 min) now drops
  buckets untouched past the window alongside the existing idle
  (fully-refilled) sweep. Reviewed by security-engineer (ship, net improvement
  over fail-closed) + code-reviewer.

## [1.3.27] — 2026-06-11

### Added
- **`memex embed [--limit N] [--dry-run]` — embedding backfill.** Re-embeds
  non-code chunks that have no row in the `embeddings` table — the operator
  remedy when `memex status` / `memex doctor` (source-health) report
  `embed_coverage` below 100%. Such chunks (indexed before embedding was wired,
  left behind by a dropped embedding-dimension migration, or skipped by a
  transient Bedrock failure mid-index) are invisible to the vector arm of
  hybrid search — only the keyword arm can reach them — so a silent retrieval
  hole opens. The command walks the missing chunks and computes their Titan
  vectors. Code chunks are graph-only by design and stay excluded (the
  candidate filter matches source-health's `embeddable` definition). Idempotent
  (`ON CONFLICT DO NOTHING` + an `IS NULL` anti-join, so a re-run only embeds
  what is still missing); per-chunk failures are counted, not fatal; `--dry-run`
  counts without any Bedrock call; `--limit N` caps cost per run. A successful
  backfill bumps the document-generation clock so the exact-match query cache
  is invalidated — a ranking cached before the repair no longer bypasses the
  freshly-embedded chunks. The recorded model id is sourced from the same
  constant `embedText` defaults to, so a backfilled row never drifts from the
  embedder that produced it.

## [1.3.26] — 2026-06-11

### Added
- **Weighted chunk FTS (`search_vector`).** The keyword search arm now ranks
  against a new weighted `chunks.search_vector` (migration 030) instead of the
  flat `ts` column. A chunk's symbol identity — `symbol_name` plus its
  `parent_symbol_path` scope, populated for code chunks by migrations 027/028 —
  sits at FTS weight `A`, above the body text at weight `B`, so a query that
  names a function/class (or its enclosing scope) ranks that symbol's chunk
  above chunks that only mention the term in prose. Markdown chunks have no
  symbol columns, so their lexemes all fall to weight `B` — a uniform shift
  from the old default `D` that scales `ts_rank_cd` identically and leaves
  their relative order (and the rank-based RRF contribution) unchanged; only
  symbol-bearing chunks gain the differential boost. The tokenizer config is
  unchanged (`simple`), so the matched set for markdown chunks is identical to
  the old `ts`. For code chunks it is also a small recall gain — a query naming
  an enclosing scope now reaches a nested chunk whose body omits it. Computed by a `BEFORE INSERT OR UPDATE` trigger (the
  `array_to_string` fold of the scope array is not immutable, so a generated
  column was not possible); existing rows are backfilled in the migration.
  A weighted chunk FTS — the `doc_comment` /
  `symbol_name_qualified` weight-`A` inputs do not exist in memex yet and fold
  in when those columns land.

## [1.3.25] — 2026-06-11

### Added
- **Near-duplicate dedup (Jaccard text similarity).** After the existing
  per-document dedup, a new stage drops a hit whose text is too similar
  (word-set Jaccard > `MEMEX_NEARDUP_JACCARD`, default `0.85`) to a
  higher-ranked already-kept hit. Per-doc dedup keeps one chunk per document,
  but two DIFFERENT documents can still carry near-identical text (a note and
  its `.bak` copy); this collapses them to the higher-ranked twin. Greedy and
  rank-order-preserving; an empty/contentless hit is never dropped. Skipped for
  `exact` intent ("show me everything") and disabled entirely when the threshold
  is set `> 1.0`. This is a Layer-2 text-similarity dedup; a type-diversity
  layer (needs a page-type taxonomy memex lacks) and a compiled-truth guarantee
  (an LLM-cycle artifact memex lacks) are intentionally out of scope. The
  threshold is folded into the query-cache ranking signature, so
  changing it re-keys the cache. New `dedupByTextSimilarity` in
  `core/search/dedup.ts`.

## [1.3.24] — 2026-06-11

### Fixed
- **Deterministic tie-break in the keyword search arm.** `keywordSearch` ordered
  by `ts_rank_cd` alone, so equal-rank ties — common when several chunks share
  the query terms — resolved in the storage engine's unspecified order, a latent
  source of green-local / red-Linux divergence (the same flakiness class as the
  mock-leak incident). Both keyword queries now append `, id COLLATE "C" ASC`: a
  byte-order secondary key that is identical on PGLite and live RDS regardless of
  their default collations. `ts_rank_cd` is a computed expression (always sorted,
  never index-backed), so the tie-break is free — no plan change, no ranking
  change, only the previously-unspecified tie order is now stable. The vector arm
  is deliberately left untouched: a secondary key on a pgvector `<=>` ORDER BY
  can defeat the HNSW index, and exact cosine ties on real embeddings are
  vanishingly rare.

## [1.3.23] — 2026-06-11

### Added
- **Hermetic retrieval-quality gate over the full hybrid path.** The CI
  correctness gate now covers vector + keyword + RRF fusion (previously only the
  keyword arm), with NO Bedrock: a deterministic basis-vector embedder
  (`tests/det-embed.ts` — FNV-1a token hash → 1024-dim L2-normalized
  bag-of-words) seeds chunk vectors and is injected into the query side through
  a new `SearchOptions.embedQuery` seam, while intent override + `noExpansion` +
  `noCache` strip the remaining LLM calls. A change that regresses hybrid
  ranking below the floors (hit-rate, MRR, nDCG — env-overridable) now turns the
  suite red. The `embedQuery` option defaults to the real Titan embedder, so it
  is a test-only injection with zero production behavior change.

## [1.3.22] — 2026-06-11

### Added
- **Adaptive return-sizing (opt-in, default OFF).** A new per-call
  `adaptiveReturn` search option trims the returned hit list to an
  intent-driven cap instead of always returning the full top-K: single-answer
  intents (`factual` / `exact`) get a tight cap (default 2), broad intents
  (`topic` / `howto` / `personal`) get a recall-preserving cap (default 6), with
  an at-least-`minKeep` failsafe so a caller never gets a silent blank when
  candidates exist. `true` enables the defaults; a partial object overrides the
  caps. Keyed to memex's own
  `Intent` values, and — because memex's hybrid score is RRF-fused (no
  trustworthy cliff) — the mechanism is a cap, not a score-cut. Applied as the
  FINAL view, after the query cache stores the full ranked set and after the
  eval-capture hook records it, so it never poisons the cache and never shrinks
  the eval window. Default OFF → identical results for every existing caller.
  New `core/search/return-policy.ts`.

## [1.3.21] — 2026-06-11

### Security
- **Query-expansion prompt-injection guards.** The query-expansion step asks
  Nova Lite (Bedrock Converse) for paraphrase variants of the user query. Both
  sides of that call are now sanitized: `sanitizeQueryForPrompt` neutralizes the
  query before it reaches the model (caps length, strips code fences + HTML-ish
  tags, drops a leading instruction-override preamble such as
  `ignore:`/`system:`, collapses whitespace, and warns — without echoing the
  content — when it changes anything), and `sanitizeExpansionOutput` validates
  the untrusted model output (strips control characters, drops empties, caps
  length, dedupes, caps the count). Defense-in-depth: the query already travels
  in the user turn and the variants only become additional keyword (tsquery)
  search passes — never code, never re-fed to an LLM — so this hardens the trust
  boundary without changing results for a normal query. New exports in
  `core/search/expansion.ts`.

## [1.3.20] — 2026-06-10

### Added
- **Title-phrase boost.** When the query is a contiguous phrase in a page's
  title (a "name of the thing" query), that hit's score is nudged up by a
  scale-invariant factor (`MEMEX_TITLE_BOOST`, default `1.25`, ON) so the page
  surfaces over a weak body chunk that merely mentions the terms. It is a
  title-superstring matcher: a multiplier is scale-invariant, so it applies
  cleanly onto memex's RRF score (where cosine floors would not). Matching is deterministic and zero-I/O — a contiguous token-run inside
  the title (token-boundary, not substring) gated by ≥2 non-stopword content
  tokens, or an exact full-title match (covers single-word chosen names). Set
  `MEMEX_TITLE_BOOST` ≤ `1.0` to disable; a fractional value warns (the boost
  only ever multiplies up). New `core/search/title-match.ts`.

### Changed
- **`evidence` now recognizes `exact_title_match`, and `exists` is tightened.**
  A title-phrase hit is stamped `exact_title_match` (→ `create_safety: exists`)
  at any rank — the strongest, arm-independent signal. The both-arms→
  `high_vector_match`→`exists` path is now gated on the hit landing in the top
  rank band (the first 3 results) rather than firing for any both-arms hit:
  the wide retrieval fanout means co-membership in both arms is not the same as
  a high rank, so a common token could previously land an irrelevant chunk in
  both arms and read a false `exists`. A both-arms hit outside the head now
  reads `keyword_exact` (`probable`) instead. This is more conservative (the
  worse error — a false `exists` that hides a real page and risks silent data
  loss — is removed) while the rank band still protects a legitimate page that
  sits at rank 1–2. Cache-hit results gain `exact_title_match` too (it keys off
  the hit title, computable without arm membership); everything else keeps the
  conservative default. Search ordering changes only for title-phrase hits.
- **Query-cache key folds in a ranking signature.** The exact-match query cache
  stores an ordered result list; its key now includes a `RANKING_VERSION` tag,
  the live `MEMEX_TITLE_BOOST` (read through the same memoized getter the
  ranking uses, so the key and the order can't diverge), and the raw
  `MEMEX_RECENCY_DECAY` env — so deploying a ranking change or changing either
  env re-keys the cache immediately instead of serving a pre-change ordering
  until the document clock next advances. (Time-based recency drift within a
  cache lifetime remains by design — the cache is gated on the document
  generation clock, so any write refreshes it.)

## [1.3.19] — 2026-06-10

### Added
- **Search hits carry `evidence` + `create_safety`.** Every search result is
  now stamped with WHY it matched, not just a score: `evidence` names the
  strongest signal that surfaced the chunk (`high_vector_match` when both the
  vector AND keyword arms found it, `keyword_exact` for a keyword-only match,
  `weak_semantic` otherwise) and `create_safety` (`exists` / `probable` /
  `unknown`) is the derived "is this page already here?" hint an agent can key
  its don't-duplicate decision off instead of a raw score. Mapped to memex's
  score model: memex's hybrid score is RRF-fused (rank-based),
  so the signal is which retrieval ARM(s) surfaced the chunk, not a calibrated
  0..1 cosine floor — conservative by design, so a soft signal never reads as `exists`.
  Pure-additive: it does not reorder results. The two labels are constrained
  enums (no note content), so they surface on both internal and public ingress.
  Cache-hit results (which hydrate stored chunk ids without re-running
  retrieval) get the conservative default `weak_semantic` / `unknown`, so the
  contract is always present and never a false `exists`. New
  `core/search/evidence.ts`.

## [1.3.18] — 2026-06-10

### Changed
- **MCP tool schemas are now generated from one contract.** The 25 inline
  JSON-Schema `inputSchema` blocks (which had to be hand-kept consistent across
  the HTTP and stdio surfaces) are replaced by a single `OPERATIONS` contract
  (`mcp/operations.ts`): each tool declares its params as typed `ParamDef`s and
  the schema is derived by `operationInputSchema` / `paramDefToSchema`. The
  defs MCP clients receive are byte-for-byte identical — a snapshot-equivalence
  test pins the generated output against the original hand-written defs, so
  this is a proven zero-behavior refactor. It removes the drift risk and gives
  a typed surface to build derived param validation on next.

## [1.3.17] — 2026-06-10

### Added
- **Opt-in JSONL audit trail for MCP tool calls.** When `MEMEX_AUDIT_DIR` is
  set, each tool call appends one redacted JSON line to an ISO-week-rotated
  file (`<dir>/audit-<YYYY-Www>.jsonl`) — the same redacted summary the console
  logger uses (tool name, ingress, ok, declared param key names + counts +
  bucketed size; never a value). The two sinks are independent (`MEMEX_AUDIT_DIR`
  for the file, `MEMEX_LOG_REQUESTS` for stdout), both off by default. The
  writer is best-effort: an unwritable dir or full disk is swallowed so the
  audit trail can never break the request it records. New
  `core/audit-week-file.ts`.

## [1.3.16] — 2026-06-10

### Added
- **`memex status` — one-shot operational snapshot.** Bundles the three signals
  an operator usually wants at a glance into a single JSON object: index counts
  (`stats`), data/ingest health (embedding coverage, staleness lag, job queue,
  failed jobs — from `brainHealthMetrics`), and the query-cache state
  (total / fresh / stale vs the clock). Read-only and judgement-free — unlike
  `doctor` it sets no exit code; it just reports the numbers, reusing the same
  primitives `doctor` and `cache` use. New `commands/status.ts`.

## [1.3.15] — 2026-06-10

### Fixed
- **CLI commands that signal failure via `process.exitCode` now actually exit
  non-zero.** The entrypoint called `process.exit(code)` with the cli case's
  return value, and an explicit `0` argument OVERRIDES any `process.exitCode` a
  command set — so `memex doctor` (and `lint` / `integrity` / `eval` /
  `check-resolvable` / `sources` / …, which print a report and set
  `process.exitCode = 1` while returning 0) exited 0 even on failure, silently
  breaking their documented cron/CI "exits 1 on failure" contract. A new
  `resolveExitCode` honours an explicit non-zero return first, then falls
  through to `process.exitCode` — repairing every affected command at once.

## [1.3.14] — 2026-06-10

### Added
- **`memex call <tool> [--args '<json>']` — invoke any MCP tool from the
  shell.** A convenience for operators and smoke tests: exercise a tool exactly
  as the MCP transport would, without standing up an MCP client. Dispatch runs
  on the INTERNAL ingress (same trust as `reindex` / `apply-migrations`), so
  write tools and full unredacted read output are available — the public-bearer
  surface is a separate path and is unaffected. `--args` must be a JSON object;
  the exit code is 1 when the tool returns an error result, so it composes in
  scripts. New `commands/call.ts`.

## [1.3.13] — 2026-06-10

### Added
- **Redacted MCP request logging (opt-in).** `summarizeMcpParams` turns a tool
  call's params into a log-safe summary — which *declared* parameter names were
  present (from the tool's schema), how many *unknown* keys came along, and a
  coarse byte size — and never a single value (a search `q`, a `page_put` body,
  a slug, a path all stay out of the logs). Size is bucketed UP to the nearest
  1 KB so the exact length can't be binary-searched via repeated probes (a
  content-length side channel). A new `logToolCall` hook in the MCP HTTP
  transport writes one such redacted line per tool call **only when
  `MEMEX_LOG_REQUESTS=1`** — off by default, so there is no behavior change
  until an operator opts in. New `mcp/param-redaction.ts`.

## [1.3.12] — 2026-06-10

### Added
- **`memex cache` CLI — operator surface for the query cache.** `cache stats`
  reports the query-cache row counts split fresh-vs-stale against the current
  document-generation clock (plus distinct intents and created-at span);
  `cache prune` drops only the stale rows (those a doc write has already
  invalidated — never served, just taking space); `cache clear` drops every
  row. Neither prune nor clear can change search correctness — a miss simply
  recomputes from the live tables. New `core/search/query-cache.ts`
  `cacheStats` / `pruneCache` / `clearCache` + `commands/cache.ts`. Read-only
  for `stats`; no migration.

## [1.3.11] — 2026-06-10

### Added
- **Brain-level health metrics surfaced by `memex doctor`.** A new
  `source-health` check reports embedding coverage (over the chunks that
  *should* carry a vector — code chunks are graph-only by design and excluded),
  ingest staleness `lag_seconds`, pending `queue_depth`, and `failed_jobs_24h`.
  It is informational by design: only a job that *failed* in the last 24h gates
  the check (an unambiguous "something broke"); coverage / lag / queue are
  reported in the detail rather than declaring the brain unhealthy, because a
  brain can legitimately run with partial coverage (graph-only sources, a
  pending backfill). New `core/source-health.ts` (`brainHealthMetrics`),
  categorized `brain`. Read-only aggregation, no Bedrock, no migration.

## [1.3.10] — 2026-06-10

### Added
- **`memex doctor` categorizes checks + ranks failures root-cause-first.**
  Each check now carries a `category` (`brain` = data integrity, `ops` =
  infra/setup, `meta` = the doctor itself; the agent-only `skill` category is
  intentionally absent — memex is brain-only), and the report gains a
  `summary` with a per-category ok/fail rollup and a `ranked_failures` list
  ordered root-cause-first. Ordering carries an explicit honesty contract: a
  failure is only annotated `downstream_of` a root when that root is *also*
  failing — co-failure is never treated as proof of causation. A drift guard
  (`tests/doctor_categories.test.ts` + the doctor end-to-end test) fails CI if
  a future check ships without a category. No behavior change to exit codes or
  the existing `checks` array. New `core/doctor-categories.ts` +
  `core/doctor-cause-rank.ts`.

## [1.3.9] — 2026-06-10

### Changed
- **Link-provenance columns on `links` made usable (migration 029).**
  Migration 024 (P0) had already laid five provenance columns on `links` as
  bare nullable TEXT stubs (`context`, `link_kind`, `origin_page_id`,
  `origin_field`, `resolution_type`) but nothing populated or constrained
  them. Migration 029 turns the stubs into a usable contract so a future
  LLM-free enrichment pass (gazetteer auto-link, typed-NER) and a reconcile
  pass can rely on them: `context` becomes `NOT NULL DEFAULT ''` (a missing
  window is `''`, never NULL — existing NULLs backfilled); `link_kind` gets a
  CHECK (`plain` | `typed_ner`); `resolution_type` gets a CHECK (`qualified` |
  `unqualified`); and the mis-named `origin_page_id` (024 used an integer-style
  name, but this brain is slug-keyed) is **renamed to
  `origin_slug`**, a soft reference consistent with `source_slug` /
  `target_slug`. `addLink` now accepts + validates these and keeps them
  **sticky** on an idempotent re-add (a bare `link` re-call never wipes
  enrichment-written provenance). No public/redaction surface change: the
  `graph_neighbors` / `graph_query` projections do not select these columns
  and the public allowlist excludes them — `context` (free-text note content)
  can never reach a public-bearer caller. The explicit `link` MCP tool
  contract is unchanged. Every migration step is guarded (idempotent).
  Unblocks link reconciliation + NER.

## [1.3.8] — 2026-06-10

### Changed
- **`chunks.parent_symbol_path` widened scalar TEXT → `TEXT[]` — nested code
  symbols keep their full ancestor chain.** The code chunker (migration 027,
  v1.3.4) recorded only the innermost enclosing symbol, so a method inside
  `outer() { class Inner { … } }` stored `"Inner"` and lost `"outer"`. The
  chunker now emits the whole scope chain outermost-first
  (`["outer","Inner"]`); the indexer persists it as a `TEXT[]`, and
  migration 028 casts existing scalar values to 1-element arrays in place
  (no data loss — the innermost parent is preserved; deeper chains fill in
  on the next reindex of each file). Markdown chunks stay NULL. The column
  is not yet surfaced in search output, so there is no public/redaction
  surface change. Substrate for later symbol-edge / qualified-name
  resolution.

### Added
- **Hermetic retrieval-quality CI gate (keyword arm).** A deterministic
  test seeds a tiny corpus, runs the keyword/FTS search over a set of query
  families, scores it with the IR-metric primitives (recall@k / MRR /
  nDCG@k), and asserts floor thresholds — so a change that regresses keyword
  ranking turns the suite red. No Bedrock, no embeddings. (The vector/hybrid
  arm needs a deterministic query-embedder injection point — tracked as a
  follow-up.)
- **`scripts/mcp-refresh.sh` — one-shot client bearer refresh.** Pulls the
  current public bearer from Secrets Manager and re-registers the memex MCP
  server in Claude Code, so a client holding yesterday's (rotated) token can
  recover from 401s without manual steps. Keeps the strong daily rotation;
  just removes the manual re-register. Token is fetched fresh, never printed,
  and the `claude mcp add` output is suppressed so it can't echo the header.
  Env-driven (`MEMEX_MCP_URL`, optional `AWS_PROFILE`/`AWS_REGION`/
  `MEMEX_SECRETS_PREFIX`); runs on the operator's machine, not the host.

## [1.3.7] — 2026-06-09

### Added
- **eval-replay now reports run-to-run retrieval stability.** Each replayed
  query that has a promoted baseline gains a `stability` block — `jaccard`
  (top-k set overlap of the current vs baseline result ids) and `top1` (did
  the rank-1 result stay the same) — with an aggregate `meanJaccard` +
  `top1StableRate`. Computed by new pure IR-metric primitives
  (precision/recall/MRR/nDCG/Jaccard/top-1) in `core/search/metrics.ts`, the
  substrate for the forthcoming retrieval-quality harness + CI correctness
  gate. No change to the live search path.

## [1.3.6] — 2026-06-09

### Changed
- **Recency decay is now per-prefix instead of one global half-life.** The
  recency multiplier picks its half-life + floor by longest-prefix-match on a
  hit's path: evergreen tiers (e.g. `concepts/`) stop decaying, time-bound
  tiers (e.g. `daily/`, `chat/`) decay fast, entity tiers (`people/`,
  `companies/`) decay slowly. Paths matching no prefix keep the original
  uniform decay (120-day half-life, 0.6 floor), so existing rankings are
  unchanged for un-prefixed content (including code chunks under `src/`).
  Override the map with `MEMEX_RECENCY_DECAY=prefix:halfLifeDays:floor,...`
  (parsed fail-loud so a typo surfaces at startup).

## [1.3.5] — 2026-06-09

### Security
- **Graph reads now redact relationship provenance on public ingress.**
  `graph_neighbors` / `graph_query` previously returned raw edge rows to the
  public bearer, exposing the full relationship topology *plus* provenance
  (`source_chunk_id`, `written_at`), the confidence signal, and the internal
  row id. The public projection now keeps only the slugs + the constrained
  edge `type` (consistent with the rest of the read surface, where slugs are
  already public) and drops everything else. Provenance is stripped on **any**
  public ingress, independent of `MEMEX_PUBLIC_READ_BODIES` (that flag governs
  note bodies, not graph metadata). Internal ingress is unchanged. Found by a
  cross-model audit (independent reviewers + a structural diff of the read
  surface).

## [1.3.4] — 2026-06-09

### Added
- **Code chunks now carry symbol metadata.** Indexing a source file records
  each chunk's `symbol_name`, `symbol_type` (function/class/method/arrow/
  const/module-import), `parent_symbol_path` (enclosing symbol), and
  `language` on the live `chunks` table (migration 027) — values the
  tree-sitter chunker already computed but previously discarded. Markdown
  chunks leave them NULL. This lets `code-callees <path>:<line>` name the
  covering symbol straight from the chunk row and is the substrate for
  symbol-aware retrieval. No change to public search output.

## [1.3.3] — 2026-06-09

### Security
- **Raw exception text no longer crosses the public boundary.** The MCP
  tool dispatcher, the JSON-RPC transport, and the unauthenticated
  `/health` endpoint previously echoed an exception's message straight to
  the caller — on a DB fault that could leak Postgres schema/column names
  or the DSN host. A shared `publicSafeErrorMessage` helper now logs the
  real detail server-side and returns a generic `"internal error"` on
  public ingress (and always for `/health`); the internal path keeps the
  full detail for debugging. Found by an adversarial security audit.

## [1.3.2] — 2026-06-09

### Changed
- **Migrations now fail fast instead of hanging a deploy.** Each migration
  transaction sets `lock_timeout` before its DDL, so an `ALTER`/`ADD COLUMN`
  that can't acquire its `ACCESS EXCLUSIVE` lock (because a long-running
  query holds a conflicting one on live RDS) aborts and rolls back rather
  than blocking the deploy indefinitely. Default is `10s`; override with
  `MEMEX_MIGRATION_LOCK_TIMEOUT` (e.g. `60s`, `5min`) for a one-off
  migration that must wait behind a known long transaction — a malformed
  value fails the deploy loudly. No effect on local PGLite
  (single-connection, no lock contention).

## [1.3.1] — 2026-06-08

### Removed
- **The Obsidian / markdown auto-watch recipe.** `serve` no longer spins up
  a filesystem watcher + boot-time vault sweep. Markdown still enters the
  brain on demand via the `memex reindex` CLI and the MCP `index` tool (and
  pages via `page_put`) — only the always-on vault recipe + its chokidar
  watcher are gone (it was already disabled in production). Stale "Obsidian"
  references across docs and comments were cleaned up; the functional
  dotfile ignore globs (`.obsidian`, `.git`, …) and the `index`/`reindex`
  path-guard are unchanged.

## [1.3.0] — 2026-06-08

### Changed
- **Hybrid search now honours a document's declared importance.** A
  frontmatter `pinned: true` floors a gentle salience multiplier at 1.3×,
  and `weight: <n>` sets it explicitly (clamped to 0.5–2.0×). Applied as a
  post-fusion nudge alongside recency; documents that declare neither are
  unaffected (1.0×). Lets you pin/weight notes without touching the engine.
- **Hybrid search now nudges fresher content up the ranking.** A gentle,
  floor-bounded recency multiplier decays with `documents.updated_at`
  (half-life ~120 days, never below 0.6× so old-but-relevant hits are
  nudged, not buried). Operates on the live retrieval model; a
  missing/unparseable/future timestamp is neutral (1.0×).
- **Hybrid search now weights keyword vs vector retrieval by query
  intent.** Reciprocal Rank Fusion gained optional per-list weights;
  `exact`/`factual` queries lean on keyword (FTS) matches, `topic`/
  `personal` queries lean on semantic vector matches, `howto` stays
  balanced. Gentle multipliers (0.7–1.4) nudge ranking without overriding
  RRF's rank smoothing. Equal-weight behaviour is unchanged when no
  weights are passed.

### Added
- **Exact-match query cache for hybrid search (on by default, fail-open).**
  An identical repeated query now returns its previously-computed ranking
  without re-embedding, re-classifying intent, or re-retrieving — saving
  latency and Bedrock calls. Validity is gated on the live-model generation
  clock, so any document write invalidates the cache automatically; the
  cache stores only chunk ids, re-hydrated from live tables so returned
  content is always current. Any cache error falls through to a normal
  search (it can never break retrieval). Disable per-call with `noCache` or
  globally with `MEMEX_QUERY_CACHE=0`. Migration 026.
- **Cache-invalidation clock on the live retrieval model (internal).** A
  `document_generation_clock` singleton (migration 025) is bumped on every
  document write from the indexer transaction, giving a cheap corpus-level
  "did anything change" signal. Substrate for a forthcoming query cache; no
  behaviour change yet. (The earlier clock from migration 022 sits on the
  dormant `pages` model; this one is on the live `documents`/`chunks` path.)
- **`search` gained an optional `token_budget` parameter.** Caps the total
  size of returned context (~chars/4 tokens); hits are kept in rank order,
  the overflowing tail hit is truncated on a word boundary, and the top hit
  is always returned. Lets an MCP client ask for right-sized context instead
  of a fixed `k` chunks. Unset = unchanged behaviour.
- **Schema substrate for retrieval-quality work (internal, no behavior
  change yet).** A per-page `generation` counter plus a global
  `page_generation_clock` singleton provide a cheap cache-invalidation
  signal for a future query cache; new `tags` / `raw_data` / `config` /
  `ingest_log` metadata tables; and provenance / ranking-signal columns on
  `pages` / `sources` / `links` (e.g. `emotional_weight`,
  `last_retrieved_at`, link `context`/`origin`). All additive — the
  foundation the retrieval-quality phases build on. Migrations 022–024;
  the generation bump is applied at the application layer inside the
  existing page-write transaction (memex uses no DB triggers).

## [1.2.13] — 2026-06-07

### Security
- **EC2 security group SSH inbound now actually closes when disabled.**
  The SSH ingress rule was defined with a `dynamic "ingress"` block whose
  `for_each` collapsed to an empty list when `ssh_allowed_cidr=""` — but a
  dynamic block that iterates zero times leaves the `ingress` attribute
  *unset* (null), which the AWS provider reads as "do not manage ingress",
  so the live `/32` rule was never removed. Rewrote it as an explicit
  `ingress = var.ssh_allowed_cidr != "" ? [{…}] : []` argument; the empty
  list forces the provider to delete all inbound rules. Set
  `ssh_allowed_cidr=""` and applied — the live SG now has zero inbound
  (host is reached only via SSM Session Manager).

### Removed
- **Dropped the legacy `subdomain` slot end-to-end.** `var.subdomain` (the
  retired chat-UI host) fed `STACK_SUBDOMAIN` → `.env` `SUBDOMAIN`/
  `PUBLIC_HOST`, none of which any service consumes (compose reads neither).
  Removed it from `variables.tf`, `compute.tf`, `user_data.sh.tftpl`,
  `terraform.tfvars.example`, `scripts/bootstrap.sh`, and `scripts/init.sh`,
  and realigned `tests/init.test.sh` to the new prompt order. The live
  instance is unaffected (`ignore_changes=[user_data]`; bootstrap runs only
  on first boot). The public MCP host (`memex_subdomain` → `brain.*`) is
  untouched.

### Changed
- **`/ship` is now the mandated entry point for shipping.** Documented in
  `CLAUDE.md` that every change must ship via the `/ship` skill, with the
  repo-specific overrides spelled out (ships to `main`, tags + `gh release`
  instead of a `VERSION` file, operator-only commits with no Claude
  co-author, SSM deploy, local tests as the gate).

## [1.2.12] — 2026-06-06

### Fixed
- **Daily public-bearer rotation never reached the live container.**
  `scripts/rotate-memex-public-bearer.sh` wrote the new bearer to Secrets
  Manager + the on-disk `env_file`, then ran `docker restart` — which does
  NOT reload a changed `env_file` (container env is baked at *create*
  time). So after every 04:00 rotation the container kept the previous
  bearer while SM held the new one, silently breaking public MCP auth for
  any client using the current SM value until the next `compose up`.
  Replaced the restart with `docker compose up -d --force-recreate memex`
  so the freshly-staged `env_file` is actually loaded. Discovered live
  (SM == on-disk env, but the container's `MEMEX_PUBLIC_BEARER` was
  stale). Added `MEMEX_ROTATE_SERVICE` knob (default `memex`).

## [1.2.11] — 2026-06-05

### Security
- **`entity_recall` public page now passes the full field allowlist.** A
  follow-up `/cso` + bug-hunter pass found the public `entity_recall`
  returned its `page` object via the recall layer's `redact_body`
  destructure (which strips only `markdown_body`) instead of the shared
  `redactBody` / `PUBLIC_SAFE_PAGE_FIELDS` allowlist that `page_get` /
  `page_list` / `page_versions` use. No free-text body leaked (markdown
  body was stripped, `compiled_truth` is public by policy), but it
  returned `deleted_at` and — the real issue — **broke the fail-safe
  invariant**: a newly added `PageRow` field would have leaked by default
  on this one path. `mcp/dispatch.ts` `callEntityRecall` now runs the
  page through `redactBody` on public ingress; regression test asserts
  every returned page key is allowlisted. Internal ingress unchanged.

## [1.2.10] — 2026-06-05

### Security
- **Supply-chain: SHA-pin `oven-sh/setup-bun`.** The CI workflow pinned
  the third-party action to a mutable `@v2` tag; moved to the commit SHA
  `0c5077e51419868618aeaa5fe8019c62421857d6` (# v2), matching the
  existing `hashicorp/setup-terraform` pin. Removes the tag-move
  supply-chain vector (already heavily mitigated by
  `permissions: contents: read`, no workflow secrets, push/PR-only
  triggers).
- **Least-privilege: drop stale Gmail egress rules.** Removed the
  `993` (IMAP TLS) and `587` (SMTP STARTTLS) egress rules from the EC2
  security group in `terraform/ec2.tf` — the Gmail/IMAP/SMTP
  integrations were removed when memex became MCP-only, leaving those
  outbound ports allowed for no consumer. Egress-only (no inbound
  exposure), so this is hygiene, not a fix; the live SG drops them on
  the next operator `terraform apply` (folded into the deferred
  state-realign maintenance window — see `TODO.md`).

### Changed
- **Documented the public-read-redaction posture as complete.** Every
  body-bearing / free-text read tool now redacts on public ingress;
  the `graph_*` edge-`type` is an explicit, documented *keep* (single-
  holder daily-rotated bearer; constrained enum, not note text; core to
  graph recall). Reframed the now-dead `FORBIDDEN_PATHS_FROM_PUBLIC`
  REST guard in `http/public_guard.ts` as an intentional fail-closed
  defense-in-depth backstop (the REST routes were removed in A.7; the
  set guards against accidental re-introduction). No runtime behavior
  change.

## [1.2.9] — 2026-06-05

### Security
- **Public-ingress redaction now covers entity facts + timeline.** A
  `/cso` audit found the public MCP read path stripped note bodies from
  `search` / `page_get` / `page_list` / `page_versions` and
  `entity_recall`'s page body, but **not** the free-text `fact` and
  `event` strings returned by `entity_facts`, `entity_timeline`, and
  `entity_recall`'s `facts[]` / `timeline[]` arrays — note-derived
  private content reachable by any public-bearer holder, the same leak
  class as the pre-v1.2.0 vault exposure. Added `redactFacts` /
  `redactTimeline` allowlists in `core/public_redaction.ts` (keep
  id/slug/confidence/source/timestamps, drop the `fact`/`event` text)
  and threaded the `redact` flag through the three entity read tools in
  `mcp/dispatch.ts`. Internal ingress and the `MEMEX_PUBLIC_READ_BODIES=1`
  opt-in are unchanged. Regression tests assert the secret text is
  absent anywhere in a public payload (leak-shaped, rename-proof) and
  present on the internal path. Residual `jobs_*` / `graph_*` public
  read exposure tracked in `TODO.md`.
- **Public-ingress redaction extended to `backlinks` + the `jobs_*`
  reads.** A follow-up security review (security-engineer + bug-hunter)
  found the same leak class still open on read tools that were never
  threaded through the public allowlist: `backlinks` returned
  `surfaceForm` (the raw note-authored wikilink display text, e.g.
  `[[people/jane|Jane's lawyer]]` → `Jane's lawyer`), and `jobs_get` /
  `jobs_list` / `jobs_logs` returned `payload` / `result` / `last_error`
  / `idempotency_key` — arbitrary caller JSON plus raw error text that
  can embed vault paths and note snippets, reachable by any public-bearer
  holder (job IDs are discoverable via `jobs_list`). Added
  `redactBacklinks` + `redactJob` allowlists in
  `core/public_redaction.ts` (keep the operational status/metadata, drop
  the free-text fields) and threaded the `redact` flag through
  `callBacklinks`, `callJobsList`, `callJobsGet`, and `callJobsLogs` in
  `mcp/dispatch.ts`. Internal ingress and the `MEMEX_PUBLIC_READ_BODIES=1`
  opt-in are unchanged. Leak-shaped regression tests
  (`mcp_backlinks_jobs_redaction.test.ts`) assert the secret text is
  absent from public payloads and present on the internal path. Closes
  the primary `jobs_*` public-read residual previously tracked in
  `TODO.md`.

## [1.2.8] — 2026-05-31

### Removed
- **Telegram bridge removed — memex is now reached over MCP only.** The
  chat surface is gone; memex (the brain) is served at
  `GET /health` + `POST /mcp` via cloudflared for MCP clients (Claude
  Code, Cursor, …). Removed:
  - `deploy/telegram-bridge/` (the whole Python daemon, Dockerfile,
    entrypoint) and `deploy/helpers/` (the `memex` MCP-client CLI it
    shipped).
  - The `telegram-bridge` service from `docker-compose.yml` (only
    `memex` + `cloudflared` remain).
  - `telegram-bot-token` from `fetch-secrets.sh`, terraform
    (`secrets.tf`/`outputs.tf`), and the standalone public-bearer file
    (the bearer now lives only in `memex.env`, which memex reads to
    validate incoming MCP bearers).
  - The bearer-rotation script no longer restarts a bridge or delivers
    over Telegram — it rotates the secret + restarts memex.
  - Bridge/telegram tests deleted or updated; compose, dockerfile,
    fetch-secrets, and rotate test suites adjusted.

  cloudflared + `memex-public-bearer` + daily rotation are kept — that is
  the brain's authenticated public MCP ingress. The live
  `telegram-bot-token` secret is deleted out-of-band.
- **Telegram swept from bootstrap/init + all docs.** Dropped the
  `TELEGRAM_BOT_HANDLE` prompt/.env knob (`init.sh`) and the
  telegram-bridge EFS-dir seed (`bootstrap.sh`); rewrote README,
  ARCHITECTURE, AGENTS, llms.txt, SECURITY, CLAUDE, and all
  `deploy/memex/docs/*` + secrets/README to the MCP-only brain
  (answer synthesis is the MCP client's job, not memex's). Adjusted
  the init/bootstrap/compose/dockerfile/fetch-secrets/rotate test
  suites accordingly.

## [1.2.7] — 2026-05-31

### Removed
- **Terraform: dropped the `home_assistant_token` and `google_calendar`
  Secrets Manager resources** (and their `secret_arns` outputs) — the
  follow-up to the v1.2.6 life-integration teardown. The IAM read policy
  is prefix-scoped (`<secrets_prefix>/*`), so no IAM change was needed.
  The corresponding live secrets (`<prefix>/home-assistant-token`,
  `<prefix>/google-calendar`, plus the manually-created
  `<prefix>/gmail-oauth`) are deleted out-of-band; operators running
  `terraform apply` from an existing state should let the apply reconcile
  the two managed resources (or `terraform state rm` them).

## [1.2.6] — 2026-05-31

### Removed
- **All external "life" integrations stripped — memex is now a pure
  knowledge brain (Obsidian vault + code) reachable over MCP + Telegram
  chat.** Removed Home Assistant, Google Calendar, and Gmail entirely:
  - **memex**: deleted the `gcal` + `gmail` ingest recipes, their CLI
    commands (`memex gcal poll` / `memex gmail poll`), the `gmail.poll`/
    `gcal.poll` job handlers and source registrations in `serve.ts`.
  - **telegram-bridge**: dropped the `/today`, `/tomorrow`, `/week`,
    `/weather` commands and the `run_helper` shell-out path; the bot now
    answers only `/search`, `/ask`, `/health`, `/help`, and plain text
    via MCP + Bedrock RAG.
  - **helpers**: deleted `deploy/helpers/gcal` and `deploy/helpers/ha`
    (only the `memex` MCP client remains).
  - **host**: deleted the 6 gcal/gmail OAuth + poll scripts and the
    `memex-gcal-poll` / `memex-gmail-poll` systemd units (only
    `memex-rotate-bearer` remains).
  - **secrets**: `fetch-secrets.sh` no longer fetches
    `home-assistant-token` or `google-calendar`.
  - **docs**: README / ARCHITECTURE / AGENTS / llms.txt / bridge +
    secrets READMEs / CLAUDE-CODE updated to the brain-only surface;
    `GMAIL-GCAL-SETUP.md` deleted; `PRIVACY.md` rewritten (no Google
    OAuth — the stack reads only the operator's own vault + code).

  Terraform secret/IAM teardown and live AWS secret deletion follow
  separately (plan-gated).

## [1.2.5] — 2026-05-31

### Changed
- **telegram-bridge hot-reloads the memex bearer.** The bridge used to
  read `/run/secrets/memex-public-bearer.txt` once at startup, so the
  daily rotation left a brief window (between memex's restart and the
  bridge's) where in-flight calls 401'd. The serve loop now re-reads the
  bearer every 60s and swaps it in when it changes — non-fatal on a
  transient empty/missing file mid-rotation (keeps the current value and
  retries). No restart required to pick up a rotated bearer.

### Fixed
- **`fetch-secrets.sh` writes string secrets atomically** (temp file +
  `mv` rename) instead of an in-place `>` truncate-then-write. Closes the
  partial-write window the bearer hot-reload would otherwise expose: a
  reader now always sees a complete old-or-new file, never a truncated
  one mid-rotation.

## [1.2.4] — 2026-05-31

### Removed
- **Legacy REST routes deleted (MCP cleanup, Phase A.7).** The daemon's
  HTTP surface is now exactly two routes: `GET /health` + `POST /mcp`.
  The phase A.1–A.4 routes (`/index`, `/search`, `/backlinks`,
  `/friction`, `/pages/*`, `/graph/*`, `/entities/*`, `/timeline/*`,
  `/jobs/*`) and their eight handler modules are gone — every behaviour
  is reachable via `tools/call` on `/mcp`. The `memex` shell helper now
  talks to `/mcp` (sending `MEMEX_INTERNAL_TOKEN` for the `index` write
  tool); the telegram-bridge already used `/mcp`. Docs (`API.md`,
  `ARCHITECTURE.md`, `README.md`) updated to the two-route contract.

## [1.2.3] — 2026-05-31

### Security
- **`MEMEX_INTERNAL_TOKEN` now gates MCP write tools too.** The HTTP
  `/index` route already required the shared internal token, but the MCP
  JSON-RPC surface (`POST /mcp`) did not — a compromised sibling on the
  docker bridge could call `tools/call name=index` (or any write tool)
  with no token and poison the RAG corpus. Write tools
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) now require the token on the
  internal path; read tools (the bridge's `search`) and the public
  ingress are unaffected. No-op until the operator configures the token
  (legacy fallthrough, matching the HTTP gate). **Takes effect on the
  next EC2 deploy.**

## [1.2.2] — 2026-05-31

### Security
- **Pin `hashicorp/setup-terraform` to a commit SHA** (`dfe3c3f`, v4)
  instead of the moving `@v4` tag. If hashicorp's org were compromised,
  a re-tagged `v4` would otherwise flow into CI silently. First-party
  actions (`actions/checkout`, `actions/setup-python`, `oven-sh/setup-bun`)
  remain on major tags — lower risk, owner-canonical publishers.

## [1.2.1] — 2026-05-31

### Tests
- **MCP-ingress redaction regression test** locks the v1.2.0 vault-exfil
  fix. `tests/mcp_redaction.test.ts` calls `dispatchTool` directly and
  asserts that public ingress (`isPublic: true`) strips `markdown_body`
  / `body_snapshot` from `page_get` / `page_list` / `page_versions` /
  `entity_recall` while internal callers keep them, and that
  `MEMEX_PUBLIC_READ_BODIES=1` re-enables bodies. Uses a shared,
  seeded-once PGLite fixture (read-only assertions) so it stays fast.
- **MCP `search` redaction wiring test** completes the coverage.
  `tests/mcp_search_redaction.test.ts` stubs `hybridSearch` (no Bedrock,
  no pgvector) and asserts public ingress strips `content` and any
  non-allowlisted field from search hits while internal keeps them, plus
  the `MEMEX_PUBLIC_READ_BODIES=1` opt-in. All five public read tools are
  now regression-locked.

### CI
- **arm64 Bun job per-test timeout raised to 30s** (amd64 gate stays at
  the 5s default). The free arm64 canary runner is 3-4x slower; PGLite
  cold-init intermittently pushed individual tests past the default,
  producing false failures. The timeout is now arch-specific via the
  matrix.

## [1.2.0] — 2026-05-30

### Security
- **Public MCP ingress no longer leaks note bodies (vault-exfil fix).**
  The REST routes redacted note bodies for public callers, but the
  documented public ingress (`brain.<domain>/mcp`) goes through the MCP
  JSON-RPC layer, where `dispatchTool` ignored the request's public flag
  — so a holder of the public bearer could read entire note contents via
  `search` / `page_get` / `page_list` / `page_versions` / `entity_recall`.
  Redaction now applies on BOTH ingress paths through a shared
  `core/public_redaction.ts` allowlist (bypassed only with
  `MEMEX_PUBLIC_READ_BODIES=1`); internal callers are unaffected.

### Changed
- **Chat path simplified — `telegram-bridge` owns it end-to-end.**
  The legacy chat-agent container is removed from the stack.
  `telegram-bridge` calls memex over MCP JSON-RPC for retrieval and
  Bedrock Claude Haiku 4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`)
  for synthesis. The bot still exposes the same eight slash commands
  (`/today`, `/tomorrow`, `/week`, `/weather`, `/search`, `/ask`,
  `/health`, `/help`); plain text is treated as `/ask`. Bearer auth
  for the bridge's MCP calls lives at
  `/run/secrets/memex-public-bearer.txt` (mode `0444`); the daily
  rotation timer restarts the bridge so it re-reads the new token.

### Removed
- **Legacy chat-agent container removed entirely.** The container, its
  build context, web-UI config, plugin manifest, gateway-token secret,
  and the 13 markdown skills under `deploy/skills/` are gone. The helper
  CLIs (`gcal`, `ha`, `memex`) moved into `deploy/helpers/` and ship
  into the bridge container instead. The chat-agent's post-onboard
  config script is deleted.
- **Morning-briefing script + systemd units removed entirely** (the
  former `archive/morning-briefing/` directory is deleted). They
  depended on the now-removed chat-agent container and stopped working
  at the cutover. The capability remains a future TODO (host-side
  composer → Bedrock Haiku → Telegram Bot API); nothing ships today.
- **Final chat-agent scrub.** The last narrative references to the
  removed chat agent are gone from source, tests, docs, and audit
  patterns. Guard tests were rewritten to assert the expected memex
  topology positively (e.g. the exact compose service set) instead of
  naming the removed component; legacy secret-prefix and
  terraform-address scrub patterns were dropped. One opaque value
  remains by design — the live RDS source-id key in
  `recipes/obsidian.ts`, deferred to the memory-store migration.

### Changed (docs)
- Refreshed `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CLAUDE.md`,
  `ARCHITECTURE.md`, `TODO.md`, `llms.txt`, `deploy/secrets/README.md`,
  and `deploy/memex/docs/OPERATIONS.md` to match the current
  three-container stack. `CLAUDE.md`'s model-selection note now points
  at the bridge's `MEMEX_BRIDGE_LLM_MODEL` (the deleted post-onboard
  script is gone). `AGENTS.md` and `CONTRIBUTING.md` now require running
  the matching review skill/agent and the test→push→deploy→verify ship
  workflow for every change.

### Added
- **Phase A.5 — hot_memory + subagent durable ledger (schema only).**
  Lays the persistence rails for two future engines without exposing
  any MCP surface today: the dream-cycle consolidate phase that
  promotes short-term observations into `entity_facts`, and the
  sub-agent runner that crash-recovers an in-flight LLM tool loop
  from durable storage.

  Schema (migration 020_hot_memory.sql):
  * `hot_memory` -- short-term fact buffer with supersession.
    Columns: `entity_slug` (soft ref, no FK so a fact can land
    before the page does), `fact`, `effective_confidence REAL`
    bounded by `CHECK [0, 1]`, `session_id`, `source_slug`,
    `source_chunk_id`, `written_by`, `superseded_by BIGINT` (self
    ref, ON DELETE SET NULL), `written_at`.
  * Indexes: `(entity_slug, written_at DESC)` for the entity
    timeline read; partial `(session_id) WHERE session_id IS NOT
    NULL` for the per-session sweep; partial
    `(entity_slug, effective_confidence DESC) WHERE superseded_by
    IS NULL` -- the hot working set the consolidate phase reads.

  Schema (migration 021_subagent_ledger.sql):
  * `subagent_messages (id, job_id FK CASCADE, turn_num, role,
    content jsonb, written_at)` with `UNIQUE(job_id, turn_num)`
    so a worker retry replays the same INSERT idempotently and
    the first one wins. `role` constrained to `user | assistant
    | tool_result | system`.
  * `subagent_tool_executions (id, job_id FK CASCADE, turn_num,
    tool_name, input jsonb, output jsonb, status, error,
    started_at, finished_at)` with `status` constrained to
    `pending | succeeded | failed | skipped`. Supervisor inserts
    a `pending` row BEFORE invoking the tool; on crash, the
    resume sweep finds it via the partial index
    `(started_at) WHERE status = 'pending'` and decides retry vs
    skip.

  Core modules (no MCP surface in A.5):
  * `core/hot_memory.ts` -- `recordHotFact` (per-field length
    bounds on `fact` (4000), `session_id` / `source_chunk_id` /
    `written_by` (256) so the schema cannot accept multi-MB
    free-text rows), `supersedeHotFact` (rejects self-supersede;
    returns `{updated, superseded_by}` so the losing caller of a
    concurrent supersede sees the actual winner's id and can
    reconcile instead of retrying blindly), `listHotFacts`
    (default `unsuperseded_only: true`; supports `session_id`
    filter and `limit` 1-1000).
  * `core/subagent_ledger.ts` -- `appendMessage` (ON CONFLICT DO
    NOTHING on `(job_id, turn_num)` for replay-safe writes,
    falling back to a SELECT to return the pre-existing id; now
    THROWS if the SELECT also misses so callers never see a
    bogus `id: -1`; `content` capped at ~1 MB pre-`JSON.stringify`),
    `listMessages` (default LIMIT 1000, max 1000 -- prevents a
    50k-turn job from returning the whole ledger),
    `beginToolExecution` (writes the `pending` row; `tool_name`
    capped at 256 chars; `input` capped at ~1 MB),
    `finishToolExecution` (UPDATE guarded by `WHERE status =
    'pending'` so a duplicate finish never rewrites a terminal
    row; returns `{updated, current_status}` so the loser of a
    concurrent succeeded/failed race can see which terminal
    status actually stuck; `output` capped at ~1 MB; `error`
    truncated to ~1 MB), `listToolExecutions` (default LIMIT
    1000, max 1000).

  Security note (TODO.md, to be enforced by the A.6 MCP layer):
  `hot_memory.fact`, `subagent_messages.content`, and
  `subagent_tool_executions.input/output/error` carry free-text
  PII / OAuth-bearing tool inputs / model output. Future MCP
  read tools MUST go in the WRITE-tools allowlist
  (`FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`) so the public-bearer never
  reaches them. Soft-ref `entity_slug` reads must return `404`
  uniformly on miss to prevent entity-existence enumeration.
  Crash-recovery sweeps for pending tool rows must bind to a
  `supervisor_run_id`/`worker_id` and refuse cross-worker
  retries -- otherwise an internal-token holder who writes a
  pending row turns the next sweep into a stored-command
  injection into the agent loop.

  Tests:
  * `tests/hot_memory.test.ts` -- 12 cases (insert + validation
    of slug grammar, fact non-empty, confidence range, source_slug
    grammar; supersede semantics including self-supersede rejection,
    idempotency, and a third-party race in which the losing caller
    reads back the winner's id via `superseded_by`; listHotFacts
    unsuperseded_only default, session_id filter, confidence DESC
    ordering).
  * `tests/subagent_ledger.test.ts` -- 9 cases (validation of
    job_id / turn_num / role; idempotent append on
    `(job_id, turn_num)`; ordering; `pending -> succeeded`
    lifecycle exposing `current_status`; refusal to finish a
    non-pending row with the surviving `current_status` reported
    back; rejection of `pending` as a finish status; CASCADE
    delete on `jobs` row removal for both ledger tables).

  Why schema-only: the consolidate behaviour for `hot_memory`
  and the supervisor runner that fills `subagent_*` both belong
  in later phases that will also ship their MCP surfaces. The
  schema lands now so the migration log moves forward in a
  single commit instead of fragmenting across later phases.

- **Phase A.4 — jobs DAG (fan-out + fan-in + idempotent submit) +
  jobs_* MCP surface.** Lays down the durable async-work substrate
  for future recipe pipelines and dream-cycle phases.

  Schema (migration 019_jobs_dag.sql):
  * `jobs` extended with `parent_job_id` (FK to jobs.id ON DELETE
    SET NULL), `depth INTEGER DEFAULT 0` (capped at 32 to prevent
    runaway recursion), `idempotency_key TEXT` (partial UNIQUE on
    `(kind, idempotency_key) WHERE NOT NULL`).
  * `job_children (parent_id, child_id, created_at)` -- denormalised
    edge table for fast "what children did I spawn?" lookups.
  * `child_done_inbox (parent_id, child_id, child_status,
    result_excerpt, completed_at, notified_at)` -- outbox-style
    write-once ledger. The parent's handler drains the inbox to
    detect fan-in completion. Partial index on
    `(parent_id, completed_at) WHERE notified_at IS NULL` for cheap
    unread-row lookups.

  Core module `core/jobs/dag.ts`:
  * `submitJob` -- idempotent on `(kind, idempotency_key)`. Parent
    -> child fan-out persists the edge in `job_children` and inherits
    depth+1. Refuses fan-out from a terminal parent (succeeded /
    failed / cancelled). Depth cap 32 with explicit error message.
  * `writeChildDoneInbox` -- write-once semantics: ON CONFLICT DO
    NOTHING so a worker retrying after a crash never overwrites the
    first observation of a terminal state. Excerpt truncation is
    UTF-8 byte-bounded (walks back from byte 8192 to the previous
    UTF-8 lead byte) so multi-byte glyphs at the boundary drop
    cleanly instead of corrupting into U+FFFD.
  * `drainDoneInbox` -- atomic read+mark-read with optional
    `mark_read: false` peek for tests.
  * `cancelJob` -- cascade BFS over pending descendants. Uses a
    visited Set so cyclic `job_children` rows (an idempotency-key
    replay can re-attach an existing job to a new parent) terminate
    instead of infinite-looping. Hard-capped at 10_000 descendants
    so a pathological tree fails fast rather than ballooning the
    `ANY($1::text[])` parameter.
  * `listJobs`, `getJob` -- read surface. `getJob` returns the row
    plus its children and unread inbox count.

  HTTP surface (`http/jobs_route.ts` + server.ts):
  * `POST /jobs/submit` -- internal-only (MEMEX_INTERNAL_TOKEN).
  * `POST /jobs/cancel` -- internal-only. Reason capped at 512
    chars.
  * `POST /jobs/list`, `/jobs/get`, `/jobs/logs` -- public+bearer.
    Public-ingress responses STRIP `payload`, `result`, and
    `last_error` (replaced with boolean `has_error` / `has_result`
    markers). These fields routinely carry sensitive context
    (URLs, OAuth excerpts, file paths from handler exceptions,
    Bedrock model IDs) -- internal callers still see them in full.
  * `/jobs/list` returns 400 on a malformed body so a bad caller
    cannot silently enumerate everything with an empty filter.

  MCP -- 5 new tools, total 20 -> 25:
  * `jobs_submit`, `jobs_cancel` (WRITE; added to
    FORBIDDEN_MCP_TOOLS_FROM_PUBLIC).
  * `jobs_list`, `jobs_get`, `jobs_logs` (READ).

  Test coverage:
  * `tests/jobs_dag.test.ts` (~37 assertions): idempotency on
    `(kind, key)`, fan-out depth inheritance + cap, terminal-parent
    refusal, inbox round-trip + peek + write-once semantics, UTF-8
    boundary truncation (4-byte emoji corpus crossing the 8192
    boundary), cascade cancel + cycle termination + 10k cap.
  * `tests/mcp.test.ts` updated for the 25-tool tools/list.
  * `tests/public_guard.test.ts` extended for the new forbidden /
    allowed sets.

  Self-review acted on across two parallel reviewers (code-reviewer +
  security-engineer): cycle BFS termination, UTF-8 split, write-once
  inbox, payload/result/last_error redaction on public reads, list
  400 on malformed body, reason length cap, depth-32 documentation,
  result type widened to `unknown` (handlers may legitimately return
  strings/arrays/numbers). Two MEDIUM findings deferred to TODO.md:
  CASCADE asymmetry on `parent_job_id` vs `job_children` /
  `child_done_inbox`; inbox-during-cancel race (needs SERIALIZABLE
  isolation or `FOR UPDATE` on frontier read).

  Suite: 228 pytest + 549 bun (+26 from Phase A.3) passing, audit +
  scrub clean.

- **Phase A.3 — timeline events + entity facts + entity MCP surface.**
  Two new append-only ledgers + five new MCP tools that together let
  the agent answer "what do I know about X?" from a single call.

  Schema (migrations 017 + 018):
  * `timeline_events` — (id, slug FK→pages CASCADE, occurred_at,
    event, source_chunk_id, written_at). Two indices (slug+time,
    occurred_at) plus a partial UNIQUE index on
    (slug, occurred_at, source_chunk_id) WHERE source_chunk_id IS
    NOT NULL — chunk-sourced events idempotent, manual events
    skip dedup deliberately.
  * `entity_facts` — (id, entity_slug soft-ref, fact, confidence
    REAL CHECK 0..1, source_slug, source_chunk_id, written_by,
    written_at). Indices on (entity_slug, written_at desc),
    (entity_slug, confidence desc), and (source_slug)
    WHERE source_slug IS NOT NULL. Partial UNIQUE on
    (entity_slug, fact, source_chunk_id) — same dedup semantics as
    timeline_events. Entity_slug is a SOFT reference (no FK) so a
    fact can be recorded about an entity before its page exists —
    a future dream-cycle "consolidate" phase will auto-stub pages
    once an entity hits N facts.

  Core modules:
  * `core/timeline.ts` — `addTimelineEvent` (idempotent with chunk_id,
    manual entries always insert), `getEntityTimeline` with
    since/until/limit window filters, ISO-string and Date input
    normalisation.
  * `core/facts.ts` — `addFact`, `listFacts` (confidence-desc default,
    recency-order opt-in, source_slug filter), and the headline
    aggregator `entityRecall(slug, opts)` that returns the page
    row + top-confidence facts + most-recent timeline events in
    parallel. Optional `redact_body` strips `markdown_body` from the
    returned page (forced on by the public HTTP path).

  HTTP routes (`http/entities_route.ts` + server.ts wiring):
  * `POST /entities/facts/add` — internal-only (MEMEX_INTERNAL_TOKEN).
  * `POST /timeline/add` — internal-only.
  * `POST /entities/facts` — public+bearer (READ).
  * `POST /entities/timeline` — public+bearer (READ).
  * `POST /entities/recall` — public+bearer (READ; redacts body on
    public ingress unless MEMEX_PUBLIC_READ_BODIES=1).

  MCP surface — 5 new tools, total 15 -> 20:
  * `add_fact`, `add_timeline_event` (WRITE — added to
    FORBIDDEN_MCP_TOOLS_FROM_PUBLIC).
  * `entity_facts`, `entity_timeline`, `entity_recall` (READ).

  Test coverage:
  * `tests/timeline.test.ts` (~25 assertions): FK on slug,
    ISO/Date normalisation, dedup with vs without chunk_id,
    since/until/limit windowing, CASCADE on page delete.
  * `tests/entity_facts.test.ts` (~30 assertions): soft-stub entity
    facts (no page required), confidence range, source_slug filter,
    confidence-vs-recency ordering, dedup semantics, entityRecall
    page=null path, combined page+facts+timeline result, limits,
    body redaction toggle.
  * `tests/mcp.test.ts` updated for the 20-tool tools/list contents.
  * `tests/public_guard.test.ts` extended for the new
    forbidden/allowed sets.

  Suite: 228 pytest + 523 bun (+29 from Phase A.2) passing, audit +
  scrub clean.

- **Phase A.2 — typed page-to-page links + graph MCP surface.** New
  migration `016_links_typed.sql` adds a `links` table keyed on
  `(source_slug, target_slug, type)` with confidence + optional
  source_chunk_id + write timestamp. Source has FK CASCADE on
  `pages.slug`; target is a soft reference (slug text, page may not
  yet exist). CHECK constraint pins `inferred_confidence` to `[0,1]`.
  Three indices: source+type, target+type, type.
- **`deploy/memex/src/core/links.ts`** — typed graph CRUD: `addLink`
  (idempotent on the unique tuple — re-asserting just updates
  confidence + chunk_id), `removeLink`, `graphNeighbors`
  (outbound/inbound/both with optional type filter),
  `graphQuery` (typed-relationship lookup; requires at least one of
  `source_slug` / `target_slug` so the table can't be drained in
  one call). `slugifyTarget` normalises loose names ("Alice Smith")
  into strict slugs ("alice-smith") with `/` namespace preservation
  and Unicode→ASCII collapse. `KNOWN_LINK_TYPES` catalogue: wikilink,
  mentions, works_at, attended, founded, advises, invested_in,
  knows, met, located_at, related_to, supersedes, contradicts.
  Application-layer enforced — extensible via `allowAdHocType`.
- **Deterministic `[[wikilink]]` extractor.** `extractWikilinks(body)`
  returns the distinct surface forms (`[[Alice|alias]]` → "Alice").
  `syncWikilinksForPage(slug, body)` replaces the wikilink-typed
  outbound edge set for `slug` in a single transaction — never
  touches other types and never touches edges from other sources.
  Zero LLM calls.
- **Auto-sync on page writes.** Both the HTTP `POST /pages/put` and
  `POST /pages/append` routes (and their MCP counterparts) now call
  `syncWikilinksForPage` after a successful changed write. Self-
  healing: if the sync throws after the page row is committed, the
  page write stands and a retry (or a future dream-cycle reconcile
  pass) rebuilds the edges — both writes are idempotent.
- **HTTP graph surface** (`deploy/memex/src/http/graph_route.ts`):
  `POST /graph/link` and `POST /graph/unlink` (internal-only,
  `MEMEX_INTERNAL_TOKEN`-gated), `POST /graph/neighbors` and
  `POST /graph/query` (open under the public-bearer).
- **MCP graph tools.** Four new tools: `link`, `unlink` (WRITE,
  added to `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC`), `graph_neighbors`,
  `graph_query`. Total registered tool count rises from 11 → 15.
- **Test coverage.** New bun suite `tests/links.test.ts` (50
  assertions covering slugify rules, add/remove idempotency,
  confidence range, direction-filtered neighbors, typed graphQuery,
  wikilink extractor edge cases — pipes, dedup, malformed brackets,
  empty body — and the post-write sync semantics: replaces stale
  wikilink edges without touching other-typed or other-source
  links). `tests/mcp.test.ts` updated for the 15-tool registered
  surface. `tests/public_guard.test.ts` extended for the new
  forbidden list (link, unlink blocked; graph_neighbors,
  graph_query allowed).

- **Phase A.1 — DB-canonical page store.** New migration
  `015_pages.sql` adds two tables: `pages` (slug PK, type, title,
  `compiled_truth` jsonb, `markdown_body`, content_hash,
  created_at, updated_at, deleted_at) and `page_versions`
  (append-only edit history keyed by `(slug, version_n)`). Both
  are indexed for type filters + updated-desc listing + jsonb
  GIN search on compiled_truth.
- **`deploy/memex/src/core/pages.ts`** — CRUD module behind every
  write: `putPage` (idempotent upsert with auto-versioning),
  `appendPage`, `getPage`, `listPages`, `pageVersions`,
  `deletePage` (soft delete with tombstone version row). Strict
  slug validation (kebab-case + optional `/` namespaces, 1..256
  chars). Catalogue of well-known page types
  (`KNOWN_PAGE_TYPES`) with an `allowAdHocType` escape hatch.
- **HTTP page surface.** `deploy/memex/src/http/pages_route.ts`
  + new server routes: `POST /pages/put`, `POST /pages/append`,
  `POST /pages/delete` (all internal-only behind
  `MEMEX_INTERNAL_TOKEN` like `/index`), `GET /pages/get`,
  `POST /pages/list`, `GET /pages/versions`. Public-ingress
  reads return an allowlisted shape (slug/type/title/
  compiled_truth/content_hash/timestamps) unless
  `MEMEX_PUBLIC_READ_BODIES=1` — matches the existing `/search`
  redaction policy.
- **MCP page tools.** Six new tools exposed via the JSON-RPC
  MCP transport: `page_put`, `page_append`, `page_delete`,
  `page_get`, `page_list`, `page_versions`. Writes added to
  `FORBIDDEN_MCP_TOOLS_FROM_PUBLIC` so a public bearer-holder
  can never mutate the store. Total registered tool count
  rises from 5 → 11.
- **Test coverage.** New bun suite `tests/pages.test.ts`
  (35 assertions covering slug grammar, idempotent put, version
  history, append semantics, soft delete with tombstone, list
  filters, type validation, transactional integrity).
  `tests/public_guard.test.ts` extended for the new
  forbidden-list (page writes blocked; page reads allowed).
  `tests/mcp.test.ts` updated for the new tools/list contents.

### Removed
- **`obsidian-sync` container deleted.** Source tree
  (`deploy/obsidian-sync/`), compose service block, terraform
  secret (`<secrets_prefix>/obsidian-sync`), docker test class,
  the `obsidian` helper CLI, and the `deploy/skills/obsidian.md`
  skill file all gone. memex storage is being redesigned to be
  database-canonical (Postgres rows as the source of truth, not
  filesystem files); the bidirectional-Obsidian-sync sidecar no
  longer fits that direction. The legacy filesystem-watch recipe
  (`deploy/memex/src/recipes/obsidian.ts`) is kept in source for
  now and disabled by default (`MEMEX_VAULT_PATHS=/memory`, no
  external vault mount) — it will be replaced or removed in the
  next iteration's schema migration.
- `${EFS_MOUNT}/vault:` bind mounts removed from the `memex` and
  chat-agent service definitions in `deploy/docker-compose.yml`.
  EFS now carries only container runtime state (workspace, cron,
  devices, recipe-state, telegram-bridge state).

### Changed
- ARCHITECTURE.md, README.md, AGENTS.md updated to reflect the
  four-container topology (`memex` + chat agent + `telegram-bridge`
  + `cloudflared`).

## [1.1.0] — 2026-05-17

### Added
- **`telegram-bridge` container — always-on two-way Telegram surface.**
  Long-polls the Bot API independently of the chat agent so the bot keeps
  replying even when the chat-agent is restarting or stuck on a
  paired-device approval. Routes slash-commands (`/today`, `/tomorrow`,
  `/week`, `/weather`, `/search`, `/health`, `/help`, `/ask`) to the
  existing helpers, and answers free text with a RAG pipeline
  (`memex /search` for retrieval, Bedrock Nova Lite for synthesis).
  Falls back to retrieval-only when Bedrock is unavailable so the bot
  never goes silent. Runs as non-root uid 10001 with read-only fs,
  tmpfs `/tmp` (noexec), `cap_drop: ALL`, and `no-new-privileges`.
  Allowlisted by numeric chat id via `MEMEX_BRIDGE_ALLOWED_CHAT_IDS`;
  unbounded refusal floods are prevented by an LRU-capped + global
  rate-limited `RefusalGate`. Persists `last_update_id` to
  `${EFS_MOUNT}/telegram-bridge/state.json` so restarts don't replay
  history (atomic write + fsync(file+dir) + per-PID tmp suffix).
- **Internal-route shared-token gate (`MEMEX_INTERNAL_TOKEN`).** Plugs
  the `Cf-Connecting-Ip`-only trust hole on POST `/index` and POST
  `/friction`: any peer on the docker bridge must now present the
  shared bearer or get `401`. Provisioned via terraform
  `random_password` + Secrets Manager; fetched into the memex
  container's `memex.env` via `fetch-secrets.sh`. Legacy single-node
  installs upgrade cleanly — when the token is absent the server
  logs a one-shot warning and stays open.
- **Public `/search` + `/backlinks` body redaction.** Public-ingress
  responses now return only an allowlisted shape (`title`,
  `sourcePath`, `score`, `documentId`, `chunkId`, `kind`, `rank`) —
  any future body-ish field added to `SearchHit` cannot accidentally
  leak. Bodies opt back in via `MEMEX_PUBLIC_READ_BODIES=1` for
  operators who want full hit content over Cloudflare. Generic
  `"search backend error"` / `"backlinks backend error"` on public
  500s so SQL paths and table names no longer leak via exception
  text. Internal callers still see full bodies + raw error text.
- **Bedrock RAG hardening in the bridge.** `_scrub_tags` now covers
  `<note>`, `<user_question>`, `<system>`, `<instruction>`,
  `<assistant>`, `<user>`, `<tool>`, `[INST]`/`[/INST]`, and `</s>`
  role markers — plus a unicode strip (NUL / ZWJ / BOM) before the
  regex so invisible-char bypasses fail too. `_defang_urls` wraps
  every `http(s)://...` token in backticks before sending to
  Telegram so the operator never accidentally taps a URL the model
  hallucinated from a poisoned Gmail/GCal note. Bedrock request
  body now passed via `--body fileb://<mkstemp>` instead of argv —
  prompts + retrieved notes no longer appear in `/proc/<pid>/cmdline`
  to any uid on the host. Per-call request + response tmpfiles via
  `tempfile.mkstemp()`, both unlinked in the same `finally` so a
  symlink-attack on a shared `/tmp` is impossible.
- **Standalone systemd morning-briefing path** (`memex-morning-briefing.timer`)
  that composes the daily briefing from helpers and posts via
  Telegram Bot API directly. Bypasses the chat-agent gateway pairing
  scope entirely so the 07:00 Europe/Berlin delivery is no longer
  blocked on chat-UI approvals.
- **multi-arch CI matrix.** `bun-tests` job now runs on both
  `ubuntu-latest` (amd64) and `ubuntu-24.04-arm` (arm64, production
  target). An arm64-only Bun runtime regression or a transitive
  native module without an arm64 wheel now fails CI before reaching
  the EC2 deploy.
- **Operator-private PII overlay** (`scripts/lib/pii-patterns.local.txt`
  — gitignored) lists concrete identifiers (email, chat id, account
  id, instance id, RDS endpoint, domain, GitHub handle) so any
  future regression of an operator identifier gets caught by
  `make audit` even if the generic patterns wouldn't have.
- **Upstream `pii-patterns.txt` extensions** — RDS / ElastiCache /
  Redshift hostname shape + GitHub `<owner>/<repo>` reference; both
  catch the shapes the operator-private overlay would otherwise be
  alone in catching.

### Changed
- **IAM Bedrock policy tightened** — adds an explicit Deny against
  direct `bedrock:InvokeModel` outside `var.bedrock_allowed_regions`
  (default `eu-west-1`, `eu-central-1`, `eu-north-1`, `us-east-1`).
  Profile-routed invocations (CalledVia=bedrock) keep working;
  direct invocations of `nova-pro` / `haiku-4-5` in non-allowlisted
  regions are blocked, capping the cost-burn radius of a
  compromised container.
- **memex container drops root.** Dockerfile now runs as the alpine
  `bun` user (uid 1000) with `chown -R bun:bun /app`; the EFS
  bind-mounts are already chowned 1000:1000 by `scripts/bootstrap.sh`.
  Combined with `cap_drop: ALL` + `no-new-privileges`, an RCE in
  the Bun process no longer lands as root with full read of the
  host AWS profile dir.
- **Chat-agent entrypoint accepts a Telegram-disable flag**
  (default in compose) and removes the `channels.telegram` block
  before booting. Prevents the 409 Conflict that occurs when two
  consumers race for the same bot's `getUpdates` long-poll — the
  `telegram-bridge` container now owns the bot exclusively by
  default.
- **`fetch-secrets.sh` permission model fixed for non-root
  containers.** `.secrets/` dir → `0711` (root reads+lists, others
  descend only); `telegram-bot-token.txt` → `0444` so uid 10001
  inside the bridge can read it; `fetch_text` helper takes an
  optional 3rd `mode` arg. `bootstrap.sh` now chmods
  `/home/ec2-user/.aws/config` to `0644` (no secret in that file)
  so the bridge can read the AWS profile pointing at IMDS.
- **`bootstrap.sh` seeds `${EFS_MOUNT}/telegram-bridge` dir** with
  ownership `10001:10001` so the bridge can write its state file
  on first boot without an out-of-band fix.
- **CI shellcheck job** now lints `deploy/telegram-bridge/entrypoint.sh`
  so a syntax regression in the bridge launcher fails CI rather
  than at boot.
- **`bridge _parse_allowed_chat_ids` rejects non-ASCII digits.**
  Python's `int()` accepts Arabic-Indic and full-width digits
  (`int("١٢٣") == 123`), which would silently allowlist a chat id
  the operator did not visually intend. Now requires `part.isascii()`
  before parsing. Negative ids (Telegram supergroups) still work.

### Fixed
- **RDS master password rotation** (May-17, 2026 incident). Rotated
  via `aws rds modify-db-instance --master-user-password
  --apply-immediately` after a brief leak during the May-16
  PGLite→RDS debug session. Documented gotcha: the secret stores a
  full postgres URL, so the rotation password must be URL-safe
  (exclude `?`, `#`, `&`, `:`, `=`, `+`, `%`) OR URL-encoded before
  being written back to `<secrets_prefix>/memex-postgres-url`. The
  TODO entry now spells out the safe `get-random-password
  --exclude-characters` invocation.
- **Connection-pool leak when Telegram returns 409 Conflict.** The
  bridge's `HTTPError` handler now drains the response body before
  raising, so an open-but-unread connection no longer accumulates
  on some urllib versions.

### Security
- Three parallel security reviews (security-engineer x2 +
  code-reviewer + devops-automator + ai-engineer + bug-hunter)
  acted on across two passes: **1 CRITICAL** (internal-auth gate),
  **5 HIGH** (memex non-root, IAM region-tightening, body
  redaction, RAG injection, RefusalGate DoS bound), **8 MEDIUM**
  (SSRF guard on `MEMEX_URL`, prompt-injection delimiter scrub,
  fsync on state file, signal handler ordering, max-hits clamp
  warning, `tmpfs /tmp:noexec`, public-vs-internal rate-limit
  split, scrubber unicode strip), and **4 LOW** fixed in-session
  before push.
- Live attack-surface verification: peer→`/index` request without
  the `MEMEX_INTERNAL_TOKEN` shared bearer returns `401` from the
  running memex container. The defensive change is provably active
  in production, not just in tests.

### Tests
- `+1` Bun test file (`internal_auth_and_redaction.test.ts`, 16
  assertions covering the new internal-auth gate + allowlist-based
  redaction including a regression guard for future SearchHit
  fields).
- `+45` pytest assertions across `test_telegram_bridge.py` (URL
  validator, tag-scrub invisible/NUL/role-marker bypasses, ASCII
  chat-id guard, Bedrock retry classifier, RefusalGate LRU + global
  rate limit, fsync-based State.save, `_handle_rag → _defang_urls`
  wiring regression).
- `+4` pytest assertions across `test_fetch_secrets_sh.py` +
  `test_bootstrap_sh.py` (per-file mode arg, 0711 dir mode, 0644
  AWS config mode, EFS bridge dir seeding).
- `+1` compose hardening parametrize entry for `telegram-bridge`.
- `+1` Dockerfile structural class for the bridge image.
- Full suite at v1.1.0: **244 pytest + 434 bun green, audit + scrub
  clean, terraform fmt + validate clean.**

## [1.0.0] — 2026-05-11

### Added
- Initial public release as `memex`.
- `memex` knowledge brain (Bun + Postgres + pgvector + MCP server,
  with PGLite available as a dev-only fallback) — hybrid search,
  entity graph, and graph-only code chunkers for TS / Python.
- Chat-agent surface (Telegram + web UI via
  Cloudflare Tunnel).
- `obsidian-sync` sidecar for bidirectional Obsidian vault sync.
- `cloudflared` sidecar for public HTTPS ingress.
- Terraform stack (VPC, EFS, RDS Postgres, EC2, Cloudflare Tunnel,
  Secrets Manager, CloudTrail, CloudWatch logs).
- Interactive `make init` bootstrap that writes `.env`,
  `terraform/terraform.tfvars`, and `terraform/backend.hcl`.
- `make audit` PII gate — fails if any maintainer-private identifier
  leaks into a tracked file.
- Bash unit tests for `init.sh` and `audit.sh`.
- MIT License, SECURITY policy, contributor guide, GitHub Actions CI.
