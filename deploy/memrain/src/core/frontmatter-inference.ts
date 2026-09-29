/**
 * Frontmatter inference — synthesize a YAML frontmatter header for a document
 * that has none, at INGEST time (per file).
 *
 * This runs ONCE per file in the import pipeline (a pure function over a single
 * `(path, content)`), NOT as a recurring cycle phase. memex previously had a
 * recurring DB cycle phase that scanned every document each tick — a design
 * that caused repeated OOM-SIGKILLs. `applyInference(path, content)` prepends
 * an inferred `---…---` block to the in-memory content before chunking; a file
 * that already has a leading `---` is returned untouched (skipped). It is wired
 * into `indexDocument` (the ingest path), so new content carries well-formed
 * frontmatter and no recurring full-corpus scan is needed.
 *
 * `DIRECTORY_RULES` ships EMPTY in this public repo — a populated table would
 * encode private vault folder names. The operator extends it locally for their
 * own vault conventions; the default rule (`{type:'note',
 * titleStrategy:'heading'}`) makes inference path-agnostic out of the box.
 */
import { basename } from "node:path";

export interface InferredFrontmatter {
  title: string;
  type: string;
  date?: string;
  source?: string;
  tags?: string[];
  /** True if the file already has frontmatter (inference skipped). */
  skipped?: boolean;
  /** The rule that matched, for debugging. */
  matchedRule?: string;
}

export interface DirectoryRule {
  /** Case-insensitive path prefix to match (e.g. 'meetings/'). */
  pathPrefix: string;
  type: string;
  source?: string;
  tags?: string[];
  datePattern?: "filename" | "dirname" | "none";
  titleStrategy?: "filename" | "heading" | "filename-full";
}

// Ordered most-specific-first; first match wins. EMPTY in the public repo — a
// populated table would name a private vault. Operators add their own conventions.
export const DIRECTORY_RULES: DirectoryRule[] = [];

const DEFAULT_RULE: DirectoryRule = {
  pathPrefix: "",
  type: "note",
  titleStrategy: "heading",
};

/** Extract a `YYYY-MM-DD` date from a filename, if present. */
export function extractDateFromFilename(filename: string): string | null {
  const m1 = filename.match(/^(\d{4}-\d{2}-\d{2})[\s_-]/);
  if (m1) return m1[1]!;
  const m2 = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[1]!;
  const m3 = filename.match(/^(\d{4})\s+(\d{2})\s+(\d{2})\s/);
  if (m3) return `${m3[1]}-${m3[2]}-${m3[3]}`;
  return null;
}

/** Title from filename: strip date prefix + extension, normalise case. */
export function extractTitleFromFilename(filename: string): string {
  let title = filename.replace(/\.md$/i, "");
  title = title.replace(/^\d{4}-\d{2}-\d{2}[\s_-]+/, "");
  title = title.replace(/^\d{4}\s+\d{2}\s+\d{2}\s+/, "");
  title = title.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  if (title === title.toLowerCase() || title === title.toUpperCase()) {
    title = title.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return title || "Untitled";
}

/** Title from the first `# heading` in the content's leading lines. */
export function extractTitleFromHeading(content: string): string | null {
  for (const line of content.split("\n").slice(0, 20)) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * Infer frontmatter for a doc that has none. Pure over `(relativePath, content)`.
 * Returns `{skipped:true}` when the content already starts with `---`.
 */
export function inferFrontmatter(
  relativePath: string,
  content: string,
): InferredFrontmatter {
  const firstNonEmpty = content.split("\n").find((l) => l.trim().length > 0);
  if (firstNonEmpty?.trim() === "---") {
    return { title: "", type: "", skipped: true };
  }

  const lowerPath = relativePath.toLowerCase();
  const filename = basename(relativePath);

  let matchedRule: DirectoryRule | undefined;
  for (const rule of DIRECTORY_RULES) {
    if (lowerPath.startsWith(rule.pathPrefix.toLowerCase())) {
      matchedRule = rule;
      break;
    }
  }
  if (!matchedRule) matchedRule = DEFAULT_RULE;

  let date: string | undefined;
  if ((matchedRule.datePattern ?? "filename") === "filename") {
    date = extractDateFromFilename(filename) ?? undefined;
  }

  let title: string;
  const titleStrategy = matchedRule.titleStrategy ?? "filename";
  if (titleStrategy === "heading") {
    title = extractTitleFromHeading(content) ?? extractTitleFromFilename(filename);
  } else if (titleStrategy === "filename-full") {
    title = filename.replace(/\.md$/i, "").replace(/[-_]/g, " ").trim();
  } else {
    title = extractTitleFromFilename(filename);
  }

  const tags = [...(matchedRule.tags ?? [])];

  return {
    title,
    type: matchedRule.type,
    date,
    source: matchedRule.source,
    tags: tags.length > 0 ? tags : undefined,
    matchedRule: matchedRule.pathPrefix || "(default)",
  };
}

/** Serialize inferred fields into a `---\n…\n---\n` block. Empty when skipped. */
export function serializeFrontmatter(fm: InferredFrontmatter): string {
  if (fm.skipped) return "";
  const lines: string[] = ["---"];
  const needsQuote = /[:"'#[\]{}|>&*!?,]/.test(fm.title);
  lines.push(`title: ${needsQuote ? JSON.stringify(fm.title) : fm.title}`);
  lines.push(`type: ${fm.type}`);
  if (fm.date) lines.push(`date: "${fm.date}"`);
  if (fm.source) lines.push(`source: ${fm.source}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(
      `tags: [${fm.tags
        .map((t) => (t.includes("'") ? JSON.stringify(t) : `'${t}'`))
        .join(", ")}]`,
    );
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Prepend inferred frontmatter to content that lacks it; return the original
 * untouched (with `skipped:true`) when it already has a header.
 */
export function applyInference(
  relativePath: string,
  content: string,
): { content: string; inferred: InferredFrontmatter } {
  const inferred = inferFrontmatter(relativePath, content);
  if (inferred.skipped) return { content, inferred };
  return { content: serializeFrontmatter(inferred) + "\n" + content, inferred };
}
