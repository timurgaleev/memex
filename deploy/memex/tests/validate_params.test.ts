/**
 * Contract-derived param validation — `validateParams` enforces the declared
 * type / enum / min-max of present params, throwing OperationError. Required-
 * presence is left to the per-handler guards; unknown params are not rejected.
 *
 * The PARITY test is the safety proof: for every operation, a param set built
 * from the contract's own valid boundary values must pass — so enabling
 * validateParams can never reject a well-formed (contract-conformant) call, the
 * exact shape the MCP client sends.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATIONS,
  validateParams,
  type Operation,
  type ParamDef,
} from "../src/mcp/operations.ts";
import { isOperationError } from "../src/core/operation-error.ts";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const opByName = (name: string): Operation => {
  const op = OPERATIONS.find((o) => o.name === name);
  if (!op) throw new Error(`no such op: ${name}`);
  return op;
};

/** A valid value for a ParamDef, drawn from its own declared constraints. */
function validValue(def: ParamDef): unknown {
  if (def.enum) return def.enum[0];
  switch (def.type) {
    case "integer":
    case "number":
      return def.minimum ?? 1;
    case "boolean":
      return true;
    case "object":
      return {};
    default:
      return "x";
  }
}

describe("validateParams — unit", () => {
  const search = opByName("search");

  it("accepts valid params", () => {
    expect(() => validateParams(search, { q: "hello", k: 5 })).not.toThrow();
    expect(() => validateParams(search, { q: "hello" })).not.toThrow();
  });

  it("does NOT enforce required-presence (left to handlers)", () => {
    // `q` is required, but validateParams only checks PRESENT params.
    expect(() => validateParams(search, {})).not.toThrow();
    expect(() => validateParams(search, { k: 5 })).not.toThrow();
  });

  it("rejects an out-of-range integer with invalid_params", () => {
    try {
      validateParams(search, { q: "x", k: 200 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(isOperationError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("invalid_params");
    }
  });

  it("rejects a below-minimum integer", () => {
    expect(() => validateParams(search, { q: "x", k: 0 })).toThrow();
  });

  it("rejects a non-integer for an integer param", () => {
    expect(() => validateParams(search, { q: "x", k: 2.5 })).toThrow();
    expect(() => validateParams(search, { q: "x", k: "5" })).toThrow();
  });

  it("rejects a bad enum value", () => {
    const backlinks = opByName("backlinks");
    expect(() => validateParams(backlinks, { name: "a", type: "wikilink" })).not.toThrow();
    expect(() => validateParams(backlinks, { name: "a", type: "bogus" })).toThrow();
  });

  it("ignores unknown params (lenient)", () => {
    expect(() => validateParams(search, { q: "x", made_up_field: 99 })).not.toThrow();
  });

  // Assert the throw is specifically an Operation('invalid_params'), not a raw
  // TypeError that a bare `toThrow` would also accept.
  const expectInvalid = (fn: () => void): void => {
    try {
      fn();
      throw new Error("should have thrown");
    } catch (e) {
      expect(isOperationError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("invalid_params");
    }
  };

  it("rejects non-numeric type mismatches (string/object/array/number)", () => {
    const pagePut = opByName("page_put"); // title:string, compiled_truth:object
    expectInvalid(() => validateParams(pagePut, { slug: "s", markdown_body: "b", title: 5 }));
    // An array is NOT a valid `object` value (it's a jsonb object, not a list).
    expectInvalid(() => validateParams(pagePut, { slug: "s", markdown_body: "b", compiled_truth: [] }));
    const link = opByName("link"); // confidence:number
    expectInvalid(() => validateParams(link, { source: "a", target: "b", type: "t", confidence: "high" }));
  });

  it("rejects a present null (non-nullable contract types), not skips it", () => {
    // typeof null === "object" — the object branch must still reject it.
    const pagePut = opByName("page_put");
    expectInvalid(() => validateParams(pagePut, { slug: "s", markdown_body: "b", compiled_truth: null }));
    // null for a numeric param fails the type check too.
    const link = opByName("link");
    expectInvalid(() => validateParams(link, { source: "a", target: "b", type: "t", confidence: null }));
  });
});

describe("validateParams — contract parity (no well-formed call is rejected)", () => {
  it("every operation accepts a param set built from its own valid boundaries", () => {
    for (const op of OPERATIONS) {
      const params: Record<string, unknown> = {};
      for (const [key, def] of Object.entries(op.params)) {
        params[key] = validValue(def);
      }
      expect(() => validateParams(op, params), `op ${op.name}`).not.toThrow();
      // The maximum boundary must also pass for numeric params.
      for (const [key, def] of Object.entries(op.params)) {
        if ((def.type === "integer" || def.type === "number") && def.maximum !== undefined) {
          const atMax = { ...params, [key]: def.maximum };
          expect(() => validateParams(op, atMax), `op ${op.name} ${key}=max`).not.toThrow();
        }
      }
    }
  });
});

describe("validateParams — dispatch integration", () => {
  let tmp: string;
  let storage: Storage;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memex-vparams-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("an out-of-contract param returns the invalid_params envelope before the handler runs", async () => {
    const res = await dispatchTool(storage, { name: "search", arguments: { q: "x", k: 9999 } }, {
      isPublic: false,
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error).toBe("invalid_params");
    expect(env.message).toContain("k");
  });
});
