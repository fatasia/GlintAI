import { describe, expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { applyCatalogChoice, catalogBlockReason, catalogPreviewProject, type CatalogChoice } from "./nle-catalog";
import { createNleSession } from "./nle-session";

const target = { trackId: "v1", clipId: "image-a" };
const project = parseNleProject({ schemaVersion: 1, id: "catalog", title: "库", fps: 30, width: 640, height: 360, tracks: [
  { id: "v1", name: "画面", kind: "video", clips: [{ id: "image-a", kind: "image", src: "assets/a.jpg", startMs: 1000, durationMs: 3000,
    mask: { shape: "circle" }, transitionOut: { type: "fade", durationMs: 500 } }] },
  { id: "a1", name: "音频", kind: "audio", clips: [{ id: "audio-a", kind: "audio", src: "assets/a.mp3", startMs: 0, durationMs: 4000 }] },
] });
const choice: CatalogChoice = { kind: "filter", presetId: "silver-mono", strength: 100, edge: "in", durationMs: 500 };

describe("NLE preset catalog", () => {
  it("applies existing local recipes without changing timing or unrelated content", () => {
    const result = applyCatalogChoice(project, target, choice);
    expect(result.tracks[0]!.clips[0]).toMatchObject({ startMs: 1000, durationMs: 3000, mask: { shape: "circle" }, effects: [
      { kind: "grayscale", value: 1 }, { kind: "contrast", value: 1.08 },
    ] });
    expect(result.tracks[1]).toEqual(project.tracks[1]);
    expect(project.tracks[0]!.clips[0]!.effects).toBeUndefined();
  });

  it("zero strength and original remove effects but preserve masks and transitions", () => {
    const filtered = applyCatalogChoice(project, target, choice);
    for (const change of [{ ...choice, strength: 0 }, { ...choice, presetId: "original" }]) {
      expect(applyCatalogChoice(filtered, target, change).tracks[0]!.clips[0]).toMatchObject({
        effects: [], mask: { shape: "circle" }, transitionOut: { type: "fade" },
      });
    }
  });

  it("applies only the selected transition edge and can remove it", () => {
    const transition = { ...choice, kind: "transition", presetId: "wipe" } as const;
    const entered = applyCatalogChoice(project, target, transition);
    expect(entered.tracks[0]!.clips[0]).toMatchObject({ transitionIn: { type: "wipe", durationMs: 500 }, transitionOut: { type: "fade" } });
    const removed = applyCatalogChoice(entered, target, { ...transition, presetId: "none" });
    expect(removed.tracks[0]!.clips[0]!.transitionIn).toBeUndefined();
    expect(removed.tracks[0]!.clips[0]!.transitionOut?.type).toBe("fade");
  });

  it("previews in isolation without modifying the editor document", () => {
    const preview = catalogPreviewProject(project, target, choice)!;
    expect(preview.tracks).toHaveLength(1);
    expect(preview.tracks[0]!.clips[0]).toMatchObject({ startMs: 0, durationMs: 3000 });
    expect(preview.tracks[0]!.clips[0]!.transitionOut).toBeUndefined();
    expect(project.tracks[0]!.clips[0]!.startMs).toBe(1000);
    expect(catalogPreviewProject(project, { trackId: "a1", clipId: "audio-a" }, choice)).toBeNull();
  });

  it("rejects locked, missing and audio targets with a reason", () => {
    const locked = parseNleProject({ ...project, tracks: project.tracks.map(track => ({ ...track, locked: true })) });
    expect(() => applyCatalogChoice(locked, target, choice)).toThrow("锁定");
    expect(() => applyCatalogChoice(project, { trackId: "a1", clipId: "audio-a" }, choice)).toThrow("音频");
    expect(catalogBlockReason(project, null, "filter")).toContain("选择");
    expect(() => applyCatalogChoice(project, { ...target, clipId: "missing" }, choice)).toThrow("选择");
  });

  it("preserves animated effects by blocking replacement, not transitions", () => {
    const animated = parseNleProject({ ...project, tracks: project.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip,
      effects: [{ id: "contrast-animated", kind: "contrast", value: 1, keyframes: [{ atMs: 0, value: 1 }, { atMs: 1000, value: 2 }] }],
    })) })) });
    expect(() => applyCatalogChoice(animated, target, choice)).toThrow("关键帧");
    const next = applyCatalogChoice(animated, target, { ...choice, kind: "transition", presetId: "fade" });
    expect(next.tracks[0]!.clips[0]!.effects).toEqual(animated.tracks[0]!.clips[0]!.effects);
  });

  it("rejects unknown presets and invalid numeric parameters", () => {
    expect(() => applyCatalogChoice(project, target, { ...choice, presetId: "missing" })).toThrow("未找到");
    expect(() => applyCatalogChoice(project, target, { ...choice, strength: NaN })).toThrow();
    expect(() => applyCatalogChoice(project, target, { ...choice, kind: "transition", presetId: "fade", durationMs: -1 })).toThrow();
  });

  it("records application as one reversible session transaction", () => {
    const session = createNleSession(project);
    const next = applyCatalogChoice(project, target, choice);
    expect(session.apply(next, "应用滤镜").ok).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.document()).toEqual(project);
    expect(session.redo()).toBe(true);
    expect(session.document()).toEqual(next);
  });
});
