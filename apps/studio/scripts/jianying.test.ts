import { describe, expect, it } from "vitest";
import { buildCaptionCues, buildProjectCues, exportJianyingDraft, formatSrt } from "./jianying";
import { parseProject } from "@glintai/scenescript";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("buildCaptionCues", () => {
  it("splits on punctuation using word timings", () => {
    const cues = buildCaptionCues("第一句话。第二句话!", 2000, [{
      text: "第一句话。第二句话!",
      words: [
        { text: "第一", startMs: 0, endMs: 200 },
        { text: "句话", startMs: 200, endMs: 400 },
        { text: "。", startMs: 400, endMs: 460 },
        { text: "第二", startMs: 900, endMs: 1100 },
        { text: "句话", startMs: 1100, endMs: 1300 },
        { text: "!", startMs: 1300, endMs: 1400 },
      ],
    }]);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 0, endMs: 460, text: "第一句话。" });
    expect(cues[1]).toEqual({ startMs: 900, endMs: 1400, text: "第二句话!" });
  });

  it("falls back to proportional timing without words", () => {
    const cues = buildCaptionCues("前半句,后半句。", 1000);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[1]!.endMs).toBe(1000);
    expect(cues[1]!.startMs).toBeGreaterThanOrEqual(cues[0]!.endMs - 1);
  });
});

describe("formatSrt", () => {
  it("formats sequential numbered cues", () => {
    const srt = formatSrt([
      { startMs: 0, endMs: 1500, text: "开场" },
      { startMs: 61_234, endMs: 63_000, text: "第二段" },
    ]);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\n开场");
    expect(srt).toContain("2\n00:01:01,234 --> 00:01:03,000\n第二段");
  });
});

describe("buildProjectCues", () => {
  it("offsets per-scene cues onto the absolute timeline", () => {
    const project = parseProject({
      schemaVersion: 1, id: "cue-demo", title: "偏移", aspect: "16:9",
      knowledgeSources: [],
      scenes: [
        { id: "one", kind: "title", title: "一", narration: { text: "第一句。", durationMs: 1000 } },
        { id: "two", kind: "bullets", items: ["甲"], narration: { text: "第二句。", durationMs: 1500 } },
      ],
    });
    const cues = buildProjectCues(project);
    expect(cues[0]!.startMs).toBe(0);
    expect(cues[1]!.startMs).toBeGreaterThanOrEqual(1000);
    expect(cues[1]!.endMs).toBeLessThanOrEqual(2500);
  });
});

describe("absolute caption offset boundaries", () => {
  const make = (scenes: object[]) => parseProject({
    schemaVersion: 1, id: "offset-cues", title: "Offset cues", aspect: "16:9", knowledgeSources: [], scenes,
  });
  const scene = (id: string, offset: number, words?: { text: string; startMs: number; endMs: number }[]) => ({
    id, kind: "title", title: id,
    narration: { text: `${id}!`, durationMs: 2000, audioOffsetMs: offset, segments: words ? [{ text: id, words }] : undefined },
  });

  it.each([500, -500])("adds scene start and signed offset %s before clipping", offset => {
    const p = make([
      scene("one", 0),
      scene("two", offset, [{ text: "Timed!", startMs: 100, endMs: 700 }]),
      scene("three", 0),
    ]);
    expect(buildProjectCues(p).find(cue => cue.text === "Timed!")).toEqual({
      text: "Timed!", startMs: 2100 + offset, endMs: 2700 + offset,
    });
  });
  it("clips a negative audio origin only after adding each cue's source time", () => {
    const p = make([scene("one", -1000, [
      { text: "Clipped!", startMs: 400, endMs: 1300 },
      { text: "Later!", startMs: 1400, endMs: 1900 },
    ])]);
    const cues = buildProjectCues(p);
    expect(cues).toEqual([
      { text: "Clipped!", startMs: 0, endMs: 300 },
      { text: "Later!", startMs: 400, endMs: 900 },
    ]);
    expect(formatSrt(cues)).toContain("00:00:00,000 --> 00:00:00,300\nClipped!");
    expect(formatSrt(cues)).toContain("00:00:00,400 --> 00:00:00,900\nLater!");
  });
  it("preserves the correct source position when a later scene's origin precedes the project", () => {
    const p = make([
      scene("one", 0),
      scene("two", -2500, [{ text: "Later source!", startMs: 800, endMs: 1300 }]),
    ]);
    expect(buildProjectCues(p).find(cue => cue.text === "Later source!")).toEqual({
      text: "Later source!", startMs: 300, endMs: 800,
    });
  });
  it("clips the composition end and removes wholly out-of-range, empty and nonpositive cues", () => {
    const p = make([
      scene("before", -2000),
      scene("middle", 0, [
        { text: "Empty duration!", startMs: 100, endMs: 100 },
        { text: "Reversed!", startMs: 500, endMs: 400 },
        { text: "Keep!", startMs: 1000, endMs: 1200 },
      ]),
      scene("end", 1500, [
        { text: "End clip!", startMs: 0, endMs: 800 },
        { text: "Outside!", startMs: 1000, endMs: 1200 },
      ]),
    ]);
    expect(buildProjectCues(p)).toEqual([
      { text: "Keep!", startMs: 3000, endMs: 3200 },
      { text: "End clip!", startMs: 5500, endMs: 6000 },
    ]);
  });
  it("omits narration containing only empty caption text and audio wholly after the project", () => {
    expect(buildProjectCues(make([scene("blank", 0, [{ text: "   ", startMs: 100, endMs: 500 }])]))).toEqual([]);
    expect(buildProjectCues(make([scene("outside", 2000)]))).toEqual([]);
  });
  it("sorts shifted cues globally while preserving source order for equal starts", () => {
    const p = make([
      scene("one", 1000, [{ text: "First tie!", startMs: 0, endMs: 200 }]),
      scene("two", -2000, [
        { text: "Earlier!", startMs: 100, endMs: 300 },
        { text: "Second tie!", startMs: 1000, endMs: 1300 },
      ]),
    ]);
    expect(buildProjectCues(p)).toEqual([
      { text: "Earlier!", startMs: 100, endMs: 300 },
      { text: "First tie!", startMs: 1000, endMs: 1200 },
      { text: "Second tie!", startMs: 1000, endMs: 1300 },
    ]);
  });
  it("uses overlap-adjusted scene starts and offsets estimated cues too", () => {
    const p = make([
      scene("one", 0),
      { ...scene("two", -500), transition: { in: "fade", overlapMs: 500 } },
    ]);
    expect(buildProjectCues(p)).toEqual([
      { text: "one!", startMs: 0, endMs: 2000 },
      { text: "two!", startMs: 1000, endMs: 3000 },
    ]);
  });
});

describe("exportJianyingDraft", () => {
  it("writes a draft with per-scene video segments, a text track and SRT", () => {
    const project = parseProject({
      schemaVersion: 1, id: "jy-demo", title: "剪映演示", aspect: "16:9",
      knowledgeSources: [],
      scenes: [
        { id: "one", kind: "title", title: "一", narration: { text: "第一句。", durationMs: 1000 } },
        { id: "two", kind: "bullets", items: ["甲"], narration: { text: "第二句。", durationMs: 1500 } },
      ],
    });
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-jy-"));
    const result = exportJianyingDraft({
      project,
      videoPath: path.join(outDir, "final.mp4"),
      videoSpec: { width: 1920, height: 1080, fps: 30, durationSec: 2.5 },
      outDir,
    });
    const draft = JSON.parse(fs.readFileSync(path.join(result.draftDir, "draft_content.json"), "utf8"));
    expect(draft.duration).toBe(2_500_000);
    expect(draft.materials.videos).toHaveLength(1);
    expect(draft.tracks.find((track: any) => track.type === "video").segments).toHaveLength(2);
    const textTrack = draft.tracks.find((track: any) => track.type === "text");
    expect(textTrack.segments.length).toBe(result.captionCueCount);
    // Segment boundaries follow the ms timeline in µs.
    expect(draft.tracks.find((t: any) => t.type === "video").segments[1].target_timerange.start).toBe(1_000_000);
    expect(fs.readFileSync(result.srtPath, "utf8")).toContain("-->");
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
