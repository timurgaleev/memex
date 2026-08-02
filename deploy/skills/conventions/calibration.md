# Convention: calibration loop

The brain knows your track record and uses it. The calibration loop has
five concrete touchpoints — agents working with this brain should know
which one applies to their current task.

## Touchpoints

| When you're working on... | Apply this |
|---|---|
| Surfacing advice where the brain tells the user something | Voice-gate the output: conversational register, calibrated confidence, no over-claiming. Pick the framing that fits the surface: pattern statement, nudge, forecast blurb, dashboard caption, morning pulse. |
| Writing user-facing strings about the user's track record | Conversational, not academic. Friend, not doctor. Concrete numbers ("2 of 3 missed") over abstract metrics ("Brier 0.31"). Never use the phrase "according to your data." |
| Reading the active calibration profile | `get_calibration_profile` — returns the user's per-domain hit-rate and confidence profile. Read it BEFORE weighting a take's conviction in synthesis. |
| Grading or reviewing past takes | `takes_scorecard` for the aggregate view; `takes_calibration` for the confidence-vs-outcome breakdown; `list_takes` / `takes_search` to pull the raw rows. |
| Resolving a take (it proved right/wrong/moot) | `set_take_status` with the verdict. Cite the evidence page in the resolution — an unevidenced verdict pollutes the calibration data. |
| Writing takes fences on pages | Follow the holder/weight contract in `_brain-filing-rules.md` (Takes attribution section). Weights on the 0.05 grid only. |

## When to surface a calibration warning

The doctor checks (`run_doctor` / `memex doctor`) that watch this loop:

- `abandoned_threads` — informational. Count of high-conviction takes
  (weight >= 0.7) older than 12 months that haven't been superseded or
  linked to a follow-up. Always status='ok' with a count.

- `calibration_freshness` — warns when the active profile is older than
  7 days. Hint: regenerate the profile (operator-side).

- `grade_confidence_drift` — placeholder for confidence-vs-accuracy
  correlation math. Currently reports the count of auto-applied verdicts
  only. Don't add a noise threshold here until the math is in.

- `voice_gate_health` — warns when voice-gate failure rate >= 30% over
  the last 7 days. Hint: review the gate rubric.

## Auto-resolve posture

Auto-resolve is DISABLED by default. The operator flips it on once they
trust the judge's verdicts. Thresholds:

- Single-model path: confidence >= 0.95
- Ensemble path: 3/3 unanimous AND min confidence >= 0.85
- 'unresolvable' verdict NEVER auto-applies even at confidence=1.0

These are MONOTONIC TIGHTENING ONLY. Never LOWER an active threshold
without explicit operator sign-off — relaxing after data accumulates
silently shifts which historical resolutions count as auto-applied.

The judge runs on the utility tier (Haiku); disputed or high-stakes
verdicts escalate to the synthesis tier (Sonnet). See
`conventions/model-routing.md`.

## Single-brain semantics

There is one brain and one operator, so there is no cross-instance profile
fallback and no "from mounted brain" attribution. `get_calibration_profile`
always answers from the local brain. If it returns empty, the profile
hasn't been generated yet — say so plainly rather than inventing a track
record. Subagents you spawn read the same single profile; no special
scoping applies.

## Test seams

Every calibration module accepts test injection via opts (judge, think
runner, extractor, evidence retriever, voice-gate judge). Tests MUST use
these seams. Never mock the LLM gateway module globally from a calibration
unit test — module-level mocks leak across test files in the shard process
and turn green-local into red-CI.

## Bug class to avoid

The canonical bug pattern this loop has structural defense against is
scope leakage: a calibration read or write that bypasses the standard
operation context and touches rows it shouldn't. If you find yourself
wanting raw SQL against calibration tables instead of the
`get_calibration_profile` / `takes_*` tools, you've found the bug. Stop,
route through the tools — they carry the scoping, versioning, and audit
behavior the raw query would skip.
