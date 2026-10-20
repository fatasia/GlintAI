import { afterEach, expect, it, vi } from "vitest";
import { AutoLlmProvider, createLlmProvider, discoverLlmModels, normalizeLlmBase } from "./configuration";
afterEach(() => vi.unstubAllGlobals());
const config = { baseUrl: "https://gateway.test", apiKey: "private-test", model: "alias" };
it("normalizes endpoint input and rejects URL credentials or insecure remote endpoints", () => {
  expect(normalizeLlmBase("https://example.com/v1/chat/completions/")).toBe("https://example.com/v1");
  expect(normalizeLlmBase("http://127.0.0.1:8080/v1")).toContain(":8080");
  for (const url of ["https://key@example.com", "http://remote.test", "https://example.com/?key=x"]) expect(() => normalizeLlmBase(url)).toThrow();
});
it("discovers model IDs without making a completion request", async () => {
  const fetch = vi.fn(async () => Response.json({ data: [{ id: "one" }, { id: "two" }] })); vi.stubGlobal("fetch", fetch);
  expect((await discoverLlmModels(config.baseUrl, config.apiKey)).models.map(item => item.id)).toEqual(["one", "two"]);
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe("https://gateway.test/v1/models"); expect(call[1].method).toBeUndefined();
});
it("falls back only on explicit endpoint mismatch and caches the working protocol", async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith("chat/completions") ? new Response("not found", { status: 404 }) : Response.json({ content: [{ type: "text", text: "OK" }] })); vi.stubGlobal("fetch", fetch);
  const provider = new AutoLlmProvider(config);
  expect((await provider.chat({ messages: [] })).text).toBe("OK");
  expect(provider.resolvedProtocol).toBe("anthropic");
  await provider.chat({ messages: [] }); expect(fetch).toHaveBeenCalledTimes(3);
});
it("does not cycle protocols on auth/quota/server/timeout errors", async () => {
  for (const status of [401, 403, 429, 500]) {
    const fetch = vi.fn(async () => new Response("error", { status })); vi.stubGlobal("fetch", fetch);
    await expect(new AutoLlmProvider(config).chat({ messages: [] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});
it("supports Responses and Gemini text/JSON responses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ output: [{ content: [{ type: "output_text", text: "response" }] }] })));
  expect((await createLlmProvider({ ...config, protocol: "responses" }).chat({ messages: [], json: true })).text).toBe("response");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: "private reasoning", thought: true }, { text: "answer" }] } }] })));
  expect((await createLlmProvider({ ...config, protocol: "gemini" }).chat({ messages: [], json: true })).text).toBe("answer");
});
it("paginates catalogs with provider tokens without following external URLs", async () => {
  const fetch = vi.fn(async (url: string) => url.includes("after_id") ? Response.json({ data: [{ id: "second" }], has_more: false }) : Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" })); vi.stubGlobal("fetch", fetch);
  expect((await discoverLlmModels(config.baseUrl, config.apiKey)).models.map(item => item.id)).toEqual(["first", "second"]);
  expect(fetch.mock.calls[1]![0]).toBe("https://gateway.test/v1/models?after_id=first");
});
