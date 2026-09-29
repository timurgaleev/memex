/**
 * Zero-latency intent classifier — pure regex, no LLM. Verifies the three
 * buckets and the knowledge_update-over-temporal precedence.
 */
import { describe, expect, it } from "bun:test";
import { classifyIntent } from "../src/core/synthesis/intent.ts";

describe("classifyIntent", () => {
  it("flags temporal questions", () => {
    expect(classifyIntent("when did I last meet Alice?")).toBe("temporal");
    expect(classifyIntent("how long ago did we launch?")).toBe("temporal");
    expect(classifyIntent("what happened in March 2024?")).toBe("temporal");
    expect(classifyIntent("is that still true?")).toBe("temporal");
  });

  it("flags knowledge-update questions", () => {
    expect(classifyIntent("did Acme switch stacks?")).toBe("knowledge_update");
    expect(classifyIntent("what is the current plan?")).toBe("knowledge_update");
    expect(classifyIntent("they no longer use Postgres")).toBe("knowledge_update");
    expect(classifyIntent("Bob used to work at Gotham")).toBe("knowledge_update");
  });

  it("knowledge_update wins when both patterns match", () => {
    // "current" (knowledge_update) + "now" (temporal) both fire.
    expect(classifyIntent("what is the current status now?")).toBe("knowledge_update");
  });

  it("defaults to other", () => {
    expect(classifyIntent("summarize the architecture")).toBe("other");
    expect(classifyIntent("")).toBe("other");
    expect(classifyIntent(undefined as unknown as string)).toBe("other");
  });
});
