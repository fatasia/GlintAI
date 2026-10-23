import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { NarrationAudio, narrationAudioTimingFrames } from "./NarrationAudio";

vi.mock("remotion", () => ({
  useVideoConfig: () => ({ fps: 30 }),
  staticFile: (src: string) => `/assets/${src}`,
  Sequence: ({ from, durationInFrames, children }: { from: number; durationInFrames: number; children: React.ReactNode }) =>
    createElement("section", { "data-from": from, "data-duration": durationInFrames }, children),
  Audio: ({ src, startFrom }: { src: string; startFrom: number }) =>
    createElement("audio", { src, "data-source-offset": startFrom }),
}));

const scene = parseProject({
  schemaVersion: 1, id: "audio", title: "Audio", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "Hi", audioRef: "voice.wav", durationMs: 2000 } }],
}).scenes[0]!;

describe("narration frame mapping", () => {
  it.each([
    [60, 0, 60, 0, 120],
    [60, 500, 75, 0, 105],
    [60, -500, 45, 0, 135],
    [0, -500, 0, 15, 180],
    [15, -1000, 0, 15, 180],
  ])("maps scene %s offset %s without losing source alignment", (start, offset, from, startFrom, durationInFrames) => {
    expect(narrationAudioTimingFrames(start, 180, 30, offset)).toEqual({ from, startFrom, durationInFrames });
  });
  it("handles invalid offsets as zero and rejects invalid timeline parameters", () => {
    for (const offset of [NaN, Infinity, -Infinity]) {
      expect(narrationAudioTimingFrames(30, 90, 30, offset)?.from).toBe(30);
    }
    for (const args of [[NaN, 90, 30], [0, NaN, 30], [0, 0, 30], [0, 90, 0], [0, 90, Infinity], [0.5, 90, 30]]) {
      expect(narrationAudioTimingFrames(args[0]!, args[1]!, args[2]!)).toBeNull();
    }
    expect(narrationAudioTimingFrames(90, 90, 30)).toBeNull();
    expect(narrationAudioTimingFrames(60, 90, 30, 1000)).toBeNull();
  });
  it("quantizes fractional frames, including negative offsets", () => {
    expect(narrationAudioTimingFrames(0, 90, 30, -51)?.startFrom).toBe(2);
    expect(narrationAudioTimingFrames(0, 90, 24, 51)?.from).toBe(1);
  });
});

describe("NarrationAudio wiring", () => {
  const render = (offset: number, audioRef: string | undefined = "voice.wav") => renderToStaticMarkup(createElement(NarrationAudio, {
    sceneStartFrame: 15, compositionDurationFrames: 120,
    scene: { ...scene, narration: { ...scene.narration, audioRef, audioOffsetMs: offset } },
  }));
  it("passes both the clipped source prefix and global placement to Remotion", () => {
    const markup = render(-1000);
    expect(markup).toContain('data-from="0"');
    expect(markup).toContain('data-source-offset="15"');
    expect(markup).toContain('data-duration="120"');
    expect(markup).toContain('src="/assets/voice.wav"');
  });
  it("allows audio across the visual scene boundary", () => {
    expect(render(1000)).toContain('data-from="45"');
    expect(render(1000)).toContain('data-duration="75"');
  });
  it("omits absent audio and audio beginning outside the composition", () => {
    expect(render(0, "")).toBe("");
    expect(render(5000)).toBe("");
  });
});
