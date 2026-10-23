import { describe, expect, it, afterAll, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { narrationAudioTimingFrames } from "../../../packages/video/src/components/NarrationAudio";
import { runMediaProcess } from "./native-process";
import { cacheArtifactValid } from "./native-cache";

vi.mock("./native-process", async (original) => ({
  ...await original<typeof import("./native-process")>(),
  runMediaProcess: vi.fn(async () => { throw new Error("captured ffmpeg invocation"); }),
}));
vi.mock("./native-cache", async (original) => ({
  ...await original<typeof import("./native-cache")>(),
  cacheArtifactValid: vi.fn(() => false),
}));
// Fail closed if a regression attempts to synthesize speech in these offline tests.
vi.mock("@glintai/tts", async (original) => ({
  ...await original<typeof import("@glintai/tts")>(),
  synthesizeBatch: vi.fn(() => { throw new Error("TTS forbidden in audio tests"); }),
}));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioMixKey, chooseNativeTts, narrationAudioTimingMs, prepareNativeAudio } from "./native-audio";

const roots: string[] = [];
function wav(name: string, bytes: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-audio-test-"));
  roots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

describe("audio mix key", () => {
  it("is stable for identical inputs", () => {
    const file = wav("a.wav", 100);
    const inputs = ["-i", file], filters = ["[0:a]volume=1[t0]"];
    expect(audioMixKey(inputs, filters, 1000, 30)).toBe(audioMixKey(inputs, filters, 1000, 30));
  });
  it("changes when the filter, duration, fps or input file changes", () => {
    const file = wav("a.wav", 100);
    const inputs = ["-i", file], filters = ["[0:a]volume=1[t0]"];
    const base = audioMixKey(inputs, filters, 1000, 30);
    expect(audioMixKey(inputs, ["[0:a]volume=0.5[t0]"], 1000, 30)).not.toBe(base);
    expect(audioMixKey(inputs, filters, 1200, 30)).not.toBe(base);
    expect(audioMixKey(inputs, filters, 1000, 60)).not.toBe(base);
    fs.writeFileSync(file, Buffer.alloc(200, 1));
    expect(audioMixKey(inputs, filters, 1000, 30)).not.toBe(base);
  });
});

describe("narration audio offset", () => {
  it.each([[0, -500], [500, -1000], [2000, -500], [2000, 500], [0, 0]])(
    "matches Remotion placement and source trim at %s + %s ms", (start, offset) => {
      const native = narrationAudioTimingMs(start, offset)!;
      const remotion = narrationAudioTimingFrames(start / 1000 * 30, 300, 30, offset)!;
      expect(native.startMs).toBe(remotion.from / 30 * 1000);
      expect(native.sourceOffsetMs).toBe(remotion.startFrom / 30 * 1000);
    },
  );
  it("rejects invalid starts and treats nonfinite offsets as zero", () => {
    expect(narrationAudioTimingMs(NaN)).toBeNull();
    expect(narrationAudioTimingMs(Infinity)).toBeNull();
    for (const offset of [NaN, Infinity, -Infinity]) {
      expect(narrationAudioTimingMs(500, offset)).toEqual({ startMs: 500, sourceOffsetMs: 0 });
    }
  });
  const projectWithAudio = (offset: number) => {
    const file = wav("voice.wav", 100);
    return { root: path.dirname(file), project: parseProject({
      schemaVersion: 1, id: "audio", title: "Audio", aspect: "16:9", knowledgeSources: [],
      scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "Hi", audioRef: "voice.wav", durationMs: 2000, audioOffsetMs: offset } }],
    }) };
  };
  it.each([false, true])("trims source before delay and retains narration in plate=%s", async (plate) => {
    const { root, project } = projectWithAudio(-500);
    vi.mocked(runMediaProcess).mockClear();
    await expect(prepareNativeAudio(project, root, root, { tts: "existing", music: "off", plate })).rejects.toThrow("captured ffmpeg");
    const args = vi.mocked(runMediaProcess).mock.calls[0]![1];
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("atrim=start=0.5,asetpts=PTS-STARTPTS,aresample=44100,adelay=0:all=1");
    expect(project.scenes[0]!.narration.audioOffsetMs).toBe(-500);
  });
  it("delays positive offsets without trimming the source", async () => {
    const { root, project } = projectWithAudio(500);
    vi.mocked(runMediaProcess).mockClear();
    await expect(prepareNativeAudio(project, root, root, { tts: "existing", music: "off" })).rejects.toThrow("captured ffmpeg");
    const args = vi.mocked(runMediaProcess).mock.calls[0]![1];
    const filter = args[args.indexOf("-filter_complex") + 1]!;
    expect(filter).toContain("adelay=500:all=1");
    expect(filter).not.toContain("atrim");
  });
  it("skips audio starting beyond the composition and mock narration", async () => {
    const { root, project } = projectWithAudio(3000);
    vi.mocked(runMediaProcess).mockClear();
    expect((await prepareNativeAudio(project, root, root, { tts: "existing", music: "off" })).audioPath).toBeUndefined();
    expect((await prepareNativeAudio(project, root, root, { tts: "mock", music: "off" })).audioPath).toBeUndefined();
    expect(runMediaProcess).not.toHaveBeenCalled();
  });
  it("reuses content cache while offset changes invalidate the mix key", async () => {
    const { root, project } = projectWithAudio(0);
    vi.mocked(cacheArtifactValid).mockReturnValue(true);
    vi.mocked(runMediaProcess).mockClear();
    try {
      const first = await prepareNativeAudio(project, root, root, { tts: "existing", music: "off" });
      const again = await prepareNativeAudio(project, root, root, { tts: "existing", music: "off" });
      project.scenes[0]!.narration.audioOffsetMs = -500;
      const shifted = await prepareNativeAudio(project, root, root, { tts: "existing", music: "off" });
      expect(again.audioPath).toBe(first.audioPath);
      expect(shifted.audioPath).not.toBe(first.audioPath);
      expect(runMediaProcess).not.toHaveBeenCalled();
    } finally { vi.mocked(cacheArtifactValid).mockReturnValue(false); }
  });
});

describe("offline speech selection", () => {
  it("never probes the network when GLINT_TTS_OFFLINE=1", async () => {
    const previous = process.env.GLINT_TTS_OFFLINE;
    process.env.GLINT_TTS_OFFLINE = "1";
    try {
      if (process.platform === "win32") {
        const provider = await chooseNativeTts("auto");
        expect(provider.name).toBe("windows-sapi");
      } else {
        await expect(chooseNativeTts("auto")).rejects.toThrow(/GLINT_TTS_OFFLINE=1/);
      }
    } finally {
      if (previous === undefined) delete process.env.GLINT_TTS_OFFLINE;
      else process.env.GLINT_TTS_OFFLINE = previous;
    }
  });
});