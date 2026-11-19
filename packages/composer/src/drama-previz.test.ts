import { describe, expect, it } from "vitest";
import { PrevizDoc, exportShotCameras } from "@glintai/previz";
import { buildSeries } from "./drama-series";
import { previzFromScene } from "./drama-previz";

const SCRIPT = `第一场 茶馆 内 日
老陈擦拭柜台，门外风铃响。
小满推门进来，抖落肩上的雪。
小满：陈叔，今年的新茶到了吗？
老陈：到了，就等你来尝。
小满：那我先尝一杯，再决定要不要带走，最好是明前的头采，味道最干净的那一种。
第二场 街道 外 夜
雨中，小满快步走。
第三场 码头 外 日
阿海：船要开了。
小满：等等我。
老陈：路上小心。`;

const series = buildSeries(SCRIPT, { engine: "aigc", id: "demo", title: "茶馆", aspect: "16:9" });

describe("previzFromScene", () => {
  it("makes a valid document with one mannequin per character and one previs shot per drama shot", () => {
    const { doc } = previzFromScene(series, "ep-1-sc-1");
    const scene = series.episodes[0]!.scenes[0]!;
    expect(PrevizDoc.safeParse(doc).success).toBe(true);
    expect(doc.actors.map(a => [a.id, a.name, a.characterId])).toEqual([["actor-char-1", "小满", "char-1"], ["actor-char-2", "老陈", "char-2"]]);
    expect(doc.shots).toHaveLength(scene.shots.length);
    expect(doc.shots.map(s => s.dramaShotId)).toEqual(scene.shots.map(s => s.id));
    expect(doc.aspect).toBe("16:9");
  });

  it("keeps the drama timing: shots follow each other with the same durations", () => {
    const { doc } = previzFromScene(series, "ep-1-sc-1");
    const scene = series.episodes[0]!.scenes[0]!;
    let clock = 0;
    doc.shots.forEach((shot, i) => {
      expect(shot.startMs).toBe(clock);
      expect(shot.endMs - shot.startMs).toBe(scene.shots[i]!.durationMs);
      clock = shot.endMs;
    });
  });

  it("carries each shot's requested size into the previs and measures it", () => {
    const { doc, issues } = previzFromScene(series, "ep-1-sc-1");
    const scene = series.episodes[0]!.scenes[0]!;
    expect(doc.shots.map(s => s.intendedSize)).toEqual(scene.shots.map(s => s.size));
    expect(issues.filter(i => i.level === "error")).toEqual([]);
    expect(issues.filter(i => i.code === "size-mismatch")).toEqual([]);
  });

  it("places two characters facing each other and three or more on a circle facing its centre", () => {
    const pair = previzFromScene(series, "ep-1-sc-1").doc.actors;
    expect(pair[0]!.position).toEqual([0, 0, -1]);
    expect(pair[1]!.position).toEqual([0, 0, 1]);
    expect(pair[0]!.yawDeg).toBeCloseTo(0);
    expect(Math.abs(pair[1]!.yawDeg)).toBeCloseTo(180);
    const trio = previzFromScene(series, "ep-1-sc-3").doc.actors;
    expect(trio).toHaveLength(3);
    for (const actor of trio) {
      const [x, , z] = actor.position;
      const yaw = (actor.yawDeg * Math.PI) / 180;
      expect(Math.hypot(x, z)).toBeCloseTo(1.5, 1);
      expect(Math.sin(yaw) * x + Math.cos(yaw) * z).toBeLessThan(0);
    }
  });

  it("uses a stage camera for a scene shot without anyone in it", () => {
    const { doc, issues } = previzFromScene(series, "ep-1-sc-2");
    const establishing = doc.shots[0]!;
    expect(establishing.subjectIds).toEqual([]);
    expect(doc.cameras.find(c => c.id === establishing.cameraId)!.fovDeg).toBe(50);
    expect(issues.filter(i => i.level === "error")).toEqual([]);
  });

  it("is deterministic and drives a renderer one camera per frame", () => {
    expect(previzFromScene(series, "ep-1-sc-1")).toEqual(previzFromScene(series, "ep-1-sc-1"));
    const { doc } = previzFromScene(series, "ep-1-sc-1");
    const first = doc.shots[0]!;
    expect(exportShotCameras(doc, first.id)).toHaveLength(Math.round(((first.endMs - first.startMs) / 1000) * 24));
  });

  it("rejects an unknown scene", () => {
    expect(() => previzFromScene(series, "ep-9-sc-9")).toThrow(/Unknown scene/);
  });
});
