---
name: soul-audit
version: 1.0.0
description: |
  6-phase interactive interview that generates the agent's identity
  (identity/soul), operator profile (identity/user), access posture
  (identity/access-policy), and operational cadence (identity/heartbeat)
  as brain pages. Re-runnable anytime to update any section.
triggers:
  - "soul audit"
  - "customize agent"
  - "who am I"
  - "set up identity"
  - "change my agent's personality"
tools:
  - page_put
  - page_get
  - get_brain_identity
  - whoami
mutating: true
writes_pages: true
writes_to:
  - identity/
---

# Soul Audit — Agent Identity Builder

Generate the agent's identity and operational configuration through an interactive
interview. Each phase produces a brain page. Any phase can be re-run independently
to update. The `get_brain_identity` tool serves these pages back to any connected
agent, so what you write here shapes every future session.

**IMPORTANT:** This skill generates content from the OPERATOR'S OWN ANSWERS. It
NEVER ships pre-filled content. The minimal scaffolds in Default Mode are
skeletons, not defaults.

## Contract

This skill guarantees:
- `identity/soul` generated from the operator's description of agent identity, vibe, mission
- `identity/user` generated from the operator's self-description (role, projects, key people)
- `identity/access-policy` generated with an explicit access posture
- `identity/heartbeat` generated with the operational cadence the operator chooses
- Each phase is independent and re-runnable
- Default mode (skip soul-audit): writes minimal scaffold pages via `page_put`

## Phases

### Phase 1: Identity Interview
Ask: "What is this agent to you? Research partner? Executive assistant? Thinking partner? All of the above?"
Generate: `identity/soul` identity section (`page_put`).

### Phase 2: Vibe Calibration
Show 3-4 communication style examples:
- **Formal:** "I've prepared a comprehensive analysis of the situation..."
- **Direct:** "Here's what's happening. Three things matter."
- **Technical:** "The root cause is in the connection pooling. Here's the fix."
- **Casual:** "Yeah so basically the thing is broken because X. Easy fix."
Ask which feels right. Generate: `identity/soul` vibe + communication style sections.

### Phase 3: Mission Mapping
Ask: "What are your top 3-5 goals? What are you trying to accomplish?"
Generate: `identity/soul` mission + operating principles sections.

### Phase 4: Operator Profile
Ask: "Tell me about yourself. What do you do? What are you working on? Who are the key people in your world?"
Generate: `identity/user` with role, projects, key people, communication preferences.

### Phase 5: Boundaries
This is a one-operator brain, but it has two ingress surfaces: the internal MCP
surface (full tool roster) and the public MCP surface (redacted reads plus a
constrained write set). Ask: "What should the public surface be allowed to see
or write? Anything that must stay internal-only?"
Generate: `identity/access-policy` documenting the posture — what each surface
is for, what never leaves the internal side, and any content classes agents
should refuse to surface publicly. Note: enforcement lives in the server's
ingress config; this page is the human-readable policy agents follow.

### Phase 6: Operational Cadence
Ask: "How often should the agent check in? Morning briefing? End of day summary? What recurring work do you want?"
Generate: `identity/heartbeat` with the cadence. Recurring server-side
maintenance is already covered by the brain's background cycle; extra recurring
work is scheduled operator-side (systemd timers on the host) or via the agent
harness's own scheduler — record the chosen cadence on the page either way.

## Default Mode (Skip Soul-Audit)

If the operator skips soul-audit on first boot:
- Write `identity/soul` as a minimal scaffold ("knowledge-first agent with persistent memory")
- Write `identity/user` auto-populated with the operator identity from `whoami`
- Write `identity/access-policy` as owner-only / internal-surface-first
- Write `identity/heartbeat` with the default cadence (rely on the brain's cycle)

## Output Format

Four brain pages generated/updated. Report: "Soul audit complete: identity/soul,
identity/user, identity/access-policy, identity/heartbeat written. Re-run any
phase anytime to update."

## Anti-Patterns

- Shipping pre-filled soul or user content (privacy violation)
- Making soul-audit mandatory on first boot (high friction, optional is better)
- Asking all 6 phases in one go (overwhelming, each is independent)
- Not offering to re-run individual phases
