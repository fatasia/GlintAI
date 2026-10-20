import { afterEach, expect, it, vi } from "vitest";
import { MediaGatewayClient } from "./index";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const config = { baseUrl: "https://media.test", apiKey: "private-test" };
it("submits once, records task ID and polls without replaying paid work", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST" ? Response.json({ data: { task_id: 123 } }) : Response.json({ task_id: 123, state: "success", is_final: true, result_url: "https://cdn.test/audio.mp3" })); vi.stubGlobal("fetch", fetch);
  const client = new MediaGatewayClient(config), id = await client.submit("suno-v6", "Piano", { make_instrumental: "instrumental" });
  expect(id).toBe("123"); expect((await client.wait(id)).state).toBe("success");
  expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ model: "suno-v6", prompt: "Piano", params: { make_instrumental: "instrumental" } });
});
it("fails on upstream errors without leaking bodies or resubmitting", async () => {
  const fetch = vi.fn(async () => new Response("private-test", { status: 429 })); vi.stubGlobal("fetch", fetch);
  await expect(new MediaGatewayClient(config).submit("model", "prompt")).rejects.toThrow("HTTP 429");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects malformed states, task IDs, remote HTTP and aborted requests", async () => {
  expect(() => new MediaGatewayClient({ ...config, baseUrl: "http://remote.test" })).toThrow(/HTTPS/);
  await expect(new MediaGatewayClient(config).status("../escape")).rejects.toThrow(/task ID/);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "完成" })));
  await expect(new MediaGatewayClient(config).status("123")).rejects.toThrow(/status/);
  const controller = new AbortController(); controller.abort();
  await expect(new MediaGatewayClient(config).wait("123", { signal: controller.signal })).rejects.toThrow();
});
