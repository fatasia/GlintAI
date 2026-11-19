import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nleMoveClip, nleTrimClip, parseNleProject, parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { clipProjectToNle, editClipBoundaries, editedSourceWindow, withTracedBoundaries } from "./longform-clip-edit";

const WINDOW = { startMs: 12_000, endMs: 30_000 };
const SOURCE = "D:/footage/longform.mp4";

function fixtureProject(): SceneScriptProject {
  // 与 longform-clip.ts 落盘的切片工程同构（parseProject 校验同一 schema）。
  return parseProject({
    schemaVersion: 1, id: "clip-01", title: "长片切片 1", aspect: "16:9", knowledgeSources: [],
    scenes: [{
      id: "segment", kind: "video", src: "assets/clip-01.mp4", trimStartSec: 0,
      narration: { text: "长片切片：补写这条短片的文案。" },
      notes: `源时间码 ${WINDOW.startMs}ms–${WINDOW.endMs}ms（源片 longform.mp4，时长 18.0s，镜头数 3，运动评分 600）`,
    }],
  } satisfies Partial<SceneScriptProject> as never);
}

describe("CLIP-03 片段边界编辑走 NLE", () => {
  it("导出的 NleProject 可解析且与源窗一一对应", () => {
    const { nle, trackId, clipId } = clipProjectToNle({ project: fixtureProject(), sourceWindow: WINDOW, width: 1920, height: 1080 });
    expect(parseNleProject(nle)).toBeDefined();
    const track = nle.tracks.find(item => item.id === trackId)!;
    const clip = track.clips.find(item => item.id === clipId)!;
    expect(clip.kind).toBe("video");
    if (clip.kind === "video") {
      expect(clip.src).toBe("assets/clip-01.mp4");
      expect(clip.startMs).toBe(0);
      expect(clip.durationMs).toBe(WINDOW.endMs - WINDOW.startMs);
      expect(clip.trimStartMs ?? 0).toBe(0);
    }
  });
  it("双边 nleTrimClip 后源窗正确收进，notes 同步新时间码且保留原窗可追溯", () => {
    const project = fixtureProject();
    const { nle, trackId, clipId } = clipProjectToNle({ project, sourceWindow: WINDOW, width: 1920, height: 1080 });
    let edited = nleMoveClip(nleTrimClip(nle, trackId, clipId, "start", 1500), trackId, clipId, 0); // 与 editClipBoundaries 同一组合：头部收进后时间轴贴零
    edited = nleTrimClip(edited, trackId, clipId, "end", -2000);
    const window = editedSourceWindow({ nle: edited, trackId, clipId, original: WINDOW });
    expect(window).toEqual({ startMs: WINDOW.startMs + 1500, endMs: WINDOW.endMs - 2000 });
    // 时间轴贴零：头部收进不留黑场。
    const clip = edited.tracks[0]!.clips[0]!;
    expect(clip.startMs).toBe(0);
    expect(clip.durationMs).toBe((WINDOW.endMs - WINDOW.startMs) - 3500);
    const next = withTracedBoundaries({ project, window, sourceVideo: SOURCE, original: WINDOW, edited: true });
    expect(parseProject(next).scenes[0]!.kind).toBe("video");
    const videoScene = parseProject(next).scenes[0]!;
    if (videoScene.kind === "video") {
      expect(videoScene.notes).toContain(`源时间码 ${window.startMs}ms–${window.endMs}ms`);
      expect(videoScene.notes).toContain(`自 ${WINDOW.startMs}ms–${WINDOW.endMs}ms`);
      expect(videoScene.notes).toContain("源片 longform.mp4");
      expect(videoScene.narration.text).toBe(project.scenes[0]!.narration.text); // 编辑只动边界，不动文案
    }
  });
  it("超界 trim 被夹具拒绝或夹住：源窗永不越出原始切片", () => {
    const project = fixtureProject();
    const { nle, trackId, clipId } = clipProjectToNle({ project, sourceWindow: WINDOW, width: 1920, height: 1080 });
    // 左收超出切片长度 → nleTrimClip 静默拒绝（trimStartMs 会为负），窗口不变。
    const refused = nleTrimClip(nle, trackId, clipId, "start", (WINDOW.endMs - WINDOW.startMs) + 500);
    expect(editedSourceWindow({ nle: refused, trackId, clipId, original: WINDOW })).toEqual(WINDOW);
    // 右收过狠 → 时长被夹到 100ms 下限。
    const clamped = nleTrimClip(nle, trackId, clipId, "end", -(WINDOW.endMs - WINDOW.startMs));
    const window = editedSourceWindow({ nle: clamped, trackId, clipId, original: WINDOW });
    expect(window.endMs - window.startMs).toBeGreaterThanOrEqual(100);
    expect(window.startMs).toBeGreaterThanOrEqual(WINDOW.startMs);
    expect(window.endMs).toBeLessThanOrEqual(WINDOW.endMs);
  });
  it("清单级回写：工程文件更新、时间码可从 notes 正则追回，零改动不落盘", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-clip-edit-"));
    const projectFile = path.join(dir, "clip-01.project.json");
    fs.writeFileSync(projectFile, JSON.stringify(fixtureProject()));
    const manifestFile = path.join(dir, "clips.json");
    fs.writeFileSync(manifestFile, JSON.stringify({
      source: { videoPath: SOURCE, durationMs: 60_000 },
      clips: [{ id: "clip-01", startMs: WINDOW.startMs, endMs: WINDOW.endMs, motionScore: 600, shotCount: 3, file: "assets/clip-01.mp4", projectFile: "clip-01.project.json", coverFile: null }],
    }));

    const outcome = editClipBoundaries({ manifestFile, clipId: "clip-01", trimStartMs: 2000, trimEndMs: 1000, width: 1920, height: 1080 });
    expect(outcome.edited).toBe(true);
    expect(outcome.window).toEqual({ startMs: 14_000, endMs: 29_000 });
    const written = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    const notes = written.scenes[0].notes as string;
    const [, start, end] = /源时间码 (\d+)ms–(\d+)ms/.exec(notes)!;
    expect(Number(start)).toBe(outcome.window.startMs);
    expect(Number(end)).toBe(outcome.window.endMs);
    expect(parseProject(written)).toBeDefined();

    const untouched = editClipBoundaries({ manifestFile, clipId: "clip-01", width: 1920, height: 1080 });
    expect(untouched.edited).toBe(false);
    expect(fs.readFileSync(projectFile, "utf8")).toBe(JSON.stringify(written, null, 2)); // 零改动不重写工程
    expect(() => editClipBoundaries({ manifestFile, clipId: "nope", width: 1920, height: 1080 })).toThrow(/清单里没有/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
