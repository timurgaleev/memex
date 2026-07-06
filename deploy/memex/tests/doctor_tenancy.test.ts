/**
 * Doctor tenancy/auth checks — federation-health, oauth-client-health,
 * source-routing-health. Seeds a PGLite brain directly (no Bedrock) and
 * asserts the ok / WARN / fail transitions for each check.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  checkFederationHealth,
  checkOauthClientHealth,
  checkSourceRoutingHealth,
} from "../src/core/doctor-tenancy.ts";

const ZERO_VEC = `[${Array(1024).fill(0).join(",")}]`;

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-doctenancy-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedSource(id: string): Promise<void> {
  await storage
    .raw()
    .query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'vault', $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, `${id}/`],
    );
}

/** One doc for `source`, with `total` markdown chunks, `embedded` of them embedded. */
async function seedDoc(
  source: string,
  docId: string,
  total: number,
  embedded: number,
): Promise<void> {
  const e = storage.raw();
  await e.query(
    `INSERT INTO documents (id, source_id, source_path, title, frontmatter, updated_at)
     VALUES ($1, $2, $3, $1, '{}'::jsonb, NOW())`,
    [docId, source, `${source}/${docId}.md`],
  );
  await e.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content)
     SELECT $1 || '-c' || g, $1, g, 'chunk ' || g FROM generate_series(0, $2::int - 1) g`,
    [docId, total],
  );
  if (embedded > 0) {
    await e.query(
      `INSERT INTO embeddings (chunk_id, vector, model)
       SELECT $1 || '-c' || g, $2::vector, 'test' FROM generate_series(0, $3::int - 1) g`,
      [docId, ZERO_VEC, embedded],
    );
  }
}

describe("federation-health", () => {
  it("short-circuits ok on a single-source brain", async () => {
    const c = await checkFederationHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("single-source");
  });

  it("is healthy when every source's coverage holds", async () => {
    await seedSource("vault");
    await seedSource("mail");
    await seedDoc("vault", "v1", 2, 2);
    await seedDoc("mail", "m1", 2, 2);
    const c = await checkFederationHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).not.toContain("WARN");
    expect(c.detail).toContain("2 source(s) healthy");
  });

  it("WARNs when a source with >100 embeddable chunks drops below 95% coverage", async () => {
    await seedSource("vault");
    await seedSource("mail");
    await seedDoc("vault", "v1", 2, 2);
    await seedDoc("mail", "m1", 120, 0);
    const c = await checkFederationHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("WARN");
    expect(c.detail).toContain("mail");
  });

  it("fails when a >1000-chunk source collapses under 50% coverage", async () => {
    await seedSource("vault");
    await seedSource("mail");
    await seedDoc("vault", "v1", 2, 2);
    await seedDoc("mail", "m1", 1100, 10);
    const c = await checkFederationHealth(storage.raw());
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("mail");
    expect(c.detail).toContain("memex reindex --source mail");
  });
});

describe("oauth-client-health", () => {
  it("ok when no clients are registered", async () => {
    const c = await checkOauthClientHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no OAuth clients");
  });

  it("ok for a public PKCE client (method 'none', NULL hash)", async () => {
    await storage.raw().query(
      `INSERT INTO oauth_clients (client_id, client_name, token_endpoint_auth_method, client_secret_hash)
       VALUES ('pub-1', 'Public', 'none', NULL)`,
    );
    const c = await checkOauthClientHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("1 OAuth client(s)");
  });

  it("fails when a confidential client has a NULL secret hash", async () => {
    await storage.raw().query(
      `INSERT INTO oauth_clients (client_id, client_name, token_endpoint_auth_method, client_secret_hash)
       VALUES ('conf-ok', 'Good', 'client_secret_post', 'hash'),
              ('conf-broken', 'Broken', 'client_secret_post', NULL)`,
    );
    const c = await checkOauthClientHealth(storage.raw());
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("conf-broken");
    expect(c.detail).not.toContain("conf-ok,");
  });

  it("ignores soft-deleted clients", async () => {
    await storage.raw().query(
      `INSERT INTO oauth_clients (client_id, client_name, token_endpoint_auth_method, client_secret_hash, deleted_at)
       VALUES ('gone', 'Gone', 'client_secret_post', NULL, NOW())`,
    );
    const c = await checkOauthClientHealth(storage.raw());
    expect(c.ok).toBe(true);
  });
});

describe("source-routing-health", () => {
  it("ok when there are no non-default sources", async () => {
    const c = await checkSourceRoutingHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("single-source");
  });

  it("ok when every non-default source owns documents", async () => {
    await seedSource("vault");
    await seedDoc("vault", "v1", 1, 1);
    const c = await checkSourceRoutingHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("all populated");
  });

  it("WARNs on a registered source with zero documents", async () => {
    await seedSource("vault");
    await seedDoc("vault", "v1", 1, 1);
    await seedSource("ghost");
    const c = await checkSourceRoutingHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("WARN");
    expect(c.detail).toContain("ghost");
  });

  it("WARNs on documents stuck at NULL source_id", async () => {
    await seedSource("vault");
    await seedDoc("vault", "v1", 1, 1);
    await storage.raw().query(
      `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
       VALUES ('loose', 'loose/z.md', 'Z', '{}'::jsonb, NOW())`,
    );
    const c = await checkSourceRoutingHealth(storage.raw());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("WARN");
    expect(c.detail).toContain("NULL source_id");
  });
});
