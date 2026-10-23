import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNleProject, parseProject } from "@glintai/scenescript";
import { buildEdl, buildFcpxml, buildNleEdl, buildNleFcpxml, exportNleProjectTimeline, exportNleTimeline } from "./nle-export";

const project = parseProject({
  schemaVersion: 1, id: "nle-test", title: "咖啡 & 开门", aspect: "16:9", fps: 30, knowledgeSources: [],
  scenes: [
    { id: "open", kind: "title", title: "开场 <一>", narration: { text: "第一镜", durationMs: 1000 } },
    { id: "sell", kind: "bullets", title: "卖点", items: ["快", "省"], narration: { text: "第二镜更长一些", durationMs: 2000 } },
  ],
});
const spec = { width: 1920, height: 1080, fps: 30, durationSec: 3 };

describe("FCPXML timeline", () => {
  it("cuts one master into scene-aligned asset clips with exact rational time", () => {
    const xml = buildFcpxml(project, "D:/render/master.mp4", "D:/render/edit.fcpxml");
    expect(xml).toContain('<fcpxml version="1.9">');
    expect(xml).toContain('frameDuration="1/30s"');
    expect(xml).toContain('width="1920" height="1080"');
    expect(xml).toContain("file://localhost/D:/render/master.mp4");
    expect(xml).toContain('hasAudio="0"');
    expect(xml).toContain('offset="0s" start="0s" duration="1s"');
    expect(xml).toContain('offset="1s" start="1s" duration="2s"');
    expect(xml).toContain("咖啡 &amp; 开门");
    expect(xml).toContain("开场 &lt;一&gt;");
    expect((xml.match(/<asset-clip /g) ?? []).length).toBe(2);
  });
  it("uses vertical dimensions for a 9:16 project", () => {
    const vertical = parseProject({ ...project, aspect: "9:16" });
    const xml = buildFcpxml(vertical, "D:/render/master.mp4", "D:/render/edit.fcpxml");
    expect(xml).toContain('width="1080" height="1920"');
  });
});

describe("CMX3600 EDL", () => {
  it("writes one cut event per scene", () => {
    const edl = buildEdl(project, "D:/render/master.mp4", "D:/render/edit.edl", spec);
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("001  AX       V     C        00:00:00:00 00:00:01:00 00:00:00:00 00:00:01:00");
    expect(edl).toContain("002  AX       V     C        00:00:01:00 00:00:03:00 00:00:01:00 00:00:03:00");
    expect(edl).toContain("* FROM CLIP NAME: SCENE_01_开场_一_");
    expect(edl).toContain("* SOURCE FILE: master.mp4");
  });
  it("writes the files and reports the cut count", () => {
    const result = exportNleTimeline({ project, videoPath: "D:/render/master.mp4", format: "edl", outPath: path.join(os.tmpdir(), "glint-nle-test", "edit.edl"), spec });
    expect(result.cuts).toBe(2);
    expect(result.bytes).toBeGreaterThan(100);
  });
});

const nle = parseNleProject({
  schemaVersion: 1, id: "nle-timeline", title: "多轨 <片>", fps: 30, width: 1080, height: 1920, background: "#000000",
  tracks: [
    { id: "v1", kind: "video", name: "主画面", clips: [
      { id: "shot-a", kind: "video", src: "assets/a.mp4", startMs: 0, durationMs: 2000, trimStartMs: 500, speed: 2, transitionIn: { type: "fade" } },
      { id: "shot-b", kind: "image", src: "assets/b.png", startMs: 2000, durationMs: 1500 },
    ] },
    { id: "v2", kind: "overlay", name: "叠加", clips: [
      { id: "logo", kind: "image", src: "assets/logo.png", startMs: 500, durationMs: 1000 },
    ] },
    { id: "t1", kind: "text", name: "文字", clips: [
      { id: "caption", kind: "text", text: "标题", startMs: 0, durationMs: 1000 },
    ] },
    { id: "a1", kind: "audio", name: "音频", clips: [
      { id: "music", kind: "audio", src: "assets/music.mp3", startMs: 0, durationMs: 3500 },
    ] },
  ],
});

describe("NLE timeline export", () => {
  it("writes per-clip FCPXML events with lanes, trims and exact rationals", () => {
    const result = buildNleFcpxml(nle, name => `D:/media/${name}`);
    expect(result.clips).toBe(4);
    expect(result.textClips).toBe(1);
    expect(result.audioClips).toBe(1);
    expect(result.text).toContain('width="1080" height="1920"');
    expect(result.text).toContain('frameDuration="1/30s"');
    expect(result.text).toContain('duration="105/30s"'.replace("105/30s", "7/2s"));
    expect(result.text).toContain('lane="1"');
    expect(result.text).toContain('start="1/2s"');
    expect(result.text).toContain('audioRole="effects"');
    expect(result.text).toContain("file://localhost/D:/media/a.mp4");
    expect(result.text).toContain("多轨 &lt;片&gt;");
    expect(result.text).not.toContain("caption");
  });
  it("writes sorted EDL events and reports omitted audio/text", () => {
    const result = buildNleEdl(nle);
    expect(result.clips).toBe(3);
    expect(result.audioClips).toBe(1);
    expect(result.textClips).toBe(1);
    // shot-a runs at 2x source speed (speed: 2, trimStartMs: 500): the source
    // range advances twice the timeline duration (2000ms -> 4000ms of source).
    expect(result.text).toContain("001  AX       V     C        00:00:00:15 00:00:04:15 00:00:00:00 00:00:02:00");
    expect(result.text).toContain("* FROM CLIP NAME: logo");
    expect(result.text).toContain("* AUDIO CLIPS OMITTED FROM CMX3600: 1");
    expect(result.text).toContain("* TEXT CLIPS OMITTED FROM CMX3600: 1");
  });
  it("writes the file and reports text clips as a warning", () => {
    const result = exportNleProjectTimeline({ project: nle, format: "fcpxml", outPath: path.join(os.tmpdir(), "glint-nle-test", "timeline.fcpxml"), assetPath: name => `D:/media/${name}` });
    expect(result.bytes).toBeGreaterThan(200);
    expect(result.warning).toMatch(/文字片段/);
  });
});
