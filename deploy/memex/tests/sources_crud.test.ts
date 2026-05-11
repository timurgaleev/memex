/**
 * Tests for the sources expansion (migration 012):
 *   - new fields (rate_limit_per_minute, respect_quiet_hours,
 *     boost_weight, description) round-trip through register / get / list
 *   - new kind 'code' is admitted
 *   - updateSource patches only the fields you pass
 *   - deleteSource refuses while documents reference the row
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  registerSource,
  listSources,
  getSource,
  updateSource,
  deleteSource,
} from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-sources-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("registerSource + getSource", () => {
  it("round-trips all fields with defaults filled in", async () => {
    const e = storage.engine();
    const row = await registerSource(e, {
      id: "vault",
      kind: "vault",
      pathPrefix: "/vault/",
    });
    expect(row.kind).toBe("vault");
    expect(row.sync_policy).toBe("synced");
    expect(row.indexed_policy).toBe("verbatim");
    expect(row.rate_limit_per_minute).toBe(60);
    expect(row.respect_quiet_hours).toBe(false);
    expect(row.boost_weight).toBe(1);
    expect(row.description).toBeNull();
  });

  it("persists the new fields", async () => {
    const e = storage.engine();
    await registerSource(e, {
      id: "gmail",
      kind: "mailbox",
      pathPrefix: "/vault/inbox/gmail/",
      rateLimitPerMinute: 4,
      respectQuietHours: true,
      boostWeight: 0.6,
      description: "primary mailbox; ingested hourly",
    });
    const row = await getSource(e, "gmail");
    expect(row?.rate_limit_per_minute).toBe(4);
    expect(row?.respect_quiet_hours).toBe(true);
    expect(row?.boost_weight).toBe(0.6);
    expect(row?.description).toBe("primary mailbox; ingested hourly");
  });

  it("admits the new 'code' kind", async () => {
    const row = await registerSource(storage.engine(), {
      id: "openclaw-code",
      kind: "code",
      pathPrefix: "/opt/memex/",
      boostWeight: 1.2,
    });
    expect(row.kind).toBe("code");
  });
});

describe("listSources", () => {
  it("filters by kind", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault", kind: "vault", pathPrefix: "/vault/" });
    await registerSource(e, { id: "gmail", kind: "mailbox", pathPrefix: "/vault/inbox/gmail/" });
    const mail = await listSources(e, { kind: "mailbox" });
    expect(mail.map((r) => r.id)).toEqual(["gmail"]);
  });
});

describe("updateSource", () => {
  it("patches only specified fields", async () => {
    const e = storage.engine();
    await registerSource(e, {
      id: "x",
      kind: "vault",
      pathPrefix: "/x/",
      boostWeight: 1,
      description: "before",
    });
    const updated = await updateSource(e, { id: "x", boostWeight: 2.5 });
    expect(updated?.boost_weight).toBe(2.5);
    expect(updated?.description).toBe("before");
  });

  it("returns null for missing id", async () => {
    const r = await updateSource(storage.engine(), { id: "ghost", boostWeight: 1 });
    expect(r).toBeNull();
  });
});

describe("deleteSource", () => {
  it("removes a source with no referencing documents", async () => {
    await registerSource(storage.engine(), {
      id: "tmp",
      kind: "other",
      pathPrefix: "/tmp/",
    });
    const ok = await deleteSource(storage.engine(), "tmp");
    expect(ok).toBe(true);
    expect(await getSource(storage.engine(), "tmp")).toBeNull();
  });

  it("refuses when a document references the source", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "vault", kind: "vault", pathPrefix: "/vault/" });
    await e.exec(
      `INSERT INTO documents (id, source_path, source_id) VALUES ('d1', '/vault/a.md', 'vault')`,
    );
    const ok = await deleteSource(e, "vault");
    expect(ok).toBe(false);
    expect(await getSource(e, "vault")).not.toBeNull();
  });
});
