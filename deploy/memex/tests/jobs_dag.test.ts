/**
 * Jobs DAG tests (Phase A.4).
 *
 * Covers idempotent submit (returns existing row on duplicate
 * (kind, idempotency_key)), parent->child fan-out persistence,
 * depth inheritance, depth cap, child_done_inbox write/drain
 * semantics, cascade cancel of pending descendants, and the
 * jobs_logs compact shape.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  cancelJob,
  drainDoneInbox,
  getJob,
  listChildren,
  listJobs,
  submitJob,
  writeChildDoneInbox,
} from "../src/core/jobs/dag.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-dag-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// submitJob — simple + idempotent
// ---------------------------------------------------------------------------

describe("submitJob", () => {
  it("creates a pending job with depth=0 when no parent", async () => {
    const r = await submitJob(storage.engine(), {
      kind: "test.kind",
      payload: { x: 1 },
    });
    expect(r.inserted).toBe(true);
    expect(r.depth).toBe(0);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects missing kind", async () => {
    await expect(
      submitJob(storage.engine(), { kind: "" as unknown as string }),
    ).rejects.toThrow();
  });

  it("is idempotent on (kind, idempotency_key)", async () => {
    const a = await submitJob(storage.engine(), {
      kind: "gmail.ingest",
      payload: { msg: "abc" },
      idempotency_key: "gmail/abc",
    });
    const b = await submitJob(storage.engine(), {
      kind: "gmail.ingest",
      payload: { msg: "abc" },
      idempotency_key: "gmail/abc",
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it("different kinds with the same idempotency_key coexist", async () => {
    const a = await submitJob(storage.engine(), {
      kind: "kind.a",
      idempotency_key: "same",
    });
    const b = await submitJob(storage.engine(), {
      kind: "kind.b",
      idempotency_key: "same",
    });
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// Fan-out (parent + children)
// ---------------------------------------------------------------------------

describe("fan-out", () => {
  it("child inherits depth=parent.depth+1", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    expect(child.depth).toBe(1);
  });

  it("records the child in job_children", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const c1 = await submitJob(storage.engine(), {
      kind: "c1",
      parent_job_id: parent.id,
    });
    const c2 = await submitJob(storage.engine(), {
      kind: "c2",
      parent_job_id: parent.id,
    });
    const children = await listChildren(storage.engine(), parent.id);
    expect(children.length).toBe(2);
    const ids = children.map((c) => c.child_id).sort();
    expect(ids).toEqual([c1.id, c2.id].sort());
  });

  it("rejects parent that does not exist", async () => {
    await expect(
      submitJob(storage.engine(), {
        kind: "c",
        parent_job_id: "00000000-0000-0000-0000-deadbeefdead",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("refuses fan-out from a terminal parent", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    await storage
      .engine()
      .query("UPDATE jobs SET status = 'succeeded' WHERE id = $1", [parent.id]);
    await expect(
      submitJob(storage.engine(), { kind: "c", parent_job_id: parent.id }),
    ).rejects.toThrow(/terminal/);
  });

  it("depth cap enforced (>32 rejected)", async () => {
    // Manufacture a long chain via depth manipulation in the DB to
    // exercise the cap quickly without 33 round-trips.
    const p = await submitJob(storage.engine(), { kind: "deep" });
    await storage
      .engine()
      .query("UPDATE jobs SET depth = 32 WHERE id = $1", [p.id]);
    await expect(
      submitJob(storage.engine(), { kind: "c", parent_job_id: p.id }),
    ).rejects.toThrow(/depth.*32/);
  });
});

// ---------------------------------------------------------------------------
// child_done_inbox
// ---------------------------------------------------------------------------

describe("child_done_inbox", () => {
  it("writeChildDoneInbox + drainDoneInbox round-trip", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "succeeded", {
      out: 42,
    });
    const inbox = await drainDoneInbox(storage.engine(), parent.id);
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.child_id).toBe(child.id);
    expect(inbox[0]!.child_status).toBe("succeeded");
    expect(inbox[0]!.result_excerpt).toBe(JSON.stringify({ out: 42 }));
  });

  it("drain marks rows as read (subsequent drains are empty)", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "succeeded", null);
    const first = await drainDoneInbox(storage.engine(), parent.id);
    const second = await drainDoneInbox(storage.engine(), parent.id);
    expect(first.length).toBe(1);
    expect(second.length).toBe(0);
  });

  it("peek (mark_read=false) does not consume", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "succeeded", null);
    const peek1 = await drainDoneInbox(storage.engine(), parent.id, { mark_read: false });
    const peek2 = await drainDoneInbox(storage.engine(), parent.id, { mark_read: false });
    expect(peek1.length).toBe(1);
    expect(peek2.length).toBe(1);
  });

  it("excerpt truncates oversized results to 8KB", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    const huge = "x".repeat(20000);
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "failed", huge);
    const inbox = await drainDoneInbox(storage.engine(), parent.id);
    expect(inbox[0]!.result_excerpt!.length).toBe(8192);
  });

  it("re-writing the same (parent, child) is write-once (first wins)", async () => {
    // Jobs transition into a terminal state exactly once. A worker
    // retrying writeChildDoneInbox after a crash must observe that
    // the first write stuck; later writes are no-ops. This protects
    // the audit chain from a buggy handler that calls
    // markComplete(..., "succeeded") and then markComplete(..., "failed").
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "succeeded", "v1");
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "failed", "v2");
    const inbox = await drainDoneInbox(storage.engine(), parent.id);
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.child_status).toBe("succeeded");
    // String inputs round-trip as raw text (no JSON-encoding) -- the
    // helper only stringifies non-string inputs.
    expect(inbox[0]!.result_excerpt).toBe("v1");
  });

  it("truncates 8KB+ excerpts on a UTF-8 boundary (no replacement chars)", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    // Construct a string of 4-byte emoji that lands the 8192-byte
    // boundary inside a multi-byte sequence.
    const emoji = "\u{1F600}"; // 4 bytes UTF-8 each
    const huge = emoji.repeat(3000);
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "failed", huge);
    const inbox = await drainDoneInbox(storage.engine(), parent.id);
    const excerpt = inbox[0]!.result_excerpt!;
    // No U+FFFD replacement characters from broken UTF-8.
    expect(excerpt.includes("�")).toBe(false);
    // Length bounded under 8192 bytes (in UTF-8 form).
    expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(8192);
  });
});

// ---------------------------------------------------------------------------
// cancelJob — cascade behaviour
// ---------------------------------------------------------------------------

describe("cancelJob", () => {
  it("cancels a pending job (no children)", async () => {
    const j = await submitJob(storage.engine(), { kind: "k" });
    const r = await cancelJob(storage.engine(), j.id);
    expect(r.cancelled_ids).toContain(j.id);
    const fresh = await getJob(storage.engine(), j.id);
    expect(fresh?.status).toBe("cancelled");
  });

  it("cascade cancels pending descendants", async () => {
    const root = await submitJob(storage.engine(), { kind: "root" });
    const c1 = await submitJob(storage.engine(), {
      kind: "c1",
      parent_job_id: root.id,
    });
    const c2 = await submitJob(storage.engine(), {
      kind: "c2",
      parent_job_id: root.id,
    });
    const gc = await submitJob(storage.engine(), {
      kind: "gc",
      parent_job_id: c1.id,
    });
    const r = await cancelJob(storage.engine(), root.id);
    expect(r.cancelled_ids.sort()).toEqual(
      [root.id, c1.id, c2.id, gc.id].sort(),
    );
  });

  it("does not touch already-terminal jobs", async () => {
    const root = await submitJob(storage.engine(), { kind: "root" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: root.id,
    });
    await storage
      .engine()
      .query("UPDATE jobs SET status='succeeded' WHERE id = $1", [child.id]);
    const r = await cancelJob(storage.engine(), root.id);
    expect(r.cancelled_ids).toContain(root.id);
    expect(r.cancelled_ids).not.toContain(child.id);
  });

  it("cascade=false leaves descendants alone", async () => {
    const root = await submitJob(storage.engine(), { kind: "root" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: root.id,
    });
    const r = await cancelJob(storage.engine(), root.id, { cascade: false });
    expect(r.cancelled_ids).toEqual([root.id]);
    const fresh = await getJob(storage.engine(), child.id);
    expect(fresh?.status).toBe("pending");
  });

  it("cascade hits the 10k cap and aborts cleanly", async () => {
    // Build a wide fan-out (one parent, N children) that exceeds the
    // cap. Use a high-N fan-out instead of deep recursion so we
    // exercise the cap path without the depth-32 guard tripping
    // first.
    const root = await submitJob(storage.engine(), { kind: "wide" });
    // Insert children via raw SQL for speed — submitJob is correct
    // but does N round-trips. Need 10_001 rows to trip the cap.
    const ids: string[] = [];
    for (let i = 0; i < 10_001; i++) ids.push(`child-${i}`);
    // Single multi-row INSERT for jobs + job_children.
    const valuesJobs = ids
      .map((_id, i) => `($${i + 1}, 'c', '{}'::jsonb, 'pending')`)
      .join(",");
    await storage
      .engine()
      .query(
        `INSERT INTO jobs (id, kind, payload, status) VALUES ${valuesJobs}`,
        ids,
      );
    const valuesChildren = ids
      .map((_id, i) => `($${ids.length + 1}, $${i + 1})`)
      .join(",");
    await storage
      .engine()
      .query(
        `INSERT INTO job_children (parent_id, child_id) VALUES ${valuesChildren}`,
        [...ids, root.id],
      );
    await expect(cancelJob(storage.engine(), root.id)).rejects.toThrow(
      /cascade exceeds 10000/,
    );
  });

  it("BFS terminates on cyclic job_children rows (idempotency-link case)", async () => {
    // Pathological case: the idempotency path in submitJob can attach
    // an existing job to a new parent, which means job_children may
    // contain cycles. The cancel BFS must terminate via the visited
    // set rather than infinite-loop.
    const a = await submitJob(storage.engine(), { kind: "a" });
    const b = await submitJob(storage.engine(), {
      kind: "b",
      parent_job_id: a.id,
    });
    // Insert a manual edge b -> a, creating a cycle a -> b -> a.
    await storage
      .engine()
      .query(
        "INSERT INTO job_children (parent_id, child_id) VALUES ($1, $2)",
        [b.id, a.id],
      );
    const r = await cancelJob(storage.engine(), a.id);
    // Both nodes cancelled; no infinite loop, no thrown safety cap.
    expect(r.cancelled_ids.sort()).toEqual([a.id, b.id].sort());
  });
});

// ---------------------------------------------------------------------------
// listJobs / getJob
// ---------------------------------------------------------------------------

describe("list + get", () => {
  it("listJobs filters by status + kind", async () => {
    await submitJob(storage.engine(), { kind: "a" });
    await submitJob(storage.engine(), { kind: "b" });
    const a = await submitJob(storage.engine(), { kind: "a" });
    await storage
      .engine()
      .query("UPDATE jobs SET status='succeeded' WHERE id = $1", [a.id]);
    const pending = await listJobs(storage.engine(), { status: "pending" });
    expect(pending.length).toBe(2);
    const kindA = await listJobs(storage.engine(), { kind: "a" });
    expect(kindA.length).toBe(2);
  });

  it("getJob returns children + unread inbox count", async () => {
    const parent = await submitJob(storage.engine(), { kind: "p" });
    const child = await submitJob(storage.engine(), {
      kind: "c",
      parent_job_id: parent.id,
    });
    await writeChildDoneInbox(storage.engine(), parent.id, child.id, "succeeded", null);
    const detail = await getJob(storage.engine(), parent.id);
    expect(detail).not.toBeNull();
    expect(detail!.children.length).toBe(1);
    expect(detail!.inbox_unread).toBe(1);
  });

  it("getJob returns null for unknown id", async () => {
    const r = await getJob(storage.engine(), "missing");
    expect(r).toBeNull();
  });
});
