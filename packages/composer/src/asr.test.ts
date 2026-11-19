import { describe, expect, it } from "vitest";
import { segmentTranscript, transcribeAudio, type ChatAudioClient } from "./asr";

describe("ASR transcript segmentation", () => {
  it("splits on punctuation, merges tiny tails, keeps proportional timing", () => {
    const segments = segmentTranscript("大家好，今天我们聊一聊熵增原理。生命为什么可以局部对抗无序？", 8000);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0]!.startMs).toBe(0);
    expect(segments[segments.length - 1]!.endMs).toBe(8000);
    // Contiguous coverage: each segment starts where the previous ended.
    for (let index = 1; index < segments.length; index++) expect(segments[index]!.startMs).toBe(segments[index - 1]!.endMs);
    expect(segments.map(segment => segment.text).join("")).toBe("大家好，今天我们聊一聊熵增原理。生命为什么可以局部对抗无序？");
  });
  it("rejects an empty transcript", () => {
    expect(() => segmentTranscript("  ", 1000)).toThrow(/empty/);
  });
  it("transcribes via the audio-capable chat client and labels timing as estimated", async () => {
    const client: ChatAudioClient = { chat: async () => ({ text: "“大家好，今天聊熵。”" }) };
    const transcript = await transcribeAudio({ audio: new Uint8Array([1, 2, 3]), format: "mp3", durationMs: 3000, model: "gem-3.8-flash", client });
    expect(transcript.text).toBe("大家好，今天聊熵。");
    expect(transcript.modelTimed).toBe(false);
    expect(transcript.segments[0]).toMatchObject({ startMs: 0, text: "大家好，今天聊熵。" });
  });
});
