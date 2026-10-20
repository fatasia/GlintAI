import { afterEach, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai-compatible";
const provider = new OpenAICompatibleProvider({ baseUrl: "https://example.test", apiKey: "mock", model: "mock" });
afterEach(() => vi.unstubAllGlobals());
function serve(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); }, cancel,
  }))));
  return cancel;
}
async function collect() { let text = ""; for await (const delta of provider.chatStream({ messages: [] })) text += delta; return text; }
it.each(["\n", "\r\n"])("handles fragmented UTF8 SSE %j and DONE", async (nl) => {
  serve(`: ping${nl}${nl}data: {"choices":[{"delta":{"content":"中文"}}]}${nl}${nl}data: [DONE]${nl}${nl}data: invalid${nl}${nl}`);
  expect(await collect()).toBe("中文");
});
it("flushes final DONE event at EOF", async () => { serve('data: {"choices":[{"delta":{"content":"tail"}}]}\n\ndata: [DONE]'); expect(await collect()).toBe("tail"); });
it("rejects EOF without DONE as truncated", async () => { serve('data: {"choices":[{"delta":{"content":"tail"}}]}'); await expect(collect()).rejects.toThrow("before [DONE]"); });
it("does not silently swallow broken events", async () => { serve("data: broken\n\n"); await expect(collect()).rejects.toThrow("Invalid JSON"); });
it("surfaces upstream error events", async () => { serve('data: {"error":{"message":"failed"}}\n\n'); await expect(collect()).rejects.toThrow("error event"); });
it("cancels reader on consumer return", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')); }, cancel })));
  for await (const delta of provider.chatStream({ messages: [] })) { expect(delta).toBe("hi"); break; }
  expect(cancel).toHaveBeenCalledOnce();
});
it("aborts a pending reader", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel })));
  const controller = new AbortController();
  const stream = provider.chatStream({ messages: [], signal: controller.signal });
  const pending = stream.next();
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toThrow();
  expect(cancel).toHaveBeenCalled();
});
