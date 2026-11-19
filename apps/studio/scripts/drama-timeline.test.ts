import { describe, expect, it } from "vitest";
import { nleDurationMs, type NleClip } from "@glintai/scenescript";
import type { VideoPlan } from "@glintai/composer/plan";
import { buildDramaTimeline } from "./drama-timeline";

const plan: VideoPlan = {
  title: "短剧·第1集",
  hook: "第一场",
  audience: "短剧观众",
  platform: "9:16",
  theme: "blackboard-tech",
  totalSeconds: 6,
  takeaway: "2 场",
  scenes: [
    { goal: "茶馆 内 日", narration: "王利发：诸位坐，茶刚沏上。", visual: "茶馆", seconds: 3, kind: "quote" },
    { goal: "街头 外 夜", narration: "巡警：站住，例行检查。", visual: "街头", seconds: 2, kind: "quote" },
  ],
};

const clipsOf = (timeline: ReturnType<typeof buildDramaTimeline>, trackId: string) =>
  timeline.project.tracks.find(track => track.id === trackId)!.clips as NleClip[];

describe("DRAMA-07 drama timeline build", () => {
  it("cuts three tracks on the same scene boundaries and validates against the NLE contract", () => {
    const timeline = buildDramaTimeline(plan);
    expect(timeline.project.width).toBe(720);
    expect(timeline.project.height).toBe(1280);
    expect(clipsOf(timeline, "v1").map(clip => clip.kind)).toEqual(["image", "image"]);
    expect(clipsOf(timeline, "t1").map(clip => clip.kind)).toEqual(["text", "text"]);
    expect(clipsOf(timeline, "a1").map(clip => clip.kind)).toEqual(["audio", "audio"]);
    // 累计切点：0 → 3000，剪辑时长跟音频（缺省 = seconds*1000）。
    for (const trackId of ["v1", "t1", "a1"]) {
      expect(clipsOf(timeline, trackId).map(clip => clip.startMs)).toEqual([0, 3000]);
      expect(clipsOf(timeline, trackId).map(clip => clip.durationMs)).toEqual([3000, 2000]);
    }
    expect(timeline.totalMs).toBe(5000);
    expect(nleDurationMs(timeline.project)).toBe(5000);
  });
  it("lets synthesized audio durations drive the cut lengths", () => {
    const timeline = buildDramaTimeline(plan, { sceneAudioMs: [1800, 2600] });
    expect(timeline.audioMs).toEqual([1800, 2600]);
    expect(clipsOf(timeline, "v1").map(clip => clip.durationMs)).toEqual([1800, 2600]);
    expect(timeline.totalMs).toBe(4400);
  });
  it("fades in from the second scene only, clamped inside the clip duration", () => {
    const timeline = buildDramaTimeline(plan);
    const images = clipsOf(timeline, "v1");
    expect(images[0]!.transitionIn).toBeUndefined();
    expect(images[1]!.transitionIn).toEqual({ type: "fade", durationMs: 400 });
    const tiny = buildDramaTimeline({ ...plan, scenes: [{ ...plan.scenes[0]!, seconds: 1 }] }, { sceneAudioMs: [120] });
    expect(clipsOf(tiny, "v1")[0]!.transitionIn).toBeUndefined();
    expect(clipsOf(tiny, "a1")[0]!.durationMs).toBe(120); // 音频合同下限 100ms，短于转场时不加转场
  });
  it("lists one image and one wav per scene under the assets/ contract", () => {
    const { assets } = buildDramaTimeline(plan);
    expect(assets.map(asset => asset.name)).toEqual(["scene-01.png", "scene-01.wav", "scene-02.png", "scene-02.wav"]);
    expect(assets[0]!.narration).toContain("王利发");
    expect(assets[1]!.ms).toBe(3000);
  });
  it("maps 16:9 to landscape and sanitizes the project id into kebab-case", () => {
    const timeline = buildDramaTimeline({ ...plan, platform: "16:9", title: "茶馆 第2集！"}, { id: "茶 馆 EP2" });
    expect(timeline.project.width).toBe(1280);
    expect(timeline.project.height).toBe(720);
    expect(timeline.project.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });
});
