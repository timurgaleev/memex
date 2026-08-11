/**
 * Every fact carries provenance.
 *
 * add_fact reaches the ledger over the public write surface, and an
 * unattributed fact cannot be audited, aged against its origin, or weighed
 * during synthesis. A caller that names no source at all is credited to its own
 * identity rather than landing anonymous — rejecting the write instead would
 * just throw away a claim the agent wanted recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, writerIdentity } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-prov-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function writtenByFor(
  args: Record<string, unknown>,
  opts: Parameters<typeof dispatchTool>[2] = {},
): Promise<string | null> {
  const r = await dispatchTool(
    storage,
    { name: "add_fact", arguments: { entity_slug: "people/alice", ...args } },
    opts,
  );
  expect(r.isError ?? false).toBe(false);
  const row = await storage
    .engine()
    .query<{ written_by: string | null }>(
      `SELECT written_by FROM entity_facts ORDER BY id DESC LIMIT 1`,
    );
  return row.rows[0]?.written_by ?? null;
}

describe("writerIdentity", () => {
  it("names the public ingress, the client, or the operator", () => {
    expect(writerIdentity({ isPublic: true })).toBe("public");
    expect(
      writerIdentity({
        authInfo: { token: "t", clientId: "agent-7", scopes: ["write"] },
      }),
    ).toBe("client:agent-7");
    expect(writerIdentity({})).toBe("operator");
  });
});

describe("add_fact provenance", () => {
  it("credits the caller when it names no source at all", async () => {
    expect(await writtenByFor({ fact: "likes tea" })).toBe("operator");
  });

  it("credits the public ingress for an anonymous public write", async () => {
    expect(await writtenByFor({ fact: "likes coffee" }, { isPublic: true })).toBe(
      "public",
    );
  });

  it("credits the authenticated client by id", async () => {
    const written = await writtenByFor(
      { fact: "likes cocoa" },
      { authInfo: { token: "t", clientId: "agent-7", scopes: ["write"] } },
    );
    expect(written).toBe("client:agent-7");
  });

  it("leaves an explicit written_by alone", async () => {
    expect(await writtenByFor({ fact: "likes juice", written_by: "extractor" })).toBe(
      "extractor",
    );
  });

  it("does not overwrite when the caller named a source page instead", async () => {
    // source_slug IS provenance — the fallback must not fire and claim the
    // write for the caller when the origin is already recorded.
    expect(
      await writtenByFor({ fact: "likes milk", source_slug: "notes/kitchen" }),
    ).toBeNull();
  });
});

describe("provenance cannot be forged or faked", () => {
  it("ignores written_by from a public caller", async () => {
    // An anonymous writer asserting `operator` would launder its own writes
    // into the audit trail.
    expect(
      await writtenByFor(
        { fact: "claims to be the operator", written_by: "operator" },
        { isPublic: true },
      ),
    ).toBe("public");
  });

  it("treats blank and whitespace provenance as absent", async () => {
    expect(await writtenByFor({ fact: "blank writer", written_by: "   " })).toBe(
      "operator",
    );
    expect(
      await writtenByFor({ fact: "blank chunk", source_chunk_id: "" }),
    ).toBe("operator");
    // An empty source_slug used to survive as provenance and then fail slug
    // validation, instead of simply reading as omitted.
    expect(await writtenByFor({ fact: "blank source", source_slug: "" })).toBe(
      "operator",
    );
  });
});
