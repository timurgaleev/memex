/**
 * Public-boundary error sanitization.
 *
 * A raw exception message can carry Postgres schema/column names, the DSN
 * host, or stack internals. `publicSafeErrorMessage` must return a generic
 * string (and log the real detail server-side) when the response may cross
 * the public ingress, while keeping the detail on the internal path so the
 * operator can still debug. Surfaced by the bug-hunter / security-engineer
 * adversarial audit (2026-06-09).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  PUBLIC_ERROR_MESSAGE,
  publicSafeErrorMessage,
} from "../src/core/public_redaction.ts";

let errSpy: ReturnType<typeof mock>;
let originalError: typeof console.error;

beforeEach(() => {
  originalError = console.error;
  errSpy = mock(() => {});
  console.error = errSpy as unknown as typeof console.error;
});

afterEach(() => {
  console.error = originalError;
});

describe("publicSafeErrorMessage", () => {
  const leaky = new Error('relation "pages" does not exist at db.internal:5432');

  it("returns a generic message on public ingress and never the detail", () => {
    const out = publicSafeErrorMessage(leaky, true);
    expect(out).toBe(PUBLIC_ERROR_MESSAGE);
    expect(out).not.toContain("pages");
    expect(out).not.toContain("db.internal");
  });

  it("logs the real detail server-side on public ingress", () => {
    publicSafeErrorMessage(leaky, true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain('relation "pages" does not exist');
  });

  it("returns the full detail on the internal path and does not log", () => {
    const out = publicSafeErrorMessage(leaky, false);
    expect(out).toBe(leaky.message);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("coerces non-Error throwables (string) without leaking them publicly", () => {
    expect(publicSafeErrorMessage("ECONNREFUSED 10.0.0.5:5432", true)).toBe(
      PUBLIC_ERROR_MESSAGE,
    );
    expect(publicSafeErrorMessage("plain string", false)).toBe("plain string");
  });

  it("coerces non-Error throwables (object) on the internal path", () => {
    expect(publicSafeErrorMessage({ code: "42P01" }, false)).toBe(
      "[object Object]",
    );
  });
});
