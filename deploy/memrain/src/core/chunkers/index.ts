/**
 * Chunkers — split source content into retrievable units.
 *
 * `recursive` is the production chunker for markdown today. `code` and
 * `semantic` are placeholders for future content types and throw when
 * called.
 */
export { chunkMarkdown, parseFrontmatter } from "./recursive.ts";
export type { ChunkedDocument, ChunkerOptions } from "./recursive.ts";
