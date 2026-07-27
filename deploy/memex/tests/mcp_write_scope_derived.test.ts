/**
 * WRITE_SCOPED_TOOLS is now DERIVED from each op's `scope: "write"` field
 * (operations.ts) instead of a hand-kept list in dispatch.ts. This is a
 * security-critical set — a write tool missing from it would be callable by a
 * public principal with no write grant. This test PINS the derived set to the
 * exact golden roster so a mis-tag (a write op left `scope`-less, or a read op
 * tagged write) fails loud. The golden list is the write set as of the port; add
 * to it deliberately when a new write tool ships.
 */
import { describe, it, expect } from "bun:test";
import { OPERATIONS, WRITE_SCOPED_TOOLS } from "../src/mcp/operations.ts";

// Byte-for-byte the pre-port hand-maintained set from dispatch.ts. Behavior is
// unchanged iff the derived set equals this exactly.
const GOLDEN_WRITE_TOOLS = [
  "index",
  "page_put",
  "page_append",
  "page_delete",
  "page_restore",
  "page_revert",
  "link",
  "unlink",
  "add_tag",
  "remove_tag",
  "add_fact",
  "add_timeline_event",
  "forget_fact",
  "purge_deleted_pages",
  "set_take_status",
  // Stage-2 additions (deliberate): think can persist synthesis pages/takes,
  // put_raw_data writes the sidecar, retry_job mutates job state.
  "think",
  "put_raw_data",
  "retry_job",
  // log_ingest appends an ingestion-event row to the audit log, stamped with
  // the caller's write source — a mutation, correctly scope:"write".
  "log_ingest",
  // extract_facts runs the paid Bedrock extractor even in preview and can
  // persist to the entity_facts ledger; the whole op is marked write, so a
  // read-scoped token cannot reach the paid path.
  "extract_facts",
  // ontology_propose writes a dimensional observation to entity_facts;
  // chronicle_backfill enqueues paid extraction jobs (also operator-only).
  "ontology_propose",
  "chronicle_backfill",
  // log_friction appends a friction_events row and carries no source axis;
  // reachable by a token principal since the internal-token wall stopped
  // covering authenticated callers, so it needs the write scope.
  "log_friction",
].sort();

describe("WRITE_SCOPED_TOOLS derivation (security-critical)", () => {
  it("derived set equals the golden write roster exactly (no drift)", () => {
    expect([...WRITE_SCOPED_TOOLS].sort()).toEqual(GOLDEN_WRITE_TOOLS);
  });

  it("every op tagged scope:'write' is a real registered op (no phantom)", () => {
    const names = new Set(OPERATIONS.map((o) => o.name));
    for (const w of WRITE_SCOPED_TOOLS) expect(names.has(w)).toBe(true);
  });

  it("no op outside the golden roster is silently tagged write", () => {
    const golden = new Set(GOLDEN_WRITE_TOOLS);
    for (const op of OPERATIONS) {
      if (op.scope === "write") expect(golden.has(op.name)).toBe(true);
    }
  });
});
