import { describe, expect, it } from "vitest";
import {
  applyNleToSceneScript,
  buildTimeline,
  nleMoveClip,
  nleRemoveClip,
  nleTrimClip,
  parseProject,
  sceneScriptToNle,
} from "./index";

/**
 * Round-trip fixtures for the SceneScript ⇄ NLE bridge (CORE-04/CORE-05).
 * The contract under test: identity links, timing, order and raster source
 * ranges survive projection → edit → write-back without silent loss.
 */

function filmProject() {
  return parseProject({
    schemaVersion: 1,
    id: "bridge-demo",
    title: "桥接演示",
    aspect: "16:9",
    knowledgeSources: [],
    scenes: [
      { id: "intro", kind: "title", title: "熵与生命", narration: { text: "今天我们聊熵。", durationMs: 2000 } },
      { id: "points", kind: "bullets", heading: "三条事实", items: ["孤立系统", "熵增", "局部有序"], narration: { text: "三条事实。", durationMs: 3000, audioRef: "assets/voice-points.mp3" } },
      { id: "versus", kind: "comparison", left: { label: "开放", points: ["有输入"] }, right: { label: "孤立", points: ["无输入"] }, narration: { text: "对比一下。", durationMs: 2500 } },
      { id: "flow", kind: "diagram", steps: [{ label: "输入" }, { label: "耗散" }, { label: "结构" }], narration: { text: "流程是这样。", durationMs: 2200 } },
      { id: "clip", kind: "video", src: "assets/b-roll.mp4", trimStartSec: 1.5, speed: 2, narration: { text: "看素材。", durationMs: 4000 } },
      { id: "poster", kind: "image", src: "assets/poster.png", narration: { text: "一张图。", durationMs: 1500 } },
    ],
  });
}

describe("sceneScriptToNle", () => {
  it("projects one visual clip per scene with identity links and timeline timing", () => {
    const project = filmProject();
    const timeline = buildTimeline(project);
    const { nle, links } = sceneScriptToNle(project);
    const allClips = nle.tracks.flatMap(track => track.clips.map(clip => ({ trackId: track.id, clip })));
    expect(allClips.filter(({ clip }) => clip.id.startsWith("scene-"))).toHaveLength(project.scenes.length);
    expect(links).toHaveLength(project.scenes.length);
    for (const [index, link] of links.entries()) {
      const entry = timeline.entries[index]!;
      expect(link.sceneId).toBe(entry.scene.id);
      expect(link.clipId).toBe(`scene-${entry.scene.id}`);
      expect(link.startMs).toBe(entry.startMs);
      expect(link.durationMs).toBe(entry.durationMs);
      const found = allClips.find(({ trackId, clip }) => trackId === link.trackId && clip.id === link.clipId);
      expect(found?.clip.startMs).toBe(entry.startMs);
      expect(found?.clip.durationMs).toBe(entry.durationMs);
    }
  });

  it("maps raster kinds to media clips and carries source ranges", () => {
    const { nle } = sceneScriptToNle(filmProject());
    const video = nle.tracks.flatMap(track => track.clips).find(clip => clip.id === "scene-clip");
    expect(video).toMatchObject({ kind: "video", src: "assets/b-roll.mp4", trimStartMs: 1500, speed: 2 });
    const image = nle.tracks.flatMap(track => track.clips).find(clip => clip.id === "scene-poster");
    expect(image).toMatchObject({ kind: "image", src: "assets/poster.png" });
    const text = nle.tracks.flatMap(track => track.clips).find(clip => clip.id === "scene-versus");
    expect(text?.kind).toBe("text");
  });

  it("puts local narration audio on the audio track and reports non-local refs", () => {
    const project = filmProject();
    project.scenes[2]!.narration.audioRef = "https://example.com/voice.mp3";
    const { nle, skippedAudio } = sceneScriptToNle(project);
    const audio = nle.tracks.find(track => track.id === "a1")?.clips ?? [];
    expect(audio.map(clip => clip.id)).toEqual(["voice-points"]);
    expect(skippedAudio).toEqual([{ sceneId: "versus", audioRef: "https://example.com/voice.mp3" }]);
  });

  it("sizes the timeline from the aspect ratio and keeps fps", () => {
    const project = filmProject();
    project.aspect = "9:16";
    project.fps = 24;
    const { nle } = sceneScriptToNle(project);
    expect(nle).toMatchObject({ width: 720, height: 1280, fps: 24 });
  });
});

describe("applyNleToSceneScript", () => {
  it("writes trimmed clip durations back as narration durations and keeps everything else", () => {
    const project = filmProject();
    const { nle, links } = sceneScriptToNle(project);
    const before = buildTimeline(project);
    const trimmed = nleTrimClip(nle, "ov1", "scene-points", "end", -1000);
    const result = applyNleToSceneScript(project, { links }, trimmed);
    expect(result.missing).toEqual([]);
    const edited = result.project.scenes.find(scene => scene.id === "points")!;
    expect(edited.narration.durationMs).toBe(2000);
    const after = buildTimeline(result.project);
    expect(after.totalMs).toBe(before.totalMs - 1000);
    // Untouched scenes keep their narration text and kind.
    expect(result.project.scenes.find(scene => scene.id === "flow")?.narration.text).toBe("流程是这样。");
    expect(result.project.scenes.map(scene => scene.kind)).toEqual(project.scenes.map(scene => scene.kind));
  });

  it("restores video source range and speed from the clip", () => {
    const project = filmProject();
    const { nle, links } = sceneScriptToNle(project);
    const clip = nle.tracks.flatMap(track => track.clips).find(candidate => candidate.id === "scene-clip")!;
    const edited = { ...nle, tracks: nle.tracks.map(track => track.id !== "v1" ? track : { ...track, clips: track.clips.map(candidate => candidate.id !== "scene-clip" ? candidate : { ...clip, trimStartMs: 3000, speed: 1 } as typeof clip) }) };
    const result = applyNleToSceneScript(project, { links }, edited);
    const scene = result.project.scenes.find(candidate => candidate.id === "clip")!;
    expect(scene.kind).toBe("video");
    if (scene.kind === "video") expect([scene.trimStartSec, scene.speed]).toEqual([3, 1]);
  });

  it("reorders scenes when clips are moved", () => {
    const project = filmProject();
    const { nle, links } = sceneScriptToNle(project);
    // Move the intro clip after the bullets clip by swapping their starts.
    const introClip = nle.tracks.flatMap(track => track.clips).find(clip => clip.id === "scene-intro")!;
    const pointsClip = nle.tracks.flatMap(track => track.clips).find(clip => clip.id === "scene-points")!;
    const moved = nleMoveClip(nleMoveClip(nle, "ov1", "scene-intro", pointsClip.startMs), "ov1", "scene-points", introClip.startMs);
    const result = applyNleToSceneScript(project, { links }, moved);
    expect(result.project.scenes.map(scene => scene.id)).toEqual(["points", "intro", "versus", "flow", "clip", "poster"]);
  });

  it("reports deleted clips as missing and never deletes the scene", () => {
    const project = filmProject();
    const { nle, links } = sceneScriptToNle(project);
    const cut = nleRemoveClip(nle, "ov1", "scene-flow");
    const result = applyNleToSceneScript(project, { links }, cut);
    expect(result.missing.map(link => link.sceneId)).toEqual(["flow"]);
    expect(result.project.scenes.map(scene => scene.id)).toContain("flow");
    expect(result.project.scenes.find(scene => scene.id === "flow")!.narration.durationMs).toBe(2200);
  });

  it("round-trips a projected film unchanged when the NLE is untouched", () => {
    const project = filmProject();
    const projection = sceneScriptToNle(project);
    const result = applyNleToSceneScript(project, projection, projection.nle);
    expect(result.missing).toEqual([]);
    expect(buildTimeline(result.project).totalMs).toBe(buildTimeline(project).totalMs);
    expect(result.project.scenes.map(scene => scene.id)).toEqual(project.scenes.map(scene => scene.id));
  });
});

describe("clip id clamping", () => {
  it("rejects scene ids that collide after clipping to the NLE id limit", () => {
    const project = filmProject();
    // Two ids sharing their first 58 chars would both clamp to the same clip id.
    const long = "a".repeat(58);
    project.scenes = [
      { id: `${long}x`, kind: "title", title: "A", narration: { text: "x", durationMs: 1000 } },
      { id: `${long}y`, kind: "title", title: "B", narration: { text: "y", durationMs: 1000 } },
    ] as typeof project.scenes;
    expect(() => sceneScriptToNle(project)).toThrow(/collides/);
  });

  it("keeps long but unique ids projectable inside the 64-char clip id limit", () => {
    const project = filmProject();
    const long = "b".repeat(64);
    project.scenes = [{ id: long, kind: "title", title: "长ID", narration: { text: "x", durationMs: 1000 } }] as typeof project.scenes;
    const { nle, links } = sceneScriptToNle(project);
    expect(links[0]!.clipId.length).toBeLessThanOrEqual(64);
    expect(nle.tracks.flatMap(track => track.clips)[0]!.id).toBe(links[0]!.clipId);
  });
});
