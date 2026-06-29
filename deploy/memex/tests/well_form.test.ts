/**
 * well-form sanitizer — lone UTF-16 surrogates + NUL are stripped/replaced so a
 * value can't abort a Postgres `::jsonb` cast. Includes the integration proof:
 * a document whose frontmatter carries a lone surrogate + NUL indexes cleanly.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wellFormForJsonb,
  wellFormJsonbValue,
  wellFormJsonbObject,
} from "../src/core/well-form.ts";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";

const LONE_HIGH = "\uD800"; // unpaired high surrogate
const LONE_LOW = "\uDC00"; // unpaired low surrogate
const VALID_EMOJI = "😀"; // a valid surrogate PAIR — must be preserved
const NUL = String.fromCharCode(0); // U+0000 (no literal control char in source)

describe("wellFormForJsonb (unit)", () => {
  it("replaces lone surrogates with U+FFFD but keeps valid pairs", () => {
    expect(wellFormForJsonb(`a${LONE_HIGH}b`)).toBe("a�b");
    expect(wellFormForJsonb(`x${LONE_LOW}y`)).toBe("x�y");
    expect(wellFormForJsonb(`hi ${VALID_EMOJI}`)).toBe(`hi ${VALID_EMOJI}`);
  });

  it("drops NUL", () => {
    expect(wellFormForJsonb(`a${NUL}b`)).toBe("ab");
  });

  it("leaves clean text untouched", () => {
    expect(wellFormForJsonb("ordinary text")).toBe("ordinary text");
  });

  it("deep-sanitizes object keys and values, preserving non-strings", () => {
    const out = wellFormJsonbValue({
      [`k${LONE_HIGH}`]: `v${LONE_LOW}`,
      n: 42,
      b: true,
      nested: { arr: [`${LONE_HIGH}x`, 7] },
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toContain("k�");
    expect(out["k�"]).toBe("v�");
    expect(out.n).toBe(42);
    expect(out.b).toBe(true);
    expect((out.nested as { arr: unknown[] }).arr).toEqual(["�x", 7]);
  });

  it("produces a string JSON.stringify can serialize to valid JSON", () => {
    const s = JSON.stringify(wellFormJsonbValue({ x: `${LONE_HIGH}${LONE_LOW}` }));
    expect(() => JSON.parse(s)).not.toThrow();
  });
});

describe("wellFormJsonbObject (frontmatter object invariant)", () => {
  it("collapses a non-object to {} (the 420MB-frontmatter guard)", () => {
    expect(wellFormJsonbObject("a whole 12MB file body")).toEqual({});
    expect(wellFormJsonbObject(["a", "b"])).toEqual({});
    expect(wellFormJsonbObject(null)).toEqual({});
    expect(wellFormJsonbObject(undefined)).toEqual({});
    expect(wellFormJsonbObject(42)).toEqual({});
  });

  it("keeps a real object and still deep-sanitizes it", () => {
    const out = wellFormJsonbObject({ tags: ["x"], note: `e${LONE_HIGH}` });
    expect(out.tags).toEqual(["x"]);
    expect(out.note).toBe("e�");
  });
});

describe("frontmatter with a lone surrogate indexes cleanly (jsonb cast)", () => {
  let tmp: string;
  let storage: Storage;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-wellform-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does NOT abort the index transaction on a bad frontmatter value", async () => {
    // Without sanitization, the `$4::jsonb` cast would reject this and throw.
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_bad",
        sourcePath: "/bad.md",
        title: "bad",
        frontmatter: {
          note: `truncated emoji ${LONE_HIGH}`,
          nul: `a${NUL}b`,
          ok: VALID_EMOJI,
        },
        embeddingModel: "det",
      },
      [{ text: "body", entities: [] }],
    );
    const r = await storage
      .engine()
      .query<{ frontmatter: { note: string; nul: string; ok: string } }>(
        "SELECT frontmatter FROM documents WHERE id = $1",
        ["doc_bad"],
      );
    const fm = r.rows[0]!.frontmatter;
    expect(fm.note).toBe("truncated emoji �"); // sanitized
    expect(fm.nul).toBe("ab"); // NUL dropped
    expect(fm.ok).toBe(VALID_EMOJI); // valid pair preserved
  });

  it("stores a string frontmatter as {} not a jsonb scalar (420MB-bug guard)", async () => {
    // An ingest path that passes raw content as frontmatter would otherwise
    // serialize a whole file body as a jsonb scalar string. The chokepoint
    // guard collapses it to an object.
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_scalar",
        sourcePath: "/scalar.md",
        title: "scalar",
        frontmatter: "the entire file body crammed in here" as unknown as Record<
          string,
          unknown
        >,
        embeddingModel: "det",
      },
      [{ text: "body", entities: [] }],
    );
    const r = await storage
      .engine()
      .query<{ t: string }>(
        "SELECT jsonb_typeof(frontmatter) AS t FROM documents WHERE id = $1",
        ["doc_scalar"],
      );
    expect(r.rows[0]!.t).toBe("object");
  });
});
