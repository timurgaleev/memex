/**
 * link-verb-infer.ts — deterministic (LLM-free) verb-context inference of a
 * wikilink edge's TYPE from the prose around the mention.
 *
 * Faithful port of the reference's `inferLinkType`. memex resolves a
 * `[[target]]` wikilink to a slug and writes `type='wikilink'`; with verb
 * inference ON (opt-in, `MEMEX_LINK_VERB_INFER=1`), the ~240-char window around
 * the mention is scanned for employment / investment / founder / advisor verbs
 * and the edge is upgraded to the matching typed relationship
 * (`works_at` / `invested_in` / `founded` / `advises`). When no verb matches it
 * stays `mentions` (the caller keeps `wikilink`).
 *
 * Two layers, exactly as the reference:
 *   1. Per-edge: explicit verbs in the local window
 *      (FOUNDED > INVESTED > ADVISES > WORKS_AT).
 *   2. Page-role prior: when the per-edge pass falls through, a person page
 *      whose body describes the subject as a partner/investor, advisor, or
 *      employee biases its outbound `companies/*` refs
 *      (PARTNER > ADVISOR > EMPLOYEE).
 *
 * The regexes are copied verbatim from the reference (calibrated against a
 * rich-prose corpus); only the surrounding plumbing is memex's.
 */

// Employment context: position + at/of, or explicit work verbs.
const WORKS_AT_RE =
  /\b(?:CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|VPs? Product|works at|worked at|working at|employed by|employed at|joined as|joined the team|engineer at|engineer for|director at|director of|head of|heads up .{0,20} at|leads engineering|leads product|leads the .{0,20} (?:team|org) at|manages engineering at|manages product at|running (?:engineering|product|design) at|currently at|previously at|previously worked at|spent .* (?:years|months) at|stint at|stint as|tenure at|tenure as|role at|position at|(?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security) engineer at|promoted to (?:senior|staff|principal|lead) .{0,20} at|(?:his|her|their|my) time at)\b/i;

// Investment context (most-specific → least).
const INVESTED_RE =
  /\b(?:invested in|invests in|investing in|invest in|investment in|investments in|backed by|funding from|funded by|raised from|led the (?:seed|Series|round|investment|round)|led .{0,30}(?:Series [A-Z]|seed|round|investment)|participated in (?:the )?(?:seed|Series|round)|wrote (?:a |the )?check|first check|early investor|portfolio (?:company|includes)|board seat (?:at|in|on)|term sheet for)\b/i;

// Founder patterns (incl. noun forms).
const FOUNDED_RE =
  /\b(?:founded|co-?founded|started the company|incorporated|founder of|founders? (?:include|are)|the founder|is a co-?founder|is one of the founders)\b/i;

// Advise context: rooted in "advisor"/"advise" (investors also sit on boards).
const ADVISES_RE =
  /\b(?:advises|advised|advisor (?:to|at|for|of)|advisory (?:board|role|position|capacity|engagement|partnership|contract|relationship|work)|board advisor|on .{0,20} advisory board|joined .{0,20} advisory board|in an? advisory (?:capacity|role|position)|as an? (?:advisor|security advisor|technical advisor|strategic advisor|industry advisor|product advisor|board advisor|senior advisor)|(?:strategic|technical|security|product|industry|senior|board) advisor (?:to|at|for|of)|consults for|consulting role (?:at|with))\b/i;

// Page-level priors.
const PARTNER_ROLE_RE =
  /\b(?:partner at|partner of|venture partner|VC partner|invested early|investor at|investor in|portfolio|venture capital|early-stage investor|seed investor|fund [A-Z]|invests across|backs companies)\b/i;
const ADVISOR_ROLE_RE =
  /\b(?:full-time advisor|professional advisor|advises (?:multiple|several|various)|is an? (?:advisor|security advisor|technical advisor|strategic advisor|industry advisor|product advisor|senior advisor)|took on advisory roles|(?:her|his|their) advisory (?:work|role|engagement|portfolio)|serves as (?:an )?advisor)\b/i;
const EMPLOYEE_ROLE_RE =
  /\b(?:is an? (?:senior|staff|principal|lead|backend|frontend|full-?stack|ML|data|security|DevOps|platform)? ?engineer at|is an? (?:senior|staff|principal|lead)? ?(?:developer|designer|product manager|engineering manager|director|VP) (?:at|of)|holds? the (?:CTO|CEO|CFO|COO|CMO|CRO|VP) (?:role|position|seat|title) at|is the (?:CTO|CEO|CFO|COO|CMO|CRO) of|employee at|on the team at|works on .{0,30} at)\b/i;

/** The edge types verb inference can produce (plus the `mentions` fallback). */
export type InferredLinkType = "founded" | "invested_in" | "advises" | "works_at" | "attended" | "mentions";

/**
 * Infer a wikilink edge's type from page context. Deterministic, no LLM.
 * Faithful to the reference's `inferLinkType`:
 *   - per-edge window verbs: founded > invested_in > advises > works_at;
 *   - then a person→company page-role prior: investor > advisor > employee;
 *   - else `mentions`.
 * `pageType` is the SOURCE page's type, `context` the per-edge window,
 * `globalContext` the full body (for the prior), `targetSlug` the resolved edge
 * target (the prior only fires for `companies/*` targets).
 */
export function inferLinkType(
  pageType: string,
  context: string,
  globalContext?: string,
  targetSlug?: string,
): InferredLinkType {
  if (pageType === "media") return "mentions";
  if (pageType === "meeting") return "attended";

  // Per-edge verb rules.
  if (FOUNDED_RE.test(context)) return "founded";
  if (INVESTED_RE.test(context)) return "invested_in";
  if (ADVISES_RE.test(context)) return "advises";
  if (WORKS_AT_RE.test(context)) return "works_at";

  // Page-role prior — only person → companies/* links. Precedence within
  // priors: investor > advisor > employee (investors also sit on boards).
  if (pageType === "person" && globalContext && targetSlug?.startsWith("companies/")) {
    if (PARTNER_ROLE_RE.test(globalContext)) return "invested_in";
    if (ADVISOR_ROLE_RE.test(globalContext)) return "advises";
    if (EMPLOYEE_ROLE_RE.test(globalContext)) return "works_at";
  }
  return "mentions";
}

/**
 * The ~240-char window around the FIRST occurrence of a `[[surface]]` mention
 * in the body — the per-edge context the reference feeds `inferLinkType`. The
 * wider window (vs the original 80) catches verbs that sit a clause away in
 * narrative prose. Returns the whole body when the surface isn't found
 * (defensive — the caller resolved it from this body).
 */
export function edgeContextWindow(body: string, surface: string, radius = 240): string {
  const idx = body.indexOf(surface);
  if (idx < 0) return body;
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + surface.length + radius);
  return body.slice(start, end);
}

/** Whether verb-context link-type inference is enabled (opt-in, default OFF). */
export function linkVerbInferEnabled(): boolean {
  return process.env["MEMEX_LINK_VERB_INFER"] === "1";
}
