import { afterEach, expect, it, vi } from "vitest";
import { generateMiniMaxMusic } from "./minimax";
afterEach(() => vi.unstubAllGlobals());
it("requests instrumental music without leaking the API key into payloads", async () => {
  const fetch = vi.fn(async () => Response.json({ base_resp: { status_code: 0 }, data: { status: 2, audio: Buffer.alloc(100).toString("hex") }, extra_info: { music_duration: 20000 } }));
  vi.stubGlobal("fetch", fetch);
  const result = await generateMiniMaxMusic("Quiet piano under narration, no vocals", { apiKey: "private-test" });
  expect(result.durationMs).toBe(20000);
  const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.minimax.io/v1/music_generation");
  expect(request.redirect).toBe("error");
  expect(JSON.parse(request.body as string)).toMatchObject({ is_instrumental: true, output_format: "hex" });
  expect(request.body).not.toContain("private-test");
});
it("rejects missing prompts, provider errors and malformed audio", async () => {
  await expect(generateMiniMaxMusic("", { apiKey: "test" })).rejects.toThrow(/prompt/);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ base_resp: { status_code: 1008 } })));
  await expect(generateMiniMaxMusic("Quiet piano", { apiKey: "test" })).rejects.toThrow(/failed/);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private-test", { status: 401 })));
  await expect(generateMiniMaxMusic("Quiet piano", { apiKey: "test" })).rejects.toThrow("HTTP 401");
});
