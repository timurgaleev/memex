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
  sourceReferences,
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
      id: "memex-code",
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

  describe("refuses while a grant still names the source", () => {
    const future = () => Math.floor(Date.now() / 1000) + 3600;
    const cases: Array<[string, string, (e: ReturnType<typeof storage.engine>, src: string) => Promise<void>]> = [
      ["oauth client", "oauth_clients", async (e, src) => {
        await e.query(`INSERT INTO oauth_clients (client_id, client_name, source_id) VALUES ($1, 'c', $2)`, [`cl-${src}`, src]);
      }],
      ["oauth token", "oauth_tokens", async (e, src) => {
        await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ($1, 'c')`, [`cl-${src}`]);
        await e.query(`UPDATE oauth_clients SET deleted_at = NOW() WHERE client_id = $1`, [`cl-${src}`]);
        await e.query(
          `INSERT INTO oauth_tokens (token_hash, token_type, client_id, expires_at, source_id, grant_bound)
           VALUES ($1, 'access', $2, $3, $4, true)`,
          [`tok-${src}`, `cl-${src}`, future(), src],
        );
      }],
      ["oauth code", "oauth_codes", async (e, src) => {
        await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ($1, 'c')`, [`cl-${src}`]);
        await e.query(`UPDATE oauth_clients SET deleted_at = NOW() WHERE client_id = $1`, [`cl-${src}`]);
        await e.query(
          `INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, expires_at, source_id)
           VALUES ($1, $2, 'x', 'https://example.com/cb', $3, $4)`,
          [`code-${src}`, `cl-${src}`, future(), src],
        );
      }],
      ["enrollment", "enrollments", async (e, src) => {
        await e.query(
          `INSERT INTO oauth_enrollments (id, code_hash, source_id, federated_read, expires_at)
           VALUES ($1, $1, $2, ARRAY[$2], NOW() + interval '1 day')`,
          [`enr-${src}`, src],
        );
      }],
      ["personal token", "personal_tokens", async (e, src) => {
        await e.query(
          `INSERT INTO access_tokens (name, token_hash, permissions) VALUES ($1, $1, $2::jsonb)`,
          [`pat-${src}`, JSON.stringify({ source_id: ["other", src] })],
        );
      }],
    ];
    for (const [label, key, seed] of cases) {
      it(label, async () => {
        const e = storage.engine();
        const src = `grant-${key.replace(/_/g, "-")}`;
        await registerSource(e, { id: src, kind: "other", pathPrefix: `/${src}/` });
        await seed(e, src);
        expect(Object.keys(await sourceReferences(e, src))).toEqual([key]);
        expect(await deleteSource(e, src)).toBe(false);
        expect(await getSource(e, src)).not.toBeNull();
      });
    }

    it("counts a revoked client that still names the source instead of crashing on its foreign key", async () => {
      const e = storage.engine();
      const src = "grant-revoked-client";
      await registerSource(e, { id: src, kind: "other", pathPrefix: `/${src}/` });
      await e.query(`INSERT INTO oauth_clients (client_id, client_name, source_id, deleted_at) VALUES ('cl-revoked', 'c', $1, NOW())`, [src]);
      expect(await sourceReferences(e, src)).toEqual({ oauth_clients: 1 });
      expect(await deleteSource(e, src)).toBe(false);
    });

    it("sees a personal token whose permissions were stored as a JSON string", async () => {
      const e = storage.engine();
      const src = "grant-string-pat";
      await registerSource(e, { id: src, kind: "other", pathPrefix: `/${src}/` });
      await e.query(
        `INSERT INTO access_tokens (name, token_hash, permissions) VALUES ('pat-string', 'pat-string', to_jsonb($1::text))`,
        [JSON.stringify({ source_id: [src] })],
      );
      expect(await sourceReferences(e, src)).toEqual({ personal_tokens: 1 });
    });

    it("never deletes the fallback source", async () => {
      const e = storage.engine();
      await registerSource(e, { id: "default", kind: "other", pathPrefix: "/default/" });
      expect(Object.keys(await sourceReferences(e, "default"))).toContain("fallback_source");
      expect(await deleteSource(e, "default")).toBe(false);
    });

    it("ignores revoked and expired grants", async () => {
      const e = storage.engine();
      const src = "grant-stale";
      await registerSource(e, { id: src, kind: "other", pathPrefix: `/${src}/` });
      await e.query(
        `INSERT INTO oauth_enrollments (id, code_hash, source_id, federated_read, expires_at, revoked_at)
         VALUES ('enr-stale', 'enr-stale', $1, ARRAY[$1], NOW() + interval '1 day', NOW())`,
        [src],
      );
      await e.query(
        `INSERT INTO access_tokens (name, token_hash, permissions, revoked_at) VALUES ('pat-stale', 'pat-stale', $1::jsonb, NOW())`,
        [JSON.stringify({ source_id: src })],
      );
      expect(await sourceReferences(e, src)).toEqual({});
      expect(await deleteSource(e, src)).toBe(true);
    });
  });
});
