/**
 * What each tool's response is shaped like, and a version for that shape.
 *
 * The INPUT side is already pinned: TOOL_DEFS is generated from OPERATIONS and
 * a frozen snapshot fails the build when a schema moves. The output side had
 * neither — every handler hand-built its object at the call site, so a renamed
 * or dropped key would ship silently and a client would discover it in
 * production.
 *
 * This is deliberately a registry of REQUIRED TOP-LEVEL KEYS, not a full JSON
 * Schema. The keys are the part a client destructures and the part a refactor
 * quietly breaks; validating every nested field would be a second contract to
 * maintain, and the one that drifts is the one nobody reads.
 *
 * `MEMEX_RESPONSE_VERSION` is separate from the MCP `protocolVersion` reported
 * at initialize: that one pins the transport, this one pins what memex puts
 * inside the result. Bump it when a registered shape changes in a way a client
 * cannot ignore — a removed or renamed key, not an added optional one.
 *
 * SCOPE, stated plainly because a version that implies more than it covers is
 * worse than none: this pins the REGISTERED shapes below, not all 91 tools. A
 * breaking change to an unregistered tool will not force a bump, so a client
 * reading the version is entitled to rely on these tools and nothing else.
 * Registering a tool is what brings it under the version — and the conformance
 * test refuses a registration that has no way to be exercised.
 */

/** Bump on a breaking change to any registered response shape. */
export const MEMEX_RESPONSE_VERSION = 1;

/**
 * Tool name → keys its successful response always carries.
 *
 * Optional keys (a hint, a budget report, a nullable page) are deliberately
 * absent: a client may not rely on them, so pinning them would freeze
 * behaviour that is meant to vary.
 */
export const RESPONSE_SHAPES: ReadonlyMap<string, readonly string[]> = new Map([
  ["search", ["ok", "hits"]],
  ["query", ["ok", "hits"]],
  ["stats", ["ok", "documents", "chunks", "embeddings", "page_types"]],
  ["entity_recall", ["ok", "page", "facts", "timeline"]],
  ["entity_facts", ["ok", "entity_slug", "facts"]],
  ["add_fact", ["ok", "id", "entity_slug", "inserted"]],
  ["page_get", ["ok", "page"]],
  ["page_put", ["ok", "slug", "created", "changed", "version_n"]],
  ["page_list", ["ok", "pages"]],
  // Read from the handlers, not guessed: get_links groups its edges and
  // backlinks returns hits — both were registered wrong on the first pass
  // and the conformance test caught it before the registry could lie.
  ["get_links", ["ok", "slug", "groups"]],
  ["backlinks", ["ok", "name", "hits"]],
]);

/** Keys a registered response is missing, or [] when it conforms. */
export function missingResponseKeys(
  tool: string,
  payload: Record<string, unknown>,
): string[] {
  const required = RESPONSE_SHAPES.get(tool);
  if (required === undefined) return [];
  return required.filter((k) => !(k in payload));
}
