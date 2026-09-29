/**
 * slugifyTarget folds emoji / ideographic variation selectors, so a name typed
 * with and without VS16 lands on one slug instead of twin pages.
 */
import { describe, expect, it } from "bun:test";
import { slugifyTarget, validateSlug } from "../src/core/links.ts";

describe("slugifyTarget — variation selectors", () => {
  it("VS16 / VS15 do not fork a non-Latin slug", () => {
    expect(slugifyTarget("東京\uFE0F")).toBe(slugifyTarget("東京"));
    expect(slugifyTarget("東京\uFE0E")).toBe("東京");
    expect(slugifyTarget("☕\uFE0F Кофе")).toBe(slugifyTarget("☕ Кофе"));
  });

  it("ideographic variation sequences fold too", () => {
    expect(slugifyTarget("葛\u{E0100}飾")).toBe("葛飾");
  });

  it("a name that is only an emoji + selector is not a slug of its own", () => {
    expect(slugifyTarget("✈\uFE0F")).toBe("unknown");
  });

  it("the ASCII path is unchanged and never carries a selector", () => {
    expect(slugifyTarget("Acme ✈\uFE0F Labs")).toBe("acme-labs");
    const s = slugifyTarget("Кафе\uFE0F/Меню\uFE0F");
    expect(s).not.toMatch(/[\uFE00-\uFE0F]/u);
    expect(() => validateSlug(s)).not.toThrow();
  });
});
