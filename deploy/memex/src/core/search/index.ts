/**
 * Search public surface.
 */
export { hybridSearch } from "./hybrid.ts";
export type { SearchHit, SearchOptions } from "./hybrid.ts";
export { vectorSearch } from "./vector.ts";
export { keywordSearch } from "./keyword.ts";
export { dedupByDocument, type ChunkScore } from "./dedup.ts";
export { applySourceBoost } from "./source-boost.ts";
export { classifyIntent, VALID_INTENTS, type Intent } from "./intent.ts";
export { expandQuery } from "./expansion.ts";
export { rerank } from "./two-pass.ts";
