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

it("fetches a per-model price card for cost estimates", async () => {
  const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json({ is_active: true, price: 0.03, unit: "per call" }));
  vi.stubGlobal("fetch", fetch);
  const card = await new MediaGatewayClient(config).pricing("tt-image-2.5");
  expect(card).toMatchObject({ is_active: true, price: 0.03 });
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("https://media.test/v1/skills/models/tt-image-2.5/pricing");
  await expect(new MediaGatewayClient(config).pricing("bad model!")).rejects.toThrow("Invalid media model name");
});
it("keeps compatible tags while marking malformed upstream declarations ineligible", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: [
    { name: "good", tags: ["图生图"] }, { name: "bad", tags: ["图生图", {}] },
    { name: "hidden", tags: ["图生图"], available_for_this_key: false },
    { name: "long", tags: Array(33).fill("图生图") }, { name: "missing" },
  ] })));
  const catalog = await new MediaGatewayClient(config).models("image");
  expect(catalog.map((model: { id: string }) => model.id)).toEqual(["good", "bad", "long", "missing"]);
  expect(catalog[0]).toMatchObject({ tags: ["图生图"], capabilityTagsValid: true });
  expect(catalog[1]).toMatchObject({ tags: ["图生图"], capabilityTagsValid: false });
  expect(catalog[2]!.capabilityTagsValid).toBe(false); expect(catalog[3]!.capabilityTagsValid).toBe(false);
});
