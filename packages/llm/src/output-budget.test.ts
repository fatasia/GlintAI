import { afterEach, expect, it, vi } from "vitest";
import { createLlmProvider, type LlmProtocol } from "./configuration";
import { OpenAICompatibleProvider } from "./openai-compatible";

afterEach(() => vi.unstubAllGlobals());
const config = { baseUrl: "https://gateway.test", apiKey: "test-key", model: "test-model" };
const reply = { choices: [{ message: { content: "OK" } }], content: [{ type: "text", text: "OK" }], output: [{ content: [{ type: "output_text", text: "OK" }] }], candidates: [{ content: { parts: [{ text: "OK" }] } }] };
const protocols: LlmProtocol[] = ["openai", "responses", "anthropic", "gemini", "auto"];

it.each(protocols)("%s forwards an explicit output budget without extra requests", async protocol => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(reply)); vi.stubGlobal("fetch", fetch);
  const provider = createLlmProvider({ ...config, protocol });
  expect((await provider.chat({ messages: [{ role: "user", content: "OK" }], maxOutputTokens: 64 })).text).toBe("OK");
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
  const limit = protocol === "responses" ? body.max_output_tokens : protocol === "anthropic" ? body.max_tokens : protocol === "gemini" ? body.generationConfig.maxOutputTokens : body.max_completion_tokens;
  expect(limit).toBe(64);
});

it.each(protocols)("%s rejects invalid budgets before sending", async protocol => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(createLlmProvider({ ...config, protocol }).chat({ messages: [], maxOutputTokens })).rejects.toThrow("maxOutputTokens");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it.each(protocols)("%s preserves defaults when no budget is supplied", async protocol => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(reply)); vi.stubGlobal("fetch", fetch);
  await createLlmProvider({ ...config, protocol }).chat({ messages: [] });
  const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
  expect(body.max_completion_tokens).toBeUndefined(); expect(body.max_output_tokens).toBeUndefined();
  expect(body.generationConfig?.maxOutputTokens).toBeUndefined();
  expect(body.max_tokens).toBe(protocol === "anthropic" ? 4096 : undefined);
});

it("streams with the same budget and rejects invalid stream budgets without requests", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')); vi.stubGlobal("fetch", fetch);
  const provider = new OpenAICompatibleProvider(config), chunks: string[] = [];
  for await (const chunk of provider.chatStream({ messages: [], maxOutputTokens: 64 })) chunks.push(chunk);
  expect(chunks.join("")).toBe("OK");
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({ stream: true, max_completion_tokens: 64 });
  await expect(provider.chatStream({ messages: [], maxOutputTokens: 0 }).next()).rejects.toThrow("maxOutputTokens");
  expect(fetch).toHaveBeenCalledTimes(1);
});
