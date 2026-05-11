/**
 * Semantic chunker — would use an LLM to find topical breakpoints in
 * very long, unstructured prose. We rely on markdown headings + size
 * bounds for now, which works well for vault notes; this stub is a
 * placeholder for the future content types.
 */
export function chunkSemantic(_md: string): never {
  throw new Error(
    "core/chunkers/semantic: not implemented yet. Use chunkMarkdown (recursive).",
  );
}
