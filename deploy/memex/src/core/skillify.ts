/**
 * Skillify — generate a fully-formed skill `*.md` from a one-line prompt.
 *
 * Two pieces:
 *
 *   1. `draftSkill` calls Bedrock Claude Haiku (Converse API) to produce a
 *      first-pass markdown body. The model is steered with a system prompt
 *      that demands the exact frontmatter contract used by `deploy/skills/`.
 *   2. `lintAndShape` is a deterministic post-processor that guarantees
 *      the contract holds even if the model drifts. It rewrites
 *      missing/malformed fields, normalises tags, anchors the file to a
 *      stable slug, and emits a list of repairs.
 *
 * The deterministic linter is what makes the command safe to use unattended.
 * If it had to retry-LLM-on-failure the loop could hide model regressions.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { awsRegion } from "./llm/gateway.ts";
import { trackedInvoke } from "./budget.ts";

/** Ledger label — the one-shot skill drafter behind `memex skillify`. */
const SPEND_OP = "skillify";

const DEFAULT_MODEL_ID =
  process.env.SKILLIFY_MODEL_ID ?? "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_REGION = awsRegion();

let _defaultClient: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (_defaultClient === null) {
    _defaultClient = new BedrockRuntimeClient({ region: DEFAULT_REGION });
  }
  return _defaultClient;
}

export interface SkillifyOptions {
  /** Override the Bedrock client (tests pass a stub). */
  client?: BedrockRuntimeClient;
  /** Override the model id; default is Claude Haiku (Bedrock). */
  modelId?: string;
}

export interface SkillDraft {
  /** Final markdown ready to write. */
  markdown: string;
  /** Kebab-case slug, also the file's basename without `.md`. */
  slug: string;
  /** Descriptive issues the linter fixed (empty on a clean pass). */
  issues: string[];
}

/**
 * Convert a free-text prompt into a kebab-case slug.
 *   "Skill that summarises my last 5 workouts!" → "skill-that-summarises-my-last-5-workouts"
 * Caps at 60 chars to keep filenames sane.
 */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Measured linear through slugify: 2.0 ms at 2 M chars of `-` plus a
    // rejecting `x`, ratio 2.10 on a doubling. `-` is itself in `[^a-z0-9]`, so
    // the collapse on the line above leaves every hyphen run exactly one char
    // long — the run this quantifier needs to square on cannot reach it.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "skill";
  // Measured linear through slugify: 12.0 ms at 2 M chars of `a-`, ratio 1.89
  // on a doubling. Same collapse, and the 60-char slice caps it a second time.
  // eslint-disable-next-line regexp/no-super-linear-move
  return cleaned.slice(0, 60).replace(/-+$/g, "") || "skill";
}

/** System prompt — the contract the model must satisfy. */
const SYSTEM_PROMPT = `You write memex skill files.

OUTPUT FORMAT — strictly markdown, NO surrounding code fences, NO commentary:

---
title: <kebab-case slug, lowercase, hyphens only>
description: <one sentence, present tense, when-to-use>
tags: [<2–4 lowercase tags>]
---

# <Skill Name> — <punchy subtitle>

<2–3 sentences: what this skill does, when to invoke it.>

## When to use

- <bullet 1>
- <bullet 2>
- <bullet 3>

## How

\`\`\`bash
<concrete shell example using /opt/memex/bin/memex or similar>
\`\`\`

<short paragraph explaining the call.>

## Edge cases

- <what to do when input is empty / ambiguous>
- <what to do when the call fails>

RULES:
- description must be a single line, ≤ 160 chars.
- tags lowercase, no spaces.
- Use \`/opt/memex/bin/memex\` as the canonical CLI path.
- Do not invent flags or commands the user didn't mention.`;

/**
 * Build a draft skill markdown from a user prompt. Returns the raw model
 * output — `lintAndShape` is what guarantees shape compliance.
 */
export async function draftSkill(
  userPrompt: string,
  opts: SkillifyOptions = {},
): Promise<string> {
  if (!userPrompt || !userPrompt.trim()) {
    throw new Error("draftSkill: prompt must be a non-empty string");
  }
  const client = opts.client ?? getClient();
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;

  const command = new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [
          {
            text: `Generate a skill for this request:\n\n${userPrompt.trim()}`,
          },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 1500, temperature: 0.3 },
  });

  const text = await trackedInvoke({ operation: SPEND_OP, model: modelId }, async (meter) => {
    const response = await client.send(command);
    if (response.usage) {
      meter.report({
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
      });
    }
    return response.output?.message?.content?.[0]?.text;
  });
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("draftSkill: empty response from model");
  }
  return text.trim();
}

interface ParsedFrontmatter {
  raw: string;
  body: string;
  fields: Record<string, string>;
  rawTags: string | null;
}

/**
 * Best-effort frontmatter parse. We don't pull yaml here because the
 * frontmatter contract is fixed (title / description / tags) and we need
 * to be tolerant of mild model drift (trailing commas, mixed quotes).
 */
function parseFrontmatter(markdown: string): ParsedFrontmatter | null {
  // The opening fence's trailing run is horizontal-only. A plain `\s*` there
  // also accepts `\n`, so it and the lazy body could trade newlines: every
  // split of a `\n` run re-walked the body to end-of-input. Measured through
  // validateSkill on `"---" + "\n".repeat(n)`: 3.8 s at 125 K, 15 s at 250 K,
  // 59 s at 500 K, 242 s at 1 MB — ratio 4.0 on a doubling. `[^\S\n]` keeps
  // CRLF and trailing-space fences matching; the mandatory `\n` after it is
  // now the only place a newline can go, so there is nothing to trade.
  // The second `\s*` is a different story and safe: what follows it is
  // `([\s\S]*)$`, which cannot reject, so it never has to give a character
  // back. Measured linear through validateSkill on a valid block plus a
  // trailing `\n` run: 0.4 ms at 1 MB, ratio 1.91 on a doubling.
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const m = /^---[^\S\n]*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(markdown);
  if (!m) return null;
  const raw = m[1] ?? "";
  const body = m[2] ?? "";
  const fields: Record<string, string> = {};
  let rawTags: string | null = null;
  for (const line of raw.split("\n")) {
    // Measured linear through validateSkill: 1.0 ms for a 1 M-char `k:` plus a
    // space run, 2.1 ms for a 1 M-char key run with no colon, ratio 1.89 and
    // 2.36 on a doubling. `line` is a split on `\n`, so `\s*` and `.*` never
    // see one; and `(.*)$` cannot reject at end-of-line, so the `\s*` it is
    // said to trade with is never asked to give a character back.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const kv = /^([a-z_][\w-]*):\s*(.*)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = (kv[2] ?? "").trim();
    if (key === "tags") {
      rawTags = value;
    } else {
      fields[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { raw, body, fields, rawTags };
}

function normaliseTags(rawTags: string | null, fallback: string[]): string[] {
  if (!rawTags) return fallback;
  // Accept either inline list `[a, b]` or YAML block `- a\n- b` (block parsed
  // up-stream, only inline is reachable here).
  const inline = /^\[(.*)\]$/.exec(rawTags);
  const items = inline
    ? (inline[1] ?? "").split(",")
    : rawTags.split(",");
  const out = items
    .map((t) => t.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter((t) => t.length > 0 && /^[a-z0-9][a-z0-9-]*$/.test(t));
  return out.length > 0 ? out : fallback;
}

const MAX_DESCRIPTION = 160;

/**
 * Take a (possibly drifted) draft and return a strictly conformant skill
 * markdown. Always succeeds; reports what it had to repair via `issues`.
 */
export function lintAndShape(
  draft: string,
  slug: string,
  fallbackPrompt: string,
): { markdown: string; issues: string[] } {
  const issues: string[] = [];
  const parsed = parseFrontmatter(draft);

  let title = slug;
  let description = "";
  let tags: string[] = [];
  let body = "";

  if (!parsed) {
    issues.push("frontmatter-missing");
    body = draft;
  } else {
    body = parsed.body.trim();
    const fmTitle = parsed.fields["title"];
    if (!fmTitle || fmTitle !== slug) {
      if (fmTitle && fmTitle !== slug) issues.push("title-mismatch-corrected");
      title = slug;
    } else {
      title = fmTitle;
    }
    const fmDesc = parsed.fields["description"] ?? "";
    description = fmDesc.replace(/\s+/g, " ").trim();
    if (description.length === 0) {
      issues.push("description-missing");
      description = fallbackDescription(fallbackPrompt);
    } else if (description.length > MAX_DESCRIPTION) {
      issues.push("description-truncated");
      description = description.slice(0, MAX_DESCRIPTION - 1).trimEnd() + "…";
    }
    tags = normaliseTags(parsed.rawTags, ["skill"]);
    // Only flag when normalisation collapsed everything to the fallback —
    // routine cleanups (lowercasing, quote-strip) aren't worth the noise.
    if (parsed.rawTags && tags.length === 1 && tags[0] === "skill") {
      issues.push("tags-fallback");
    }
  }

  if (parsed === null) {
    description = fallbackDescription(fallbackPrompt);
    tags = ["skill"];
  }

  if (!body || body.length < 30) {
    issues.push("body-too-short");
    body = bodyScaffold(slug, fallbackPrompt);
  } else if (!/^#\s+\S/.test(body)) {
    issues.push("body-missing-heading");
    body = `# ${slug}\n\n${body}`;
  }

  const fm =
    `---\n` +
    `title: ${title}\n` +
    `description: ${description}\n` +
    `tags: [${tags.join(", ")}]\n` +
    `---\n\n`;

  return { markdown: fm + body.trim() + "\n", issues };
}

export interface SkillValidationIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

export interface SkillValidationReport {
  ok: boolean;
  slug: string;
  issues: SkillValidationIssue[];
}

/**
 * Pure validator for an existing skill markdown. No LLM, no rewrite —
 * the inverse of `lintAndShape`. Returns errors (contract violations)
 * and warnings (advisory). `--strict` mode in the CLI flips warnings
 * into a non-zero exit too; the function itself stays neutral.
 *
 * Rules:
 *   error  | frontmatter-missing       — leading `---` block absent
 *   error  | title-missing             — frontmatter.title empty
 *   error  | title-mismatch            — frontmatter.title ≠ <slug>
 *   error  | description-missing       — frontmatter.description empty
 *   warning| description-too-long      — description > 160 chars
 *   error  | tags-missing              — tags absent or unparseable
 *   warning| tags-non-canonical        — tags contain mixed case / spaces
 *   warning| body-missing-heading      — first body line is not `# …`
 *   warning| body-too-short            — body shorter than 30 chars
 */
export function validateSkill(
  markdown: string,
  slug: string,
): SkillValidationReport {
  const issues: SkillValidationIssue[] = [];
  const parsed = parseFrontmatter(markdown);
  if (!parsed) {
    issues.push({
      rule: "frontmatter-missing",
      severity: "error",
      message: "skill markdown must start with a `---` frontmatter block",
    });
    return { ok: false, slug, issues };
  }

  const title = parsed.fields["title"] ?? "";
  if (!title) {
    issues.push({
      rule: "title-missing",
      severity: "error",
      message: "frontmatter.title is required",
    });
  } else if (title !== slug) {
    issues.push({
      rule: "title-mismatch",
      severity: "error",
      message: `frontmatter.title='${title}' does not match expected slug='${slug}'`,
    });
  }

  const desc = (parsed.fields["description"] ?? "").trim();
  if (desc.length === 0) {
    issues.push({
      rule: "description-missing",
      severity: "error",
      message: "frontmatter.description is required (single line, ≤ 160 chars)",
    });
  } else if (desc.length > MAX_DESCRIPTION) {
    issues.push({
      rule: "description-too-long",
      severity: "warning",
      message: `frontmatter.description is ${desc.length} chars (max ${MAX_DESCRIPTION})`,
    });
  }

  if (parsed.rawTags === null) {
    issues.push({
      rule: "tags-missing",
      severity: "error",
      message: "frontmatter.tags is required (inline array of lowercase tags)",
    });
  } else {
    const normalised = normaliseTags(parsed.rawTags, []);
    if (normalised.length === 0) {
      issues.push({
        rule: "tags-missing",
        severity: "error",
        message: "frontmatter.tags parsed to zero valid lowercase tokens",
      });
    } else {
      // Compare to the original spelling — flag if normalisation altered any token.
      const inline = /^\[(.*)\]$/.exec(parsed.rawTags);
      const raw = (inline ? inline[1]! : parsed.rawTags)
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter((t) => t.length > 0);
      const drift = raw.some((t, i) => normalised[i] !== t);
      if (drift) {
        issues.push({
          rule: "tags-non-canonical",
          severity: "warning",
          message: `tags contain non-canonical tokens (lowercase, [a-z0-9-]+): ${raw.join(", ")}`,
        });
      }
    }
  }

  const body = parsed.body.trim();
  if (body.length < 30) {
    issues.push({
      rule: "body-too-short",
      severity: "warning",
      message: `body is ${body.length} chars (minimum 30)`,
    });
  } else if (!/^#\s+\S/.test(body)) {
    issues.push({
      rule: "body-missing-heading",
      severity: "warning",
      message: "body should start with a `# Heading` line",
    });
  }

  const ok = !issues.some((i) => i.severity === "error");
  return { ok, slug, issues };
}

function fallbackDescription(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "TODO: describe when to use this skill";
  return trimmed.length > MAX_DESCRIPTION
    ? trimmed.slice(0, MAX_DESCRIPTION - 1) + "…"
    : trimmed;
}

function bodyScaffold(slug: string, prompt: string): string {
  return `# ${slug}

TODO: ${prompt}

## When to use

- TODO: describe the trigger
- TODO: describe a second trigger

## How

\`\`\`bash
/opt/memex/bin/memex --help
\`\`\`

TODO: replace with the real call.

## Edge cases

- TODO: empty / missing input
- TODO: external call fails`;
}

/**
 * End-to-end: prompt → drafted markdown → linted markdown.
 * `prompt` is the user's free-text request; `slug` defaults to a
 * slugified prompt but can be overridden.
 */
export async function skillify(
  prompt: string,
  opts: SkillifyOptions & { slug?: string } = {},
): Promise<SkillDraft> {
  const slug = opts.slug ?? slugify(prompt);
  const draft = await draftSkill(prompt, opts);
  const { markdown, issues } = lintAndShape(draft, slug, prompt);
  return { markdown, slug, issues };
}
