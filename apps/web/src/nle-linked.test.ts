import { describe, expect, it } from "vitest";
import { parseNleProject, nleMoveClip, type NleProject } from "@glintai/scenescript";
import { clampLinkedShift, moveLinkedClips, removeLinkedClips, removeMainWithLinked, mainTrackOf } from "./nle-linked";

const project = (): NleProject => parseNleProject({
  schemaVersion: 1, id: "linked", title: "联动", fps: 30, width: 640, height: 360,
  tracks: [
    { id: "v1", kind: "video", name: "主画面", clips: [{ id: "main", kind: "image", src: "assets/a.jpg", startMs: 1000, durationMs: 3000 }] },
    { id: "t1", kind: "text", name: "字幕", clips: [{ id: "cap", kind: "text", text: "标题", startMs: 1500, durationMs: 1200 }] },
    { id: "t2", kind: "text", name: "无关", clips: [{ id: "far", kind: "text", text: "别动我", startMs: 8000, durationMs: 1000 }] },
  ],
});

describe("linked editing (联动)", () => {
  it("moves overlapping caption/overlay clips with the main clip", () => {
    const moved = moveLinkedClips(project(), "v1", "main", 500);
    expect(moved.moved).toBe(1);
    expect(moved.project.tracks[1]!.clips[0]!.startMs).toBe(2000);
    expect(moved.project.tracks[2]!.clips[0]!.startMs).toBe(8000); // untouched
    // Main track itself is not double-moved here.
    expect(moved.project.tracks[0]!.clips[0]!.startMs).toBe(1000);
  });

  it("removes linked clips when the main clip is deleted", () => {
    const result = removeMainWithLinked(project(), "v1", "main");
    expect(result.removed).toBe(1);
    expect(result.project.tracks[1]!.clips).toEqual([]);
    expect(result.project.tracks[2]!.clips).toHaveLength(1);
    expect(result.project.tracks[0]!.clips).toEqual([]);
  });

  it("removes linked clips for arbitrary spans (split + delete each half)", () => {
    const spans = [{ start: 1000, end: 2000 }, { start: 2000, end: 4000 }];
    const result = removeLinkedClips(project(), "v1", spans);
    expect(result.removed).toBe(1);
    expect(result.project.tracks[1]!.clips).toEqual([]);
  });

  it("respects locked tracks and ignores audio tracks", () => {
    const locked = parseNleProject({ ...project(), tracks: project().tracks.map(track => track.id === "t1" ? { ...track, locked: true } : track) });
    const moved = moveLinkedClips(locked, "v1", "main", 500);
    expect(moved.moved).toBe(0);
    expect(moved.project).toEqual(locked);
    const removed = removeMainWithLinked(locked, "v1", "main");
    expect(removed.removed).toBe(0);
    expect(removed.project.tracks[1]!.clips).toHaveLength(1);
  });

  it("integrates with nleMoveClip: main moves first, linked follow the delta", () => {
    let next = nleMoveClip(project(), "v1", "main", 2000);
    const linked = moveLinkedClips(next, "v1", "main", 1000);
    next = linked.project;
    expect(next.tracks[0]!.clips[0]!.startMs).toBe(2000);
    expect(next.tracks[1]!.clips[0]!.startMs).toBe(2500);
  });

  it("finds the first unlocked video track as main", () => {
    const locked = parseNleProject({ ...project(), tracks: [{ ...project().tracks[0]!, locked: true }, project().tracks[1]!, { id: "v2", kind: "video", name: "备选", clips: [] }] });
    expect(mainTrackOf(locked)?.id).toBe("v2");
    expect(mainTrackOf(project())?.id).toBe("v1");
  });

  it("does not double-move a selected caption and moves captions of every selected main clip", () => {
    const two = parseNleProject({
      schemaVersion: 1, id: "linked-2", title: "联动", fps: 30, width: 640, height: 360,
      tracks: [
        { id: "v1", kind: "video", name: "主画面", clips: [
          { id: "main", kind: "image", src: "assets/a.jpg", startMs: 1000, durationMs: 2000 },
          { id: "main2", kind: "image", src: "assets/b.jpg", startMs: 3000, durationMs: 2000 },
        ] },
        { id: "t1", kind: "text", name: "字幕", clips: [
          { id: "cap", kind: "text", text: "第一镜", startMs: 1200, durationMs: 800 },
          { id: "cap2", kind: "text", text: "第二镜", startMs: 3200, durationMs: 800 },
        ] },
      ],
    });
    const bothSelected = moveLinkedClips(two, "v1", ["main", "main2"], 500, { excludeClipIds: ["cap", "cap2"] });
    expect(bothSelected.moved).toBe(0);
    const secondOnly = moveLinkedClips(two, "v1", ["main", "main2"], 500);
    expect(secondOnly.moved).toBe(2);
    expect(secondOnly.project.tracks[1]!.clips.map(clip => clip.startMs)).toEqual([1700, 3700]);
  });

  it("keeps a long bed or caption that covers several shots out of the link", () => {
    const long = parseNleProject({
      schemaVersion: 1, id: "linked-long", title: "联动", fps: 30, width: 640, height: 360,
      tracks: [
        { id: "v1", kind: "video", name: "主画面", clips: [{ id: "main", kind: "image", src: "assets/a.jpg", startMs: 1000, durationMs: 3000 }] },
        { id: "t1", kind: "text", name: "长字幕", clips: [{ id: "long", kind: "text", text: "跨镜", startMs: 0, durationMs: 9000 }] },
      ],
    });
    const moved = moveLinkedClips(long, "v1", "main", 500);
    expect(moved.moved).toBe(0);
    const removed = removeMainWithLinked(long, "v1", "main");
    expect(removed.removed).toBe(0);
    expect(removed.project.tracks[1]!.clips).toHaveLength(1);
  });

  it("reports the drag floor before moving so main and captions keep their offset", () => {
    const linked = parseNleProject({
      schemaVersion: 1, id: "linked-floor", title: "联动", fps: 30, width: 640, height: 360,
      tracks: [
        { id: "v1", kind: "video", name: "主画面", clips: [{ id: "main", kind: "image", src: "assets/a.jpg", startMs: 1000, durationMs: 2000 }] },
        { id: "t1", kind: "text", name: "字幕", clips: [{ id: "cap", kind: "text", text: "跨镜", startMs: 500, durationMs: 1500 }] },
      ],
    });
    expect(clampLinkedShift(linked, "v1", ["main"], -800)).toBe(-500);
    expect(clampLinkedShift(linked, "v1", ["main"], 400)).toBe(400);
    expect(clampLinkedShift(linked, "v1", ["main"], -200)).toBe(-200);
  });

  it("applies one clamped shift to the whole linked group instead of per-clip clamping", () => {
    const nearZero = parseNleProject({
      schemaVersion: 1, id: "linked-edge", title: "联动", fps: 30, width: 640, height: 360,
      tracks: [
        { id: "v1", kind: "video", name: "主画面", clips: [{ id: "main", kind: "image", src: "assets/a.jpg", startMs: 200, durationMs: 2000 }] },
        { id: "t1", kind: "text", name: "字幕", clips: [
          { id: "early", kind: "text", text: "早", startMs: 500, durationMs: 1500 },
          { id: "late", kind: "text", text: "晚", startMs: 1200, durationMs: 600 },
        ] },
      ],
    });
    // main was dragged from 1000 to 200; linked clips clamp at the timeline origin together.
    const moved = moveLinkedClips(nearZero, "v1", "main", -800);
    expect(moved.moved).toBe(2);
    expect(moved.project.tracks[1]!.clips.map(clip => clip.startMs)).toEqual([0, 700]);
  });
});
