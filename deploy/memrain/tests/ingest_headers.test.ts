/**
 * POST /ingest reads its request headers as `x-memrain-*`, falling back to the
 * pre-rename `x-memex-*` spelling. A header sent under both names with
 * different values is refused and nothing is queued.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { handleIngestRoute, type IngestionEvent } from "../src/http/ingest.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memex-ingest-headers-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const writeAuth: AuthInfo = {
  token: "t",
  clientId: "hook",
  scopes: ["write"],
  sourceId: "default",
  isPublic: false,
};

function post(headers: Record<string, string>, body = "# note"): Promise<Response> {
  return handleIngestRoute(
    new Request("http://test/ingest", { method: "POST", headers, body }),
    { storage, authInfo: writeAuth, allowRequest: () => true, clientIp: "1.2.3.4" },
  );
}

async function queued(): Promise<Array<{ event: IngestionEvent; slug?: string }>> {
  const r = await storage.engine().query<{ payload: unknown }>("SELECT payload FROM jobs ORDER BY created_at");
  return r.rows.map((row) =>
    (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as { event: IngestionEvent; slug?: string });
}

describe("ingest header families", () => {
  for (const family of ["x-memrain-", "x-memex-"]) {
    it(`${family}* sets the type, source URI and slug`, async () => {
      const res = await post({
        "content-type": "application/octet-stream",
        [`${family}content-type`]: "text/markdown",
        [`${family}source-uri`]: "shortcut:note",
        [`${family}slug`]: "inbox/from-header",
      });
      expect(res.status).toBe(202);
      const [job] = await queued();
      expect(job?.event.content_type).toBe("text/markdown");
      expect(job?.event.source_uri).toBe("shortcut:note");
      expect(job?.slug).toBe("inbox/from-header");
    });
  }

  it("the same value under both names is accepted", async () => {
    const res = await post({
      "content-type": "text/markdown",
      "x-memrain-slug": "inbox/same",
      "x-memex-slug": "inbox/same",
    });
    expect(res.status).toBe(202);
    expect((await queued())[0]?.slug).toBe("inbox/same");
  });

  for (const name of ["content-type", "source-uri", "slug"]) {
    it(`different values for ${name} → 400 ambiguous_header, nothing queued`, async () => {
      const res = await post({
        "content-type": "text/markdown",
        [`x-memrain-${name}`]: name === "slug" ? "inbox/a" : name === "content-type" ? "text/plain" : "uri:a",
        [`x-memex-${name}`]: name === "slug" ? "inbox/b" : name === "content-type" ? "text/html" : "uri:b",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("ambiguous_header");
      expect(await queued()).toEqual([]);
    });
  }

  it("an invalid slug under the new name is still validated", async () => {
    const res = await post({ "content-type": "text/markdown", "x-memrain-slug": "Bad Slug!" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_slug");
  });
});
