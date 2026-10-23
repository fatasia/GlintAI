import { describe, expect, it } from "vitest";
import { importJianyingDraft, looksEncrypted } from "./jianying-import";

const US = 1_000_000;
/** Shaped like a real draft_content.json (µs timebase, materials/tracks/segments). */
const draft = {
  fps: 30,
  canvas_config: { width: 1080, height: 1920 },
  duration: 9 * US,
  materials: {
    videos: [
      { id: "mat-main", type: "video", path: "F:/素材/旅拍 A 音.mp4", duration: 12 * US, has_audio: 1 },
      { id: "mat-photo", type: "photo", path: "F:/素材/海报,-final.PNG", duration: 5 * US },
      { id: "mat-noext", type: "video", path: "F:/素材/未命名" },
    ],
    audios: [{ id: "mat-bgm", path: "F:/素材/bgm 主题.mp3", duration: 30 * US }],
    texts: [
      { id: "mat-title", content: JSON.stringify({ text: "旅行 vlog", styles: [{ size: 8, fill: { content: { solid: { color: [1, 0.6, 0] } } } }] }) },
      { id: "mat-empty", content: JSON.stringify({ text: "  " }) },
    ],
  },
  tracks: [
    { id: "track-v1", type: "video", segments: [
      { id: "seg-main", material_id: "mat-main", target_timerange: { start: 0, duration: 4 * US }, source_timerange: { start: 3 * US, duration: 4 * US }, clip: { alpha: 1, speed: 2 } },
    ] },
    { id: "track-v2", type: "video", segments: [
      { id: "seg-photo", material_id: "mat-photo", target_timerange: { start: 1 * US, duration: 2 * US }, source_timerange: { start: 0, duration: 2 * US }, clip: { alpha: 1, scale: 1.5, rotation: -90 } },
    ] },
    { id: "track-t", type: "text", segments: [
      { id: "seg-title", material_id: "mat-title", target_timerange: { start: 0.5 * US, duration: 2 * US }, source_timerange: null, clip: { alpha: 0.8 } },
      { id: "seg-empty", material_id: "mat-empty", target_timerange: { start: 3 * US, duration: 1 * US }, clip: {} },
    ] },
    { id: "track-a", type: "audio", segments: [
      { id: "seg-bgm", material_id: "mat-bgm", target_timerange: { start: 0, duration: 9 * US }, source_timerange: { start: 2 * US, duration: 9 * US }, clip: { alpha: 1, speed: 1 } },
    ] },
    { id: "track-fx", type: "effect", segments: [{ id: "seg-fx", material_id: "mat-fx", target_timerange: { start: 0, duration: US }, clip: {} }] },
  ],
};

describe("JianYing draft import", () => {
  it("maps tracks, µs timebase, trims, speed, transform and text", () => {
    const result = importJianyingDraft(draft);
    const project = result.project;
    expect(project.width).toBe(1080);
    expect(project.height).toBe(1920);
    expect(project.tracks.map(track => track.kind)).toEqual(["video", "overlay", "text", "audio"]);
    const [main] = project.tracks[0]!.clips;
    expect(main).toMatchObject({ kind: "video", src: "assets/A.mp4", startMs: 0, durationMs: 4000, trimStartMs: 3000, speed: 2 });
    const photo = project.tracks[1]!.clips[0]!;
    expect(photo).toMatchObject({ kind: "image", startMs: 1000, durationMs: 2000, transform: { scale: 1.5, rotate: -90 } });
    const title = project.tracks[2]!.clips[0]!;
    expect(title).toMatchObject({ kind: "text", text: "旅行 vlog", startMs: 500, durationMs: 2000, opacity: 0.8, color: "#ff9900", fontSize: 96 });
    const bgm = project.tracks[3]!.clips[0]!;
    expect(bgm).toMatchObject({ kind: "audio", startMs: 0, durationMs: 9000, trimStartMs: 2000 });
    expect(result.mapping.map(item => item.library)).toEqual(["A.mp4", "final.png", "bgm.mp3"]);
  });

  it("reports unmapped media, skipped tracks and empty text as skipped/warnings", () => {
    const result = importJianyingDraft(draft, name => name === "A.mp4");
    expect(result.skipped["effect 轨道"]).toBe(1);
    expect(result.skipped["空文字"]).toBe(1);
    expect(result.skipped["未映射的 video 素材"]).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/2 个素材不在素材库/);
    expect(result.mapping.find(item => item.library === "A.mp4")?.found).toBe(true);
  });

  it("detects encrypted drafts (JianYing 6.x draft encryption)", () => {
    expect(looksEncrypted("3fijX3OIiJfp0JifntTfdcgifjRQD1E6MG7JFCYAjB1fSy1JB4GXrAhz/xph2i6m4")).toBe(true);
    expect(looksEncrypted('{"fps":30,"materials":{},"tracks":[]}')).toBe(false);
  });
  it("rejects documents that are not JianYing drafts", () => {
    expect(() => importJianyingDraft({ hello: 1 })).toThrow(/剪映草稿/);
    expect(() => importJianyingDraft(null)).toThrow(/剪映草稿/);
    expect(() => importJianyingDraft({ materials: {}, tracks: "no" })).toThrow(/剪映草稿/);
  });
});
