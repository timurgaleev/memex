/**
 * The response classifier over one recorded GitHub response per class.
 */
import { describe, expect, it } from "bun:test";
import { classifyResponse } from "../src/core/connectors/classify.ts";
import type { ResponseClass } from "../src/core/connectors/types.ts";
import { recorded } from "./github-recorded.ts";

function classify(name: string): ResponseClass {
  const r = recorded(name);
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return classifyResponse(r.status, new Headers(r.headers), body);
}

describe("classifyResponse", () => {
  it.each([
    ["issues-page-1", "ok"],
    ["empty", "ok"],
    ["challenge", "challenge"],
    ["unauthorized", "auth_required"],
    ["forbidden", "forbidden"],
    ["secondary-limit", "rate_limited"],
    ["primary-limit", "rate_limited"],
    ["too-many-requests", "rate_limited"],
    ["bad-gateway", "server_error"],
  ] as const)("%s -> %s", (name, expected) => {
    expect(classify(name)).toBe(expected);
  });

  it("reads a 200 whose body starts with markup as a challenge even without a content type", () => {
    expect(classifyResponse(200, new Headers(), "  <html>hold on</html>")).toBe("challenge");
  });

  it("tells a 403 challenge page from a JSON 403", () => {
    expect(classifyResponse(403, new Headers({ "content-type": "text/html" }), "<html>blocked</html>")).toBe("challenge");
    expect(classifyResponse(403, new Headers({ "content-type": "application/json" }), '{"message":"nope"}')).toBe("forbidden");
  });

  it("maps a 404, a redirect and other 4xx to forbidden, never ok", () => {
    for (const status of [301, 302, 400, 404, 410, 422]) {
      expect(classifyResponse(status, new Headers(), "{}")).toBe("forbidden");
    }
  });

  it("only reads a bounded prefix of the body", () => {
    const late = `${" ".repeat(4096)}secondary rate limit`;
    expect(classifyResponse(403, new Headers(), late)).toBe("forbidden");
  });
});
