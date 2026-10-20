import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabsTtsProvider, FishTtsProvider, MiniMaxTtsProvider } from "./cloud";
import { configuredVoiceEngines, createConfiguredTtsProvider } from "./configured";
import { createSilentWav } from "./wav";
afterEach(() => vi.unstubAllGlobals());
// Synthetic MPEG1 Layer3 frames: deterministic protocol fixture, not voice quality evidence.
function mp3() { const data = Buffer.alloc(417 * 40); for (let i = 0; i < data.length; i += 417) data.set([255, 251, 144, 0], i); return data; }
function elevenReply() { return { audio_base64: mp3().toString("base64"), alignment: { characters: ["H", "i"], character_start_times_seconds: [0, 0.3], character_end_times_seconds: [0.3, 0.7] } }; }
it("sends native ElevenLabs voice/model/speed and preserves alignment", async () => {
  const fetch = vi.fn(async () => Response.json(elevenReply())); vi.stubGlobal("fetch", fetch);
  const provider = new ElevenLabsTtsProvider({ apiKey: "private-test", voiceId: "default", model: "eleven_v3" });
  const result = await provider.synthesize({ text: "Hi", voice: "speaker2", speakingRate: 1.1 });
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(request[0]).toContain("speaker2/with-timestamps");
  expect(JSON.parse(request[1].body as string)).toMatchObject({ model_id: "eleven_v3", voice_settings: { speed: 1.1 } });
  expect(result.words).toEqual([{ text: "H", startMs: 0, endMs: 300 }, { text: "i", startMs: 300, endMs: 700 }]);
  expect(provider.cacheKey).not.toContain("private-test");
});
it("fails closed on missing/malformed timing or invalid audio", async () => {
  const provider = new ElevenLabsTtsProvider({ apiKey: "test", voiceId: "speaker" });
  for (const body of [{ ...elevenReply(), alignment: null }, { ...elevenReply(), audio_base64: "bm90IGF1ZGlv" }, { ...elevenReply(), alignment: { characters: ["x"], character_start_times_seconds: [-1], character_end_times_seconds: [1] } }]) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
    await expect(provider.synthesize({ text: "Hi" })).rejects.toThrow();
  }
});
it("sends Fish hosted voice settings and measures the returned WAV", async () => {
  const fetch = vi.fn(async () => new Response(Buffer.from(createSilentWav(1000)))); vi.stubGlobal("fetch", fetch);
  const provider = new FishTtsProvider({ apiKey: "private-test", referenceId: "ref", model: "s2.1-pro" });
  const result = await provider.synthesize({ text: "Hello", voice: "ref2", speakingRate: 0.9 });
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(request[0]).toBe("https://api.fish.audio/v1/tts");
  expect(JSON.parse(request[1].body as string)).toMatchObject({ reference_id: "ref2", prosody: { speed: 0.9 }, format: "wav" });
  expect(result.durationMs).toBe(1000); expect(provider.cacheKey).not.toContain("private-test");
});
it("does not expose upstream errors and honors cancellation before sending", async () => {
  const fetch = vi.fn(async () => new Response("private-test", { status: 401 })); vi.stubGlobal("fetch", fetch);
  const provider = new FishTtsProvider({ apiKey: "private-test", referenceId: "ref" });
  await expect(provider.synthesize({ text: "Hi" })).rejects.toThrow("HTTP 401");
  const controller = new AbortController(); controller.abort();
  await expect(provider.synthesize({ text: "Hi", signal: controller.signal })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects invalid voice IDs/speeds and oversized responses", async () => {
  const provider = new ElevenLabsTtsProvider({ apiKey: "test", voiceId: "speaker" });
  await expect(provider.synthesize({ text: "Hi", voice: "../escape" })).rejects.toThrow(/voice ID/);
  await expect(provider.synthesize({ text: "Hi", speakingRate: 2 })).rejects.toThrow(/speed/);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(49 * 1024 * 1024)); controller.close(); } }))));
  await expect(provider.synthesize({ text: "Hi" })).rejects.toThrow(/size limit/);
});
it("advertises only configured engines, never credentials, and rejects unavailable engines", () => {
  expect(configuredVoiceEngines({}, "linux")).toEqual(["mock", "edge"]);
  const env = { GLINT_ELEVENLABS_API_KEY: "private-test", GLINT_ELEVENLABS_VOICE: "voice" };
  expect(configuredVoiceEngines(env, "linux")).toEqual(["mock", "edge", "elevenlabs"]);
  expect(createConfiguredTtsProvider("elevenlabs", env).name).toBe("elevenlabs");
  expect(() => createConfiguredTtsProvider("fish", {})).toThrow(/unavailable/);
});
it("uses MiniMax hex WAV and rejects API-level errors even over HTTP 200", async () => {
  const fetch = vi.fn(async () => Response.json({ base_resp: { status_code: 0 }, data: { status: 2, audio: Buffer.from(createSilentWav(1000)).toString("hex") } })); vi.stubGlobal("fetch", fetch);
  const provider = new MiniMaxTtsProvider({ apiKey: "private-test", voiceId: "speaker" });
  expect((await provider.synthesize({ text: "Test" })).durationMs).toBe(1000);
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe("https://api.minimax.io/v1/t2a_v2");
  expect(JSON.parse(call[1].body as string)).toMatchObject({ stream: false, output_format: "hex", voice_setting: { voice_id: "speaker" } });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ base_resp: { status_code: 1008, status_msg: "private-test" } })));
  await expect(provider.synthesize({ text: "Test" })).rejects.toThrow("MiniMax synthesis failed");
});
