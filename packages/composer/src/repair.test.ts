import { expect, it, vi } from "vitest";
import { composeWithLlm, DEFAULT_MAX_SOURCE_CHARS } from "./llm";
import { MockLlmProvider } from "@glintai/llm";
const valid = JSON.stringify({ schemaVersion: 1, id: "fixed", title: "Fixed", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "intro", kind: "title", title: "Fixed", narration: { text: "Source sentence." } }] });
it("repairs one malformed reply with a bounded fresh request", async () => {
  const handler = vi.fn().mockReturnValueOnce("not JSON").mockReturnValue(valid);
  const result = await composeWithLlm("# Source\n\nSource sentence.", new MockLlmProvider(handler));
  expect(result.id).toBe("fixed"); expect(handler).toHaveBeenCalledTimes(2);
  expect(handler.mock.calls[1]![0].system).toContain("previous reply failed");
});
it("does not retry upstream transport errors or replay on cancellation", async () => {
  const handler = vi.fn(() => { throw new Error("network"); });
  await expect(composeWithLlm("Source", new MockLlmProvider(handler))).rejects.toThrow("network");
  expect(handler).toHaveBeenCalledTimes(1);
  const controller = new AbortController(); controller.abort();
  await expect(composeWithLlm("Source", new MockLlmProvider(handler), {}, { signal: controller.signal })).rejects.toThrow();
  expect(handler).toHaveBeenCalledTimes(1);
});
it("never silently truncates the source or spins on invalid replies", async () => {
  const handler = vi.fn(() => "bad");
  await expect(composeWithLlm("x".repeat(DEFAULT_MAX_SOURCE_CHARS + 1), new MockLlmProvider(handler))).rejects.toThrow(/split/);
  expect(handler).toHaveBeenCalledTimes(0);
  await expect(composeWithLlm("Source", new MockLlmProvider(handler))).rejects.toThrow(/JSON/);
  expect(handler).toHaveBeenCalledTimes(2);
});
