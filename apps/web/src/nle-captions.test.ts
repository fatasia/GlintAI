import { describe, expect, it } from "vitest";
import { nleSourceTimeMs } from "@glintai/scenescript";
import { captionCuesForClip } from "./nle-captions";

const transcript = { segments: [
  { text: "第一句", startMs: 2000, endMs: 3000 },
  { text: "第二句", startMs: 3000, endMs: 4000 },
  { text: "片段外", startMs: 5000, endMs: 6000 },
  { text: "  ", startMs: 3000, endMs: 3100 },
] };
const linear = { id: "a", kind: "audio" as const, startMs: 1000, durationMs: 4000, trimStartMs: 2000, speed: 2 };

describe("caption source-time mapping", () => {
  it("maps whole-file ASR times through trim and speed onto the timeline", () => {
    const cues = captionCuesForClip(transcript, linear);
    expect(cues.map(cue => [cue.text, cue.startMs, cue.durationMs])).toEqual([
      ["第一句", 1000, 500],
      ["第二句", 1500, 500],
      ["片段外", 2500, 500],
    ]);
  });

  it("drops captions before the in-point or after the clip end", () => {
    const cues = captionCuesForClip({ segments: [
      { text: "前", startMs: 0, endMs: 500 },
      { text: "后", startMs: 12000, endMs: 13000 },
    ] }, linear);
    expect(cues).toEqual([]);
  });

  it("uses the inverse curve clock and keeps a minimum readable duration", () => {
    const curved = { id: "b", kind: "audio" as const, startMs: 0, durationMs: 1000, trimStartMs: 500, speedCurve: "bell" as const };
    const source = nleSourceTimeMs(curved, 500), sourceEnd = nleSourceTimeMs(curved, 510);
    const cues = captionCuesForClip({ segments: [{ text: "钟形", startMs: source, endMs: sourceEnd }] }, curved);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.startMs).toBeGreaterThanOrEqual(499);
    expect(cues[0]!.startMs).toBeLessThanOrEqual(501);
    expect(cues[0]!.durationMs).toBeGreaterThanOrEqual(200);
    expect(cues[0]!.startMs + cues[0]!.durationMs).toBeLessThanOrEqual(1000);
  });
});
