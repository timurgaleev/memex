/**
 * OAuth scope hierarchy. Pure logic, no DB. Guards the invariants the auth
 * layer depends on — most importantly that `admin` does NOT imply `agent`
 * (a future "admin implies all" refactor must fail here, not in production).
 */
import { describe, expect, it } from "bun:test";
import {
  assertAllowedScopes,
  hasScope,
  InvalidScopeError,
  normalizeScopesInput,
  parseScopeString,
} from "../src/core/scope.ts";

describe("hasScope", () => {
  it("admin implies write and read but NOT agent", () => {
    expect(hasScope(["admin"], "read")).toBe(true);
    expect(hasScope(["admin"], "write")).toBe(true);
    expect(hasScope(["admin"], "sources_admin")).toBe(true);
    expect(hasScope(["admin"], "users_admin")).toBe(true);
    expect(hasScope(["admin"], "agent")).toBe(false);
  });

  it("write implies read, not the reverse", () => {
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
  });

  it("the *_admin siblings imply only themselves", () => {
    expect(hasScope(["sources_admin"], "users_admin")).toBe(false);
    expect(hasScope(["users_admin"], "write")).toBe(false);
  });

  it("ignores unknown granted scopes without throwing", () => {
    expect(hasScope(["bogus"], "read")).toBe(false);
    expect(hasScope(["bogus", "read"], "read")).toBe(true);
  });
});

describe("normalizeScopesInput", () => {
  it("defaults to read, sorts + dedupes", () => {
    expect(normalizeScopesInput(null)).toBe("read");
    expect(normalizeScopesInput("write read read")).toBe("read write");
    expect(normalizeScopesInput(["write", "read"])).toBe("read write");
  });

  it("rejects unknown scopes and malformed arrays", () => {
    expect(() => normalizeScopesInput(["read", "boss"])).toThrow(InvalidScopeError);
    expect(() => normalizeScopesInput(["read write"])).toThrow(/whitespace/);
    expect(() => normalizeScopesInput([42 as unknown as string])).toThrow(/only strings/);
  });
});

describe("parse + assert helpers", () => {
  it("parseScopeString splits and drops empties", () => {
    expect(parseScopeString("read  write")).toEqual(["read", "write"]);
    expect(parseScopeString(undefined)).toEqual([]);
  });

  it("assertAllowedScopes throws on the first unknown", () => {
    expect(() => assertAllowedScopes(["read", "nope"])).toThrow(InvalidScopeError);
    expect(() => assertAllowedScopes(["read", "write", "admin"])).not.toThrow();
  });
});
