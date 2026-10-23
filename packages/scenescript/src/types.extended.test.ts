import { describe, expect, it } from "vitest";
import { parseProject } from "./parse";
import { CameraMoveSpec, TransitionSpec } from "./types";

const base = {
  schemaVersion: 1,
  id: "demo",
  title: "演示",
  aspect: "16:9" as const,
  knowledgeSources: [],
};

describe("scene motion fields", () => {
  it("accepts camera and transition on any scene kind", () => {
    const project = parseProject({
      ...base,
      scenes: [{
        id: "intro", kind: "title", title: "标题",
        narration: { text: "开场旁白" },
        camera: { type: "push", intensity: 0.7 },
        transition: { in: "zoom-punch", durationMs: 320 },
      }],
    });
    expect(project.scenes[0]).toMatchObject({
      camera: { type: "push", intensity: 0.7 },
      transition: { in: "zoom-punch", durationMs: 320 },
    });
  });

  it("keeps scenes without motion fields untouched (v1 compatible)", () => {
    const project = parseProject({
      ...base,
      scenes: [{ id: "plain", kind: "bullets", items: ["要点"], narration: { text: "正文讲述内容" } }],
    });
    expect(project.scenes[0]!.camera).toBeUndefined();
    expect(project.scenes[0]!.transition).toBeUndefined();
  });

  it("rejects unknown camera/transition types", () => {
    expect(CameraMoveSpec.safeParse({ type: "orbit" }).success).toBe(false);
    expect(TransitionSpec.safeParse({ in: "glitch" }).success).toBe(false);
    expect(CameraMoveSpec.safeParse({ type: "drift", intensity: 1.4 }).success).toBe(false);
  });
});

describe("chart schema extensions", () => {
  const chart = (chartType: string, data: object[]) => ({
    id: "data", kind: "chart", chartType, narration: { text: "看这组数据" }, data,
  });

  it("accepts the four new chart types", () => {
    for (const chartType of ["pie", "area", "scatter", "combo"]) {
      const result = parseProject({ ...base, scenes: [chart(chartType, chartType === "bar" ? [{ label: "甲", value: 1 }] : [{ label: "甲", value: 1, value2: 2 }])] });
      expect(result.scenes[0]).toMatchObject({ chartType });
    }
  });

  it("requires value2 for scatter and combo", () => {
    for (const chartType of ["scatter", "combo"]) {
      expect(() => parseProject({ ...base, scenes: [chart(chartType, [{ label: "甲", value: 1 }])] }))
        .toThrow(/value2/);
    }
    // bar/line/pie/area stay single-series.
    for (const chartType of ["bar", "line", "pie", "area"]) {
      expect(() => parseProject({ ...base, scenes: [chart(chartType, [{ label: "甲", value: 1 }])] })).not.toThrow();
    }
  });
});

describe("video scene", () => {
  it("accepts a local video asset with trims", () => {
    const project = parseProject({
      ...base,
      scenes: [{
        id: "clip", kind: "video", src: "assets/demo.mp4",
        trimStartSec: 0.5, trimEndSec: 3.2, caption: "网关片段",
        narration: { text: "这段视频片段" },
      }],
    });
    expect(project.scenes[0]).toMatchObject({ kind: "video", src: "assets/demo.mp4", trimStartSec: 0.5 });
  });

  it("rejects non-local video paths", () => {
    expect(() => parseProject({
      ...base,
      scenes: [{ id: "clip", kind: "video", src: "https://cdn.example.com/x.mp4", narration: { text: "外链片段" } }],
    })).toThrow(/assets\//);
  });
});

describe("sfx cues", () => {
  it("accepts project-level cues and validates effects", () => {
    const project = parseProject({
      ...base,
      scenes: [{ id: "a", kind: "title", title: "T", narration: { text: "有音效的开场" } }],
      sfx: [{ sceneId: "a", word: "开场", effect: "impact", gain: 0.4 }],
    });
    expect(project.sfx).toHaveLength(1);
    expect(project.sfx![0]).toMatchObject({ effect: "impact" });
  });

  it("rejects unknown cue scene ids only at lint time, not schema time", () => {
    const project = parseProject({
      ...base,
      scenes: [{ id: "a", kind: "title", title: "T", narration: { text: "有音效的开场" } }],
      sfx: [{ sceneId: "missing", effect: "pop" }],
    });
    expect(project.sfx![0]!.sceneId).toBe("missing");
  });
});
