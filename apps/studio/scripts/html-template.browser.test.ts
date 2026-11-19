import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { createDirectCapture } from "./direct-browser";
import { findSystemBrowser } from "./direct-browser/host";
import { runHtmlTemplate } from "./html-template";
import { renderNative } from "./native-render";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("renders local template parameters and deterministic absolute seeks in Chromium", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-html-template-render-")), base = path.join(root, "base.json"), first = path.join(root, "first.json"), second = path.join(root, "second.json");
  fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "poster-test", title: "P", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  runHtmlTemplate([`--project=${base}`, "--scene=poster", "--append", "--headline=测试标题", "--accent=#e62c26", `--out=${first}`]);
  runHtmlTemplate([`--project=${first}`, "--scene=poster", "--headline=另一个标题", "--accent=#27c44e", `--out=${second}`]);
  const a = parseProject(JSON.parse(fs.readFileSync(first, "utf8"))), b = parseProject(JSON.parse(fs.readFileSync(second, "utf8")));
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  try {
    capture = await createDirectCapture(a, root, path.join(root, "public"), 480, 270);
    await capture.load(a.scenes[1]!); await capture.screenshot(15, path.join(root, "a.png"));
    await capture.screenshot(5, path.join(root, "early.png")); await capture.screenshot(15, path.join(root, "repeat.png"));
    expect(hash(path.join(root, "a.png"))).toBe(hash(path.join(root, "repeat.png")));
    expect(hash(path.join(root, "a.png"))).not.toBe(hash(path.join(root, "early.png")));
    // A second capture has its own copied project; no network or paid model is used.
    await capture.close(); capture = await createDirectCapture(b, root, path.join(root, "public-b"), 480, 270);
    await capture.load(b.scenes[1]!); await capture.screenshot(15, path.join(root, "b.png"));
    expect(hash(path.join(root, "a.png"))).not.toBe(hash(path.join(root, "b.png")));
    // countdown-v1:数字逐秒跳变,不同帧显示不同数字。
    const third = path.join(root, "third.json");
    runHtmlTemplate([`--project=${second}`, "--scene=count", "--append", "--template=countdown-v1", "--seconds=5", "--label=发布倒计时", `--out=${third}`]);
    const c = parseProject(JSON.parse(fs.readFileSync(third, "utf8")));
    await capture.close(); capture = await createDirectCapture(c, root, path.join(root, "public-c"), 480, 270);
    await capture.load(c.scenes[2]!);
    await capture.screenshot(0, path.join(root, "c5.png"));     // t=0 → 显示 5
    await capture.screenshot(45, path.join(root, "c2.png"));    // 1.5s → 显示 4?按秒取整;数字随时间递减即可
    await capture.screenshot(150, path.join(root, "c0.png"));   // 5s → 显示 0
    const digits = (name: string) => hash(path.join(root, name));
    expect(digits("c5.png")).not.toBe(digits("c2.png")); expect(digits("c2.png")).not.toBe(digits("c0.png")); expect(digits("c5.png")).not.toBe(digits("c0.png"));
    await capture.screenshot(45, path.join(root, "c2-repeat.png"));
    expect(digits("c2-repeat.png")).toBe(digits("c2.png"));
    const edited = path.join(root, "count-edited.json");
    runHtmlTemplate([`--project=${third}`, "--scene=count", "--label=准备开始", `--out=${edited}`]);
    const d = parseProject(JSON.parse(fs.readFileSync(edited, "utf8")));
    await capture.close(); capture = await createDirectCapture(d, root, path.join(root, "public-d"), 480, 270);
    await capture.load(d.scenes[2]!); await capture.screenshot(45, path.join(root, "c2-edited.png"));
    expect(digits("c2-edited.png")).not.toBe(digits("c2.png"));
    // progress-v1:进度条与百分比计数随时间连续填充,t=0 为 0%,中段约半程,结束为设定百分比。
    const fifth = path.join(root, "fifth.json");
    runHtmlTemplate([`--project=${edited}`, "--scene=bar", "--append", "--template=progress-v1", "--percent=72", "--label=年度目标", "--fill-ms=3000", `--out=${fifth}`]);
    const e = parseProject(JSON.parse(fs.readFileSync(fifth, "utf8")));
    await capture.close(); capture = await createDirectCapture(e, root, path.join(root, "public-e"), 480, 270);
    expect(e.scenes.map(scene => scene.id)).toEqual(["start", "poster", "count", "bar"]);
    await capture.load(e.scenes.find(scene => scene.id === "bar")!);
    await capture.screenshot(0, path.join(root, "p0.png"));      // 帧 0 → 0%,条宽 0
    await capture.screenshot(45, path.join(root, "p50.png"));    // 1.5s(半程)→ 36%
    await capture.screenshot(120, path.join(root, "p100.png"));  // 4s(填充早已结束)→ 72%
    expect(digits("p0.png")).not.toBe(digits("p50.png")); expect(digits("p50.png")).not.toBe(digits("p100.png")); expect(digits("p0.png")).not.toBe(digits("p100.png"));
    await capture.screenshot(45, path.join(root, "p50-repeat.png"));
    expect(digits("p50-repeat.png")).toBe(digits("p50.png"));
    const progressEdited = path.join(root, "progress-edited.json");
    runHtmlTemplate([`--project=${fifth}`, "--scene=bar", "--percent=30", `--out=${progressEdited}`]);
    const f = parseProject(JSON.parse(fs.readFileSync(progressEdited, "utf8")));
    await capture.close(); capture = await createDirectCapture(f, root, path.join(root, "public-f"), 480, 270);
    await capture.load(f.scenes.find(scene => scene.id === "bar")!); await capture.screenshot(120, path.join(root, "p30.png"));
    expect(digits("p30.png")).not.toBe(digits("p100.png"));
    if (process.env.GLINT_HTML_TEMPLATE_EVIDENCE) for (const name of ["a.png", "early.png", "b.png", "c5.png", "c2.png", "c0.png", "p0.png", "p50.png", "p100.png", "p30.png"]) fs.copyFileSync(path.join(root, name), path.join(process.env.GLINT_HTML_TEMPLATE_EVIDENCE, name));
  } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);

it.skipIf(process.env.GLINT_HTML_TEMPLATE_VIDEO !== "1" || !available)("exports an edited countdown through the local renderer to H.264", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-html-video-"));
  const base = path.join(root, "base.json"), first = path.join(root, "first.json"), edited = path.join(root, "edited.json"), output = path.join(root, "result.mp4");
  fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "p", title: "P", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  try {
    runHtmlTemplate([`--project=${base}`, "--scene=count", "--append", "--template=countdown-v1", "--seconds=3", `--out=${first}`]);
    runHtmlTemplate([`--project=${first}`, "--scene=count", "--label=准备开始", `--out=${edited}`]);
    if (!process.env.GLINT_CACHE_DIR || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_DATA_DIR) throw new Error("视频验收要求隔离缓存、会话和数据目录");
    await renderNative({ projectPath: edited, output, fast: true, tts: "mock", music: "off", noCache: true });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames", "-of", "json", output], { encoding: "utf8", windowsHide: true });
    expect(probe.status, probe.stderr).toBe(0);
    const video = JSON.parse(probe.stdout).streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    expect(video).toMatchObject({ codec_name: "h264", width: 960, height: 540, nb_frames: "150" });
    for (const [time, name] of [["1.3", "early.png"], ["3.3", "late.png"]]) {
      const result = spawnSync("ffmpeg", ["-v", "error", "-ss", time!, "-i", output, "-frames:v", "1", path.join(root, name!)], { encoding: "utf8", windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(createHash("sha256").update(fs.readFileSync(path.join(root, "early.png"))).digest("hex")).not.toBe(createHash("sha256").update(fs.readFileSync(path.join(root, "late.png"))).digest("hex"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 180000);

it.skipIf(process.env.GLINT_HTML_TEMPLATE_VIDEO !== "1" || !available)("exports an edited progress template through the local renderer to H.264", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-progress-video-"));
  const base = path.join(root, "base.json"), first = path.join(root, "first.json"), edited = path.join(root, "edited.json"), output = path.join(root, "progress.mp4");
  fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "p", title: "P", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  try {
    runHtmlTemplate([`--project=${base}`, "--scene=bar", "--append", "--template=progress-v1", "--percent=72", "--label=年度目标", "--fill-ms=2000", `--out=${first}`]);
    runHtmlTemplate([`--project=${first}`, "--scene=bar", "--accent=#27c44e", `--out=${edited}`]);
    if (!process.env.GLINT_CACHE_DIR || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_DATA_DIR) throw new Error("视频验收要求隔离缓存、会话和数据目录");
    await renderNative({ projectPath: edited, output, fast: true, tts: "mock", music: "off", noCache: true });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames", "-of", "json", output], { encoding: "utf8", windowsHide: true });
    expect(probe.status, probe.stderr).toBe(0);
    const video = JSON.parse(probe.stdout).streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    // 标题 1000ms + 进度场景 max(3000, 2000+400)=3000ms = 4000ms × 30fps = 120 帧。
    expect(video).toMatchObject({ codec_name: "h264", width: 960, height: 540, nb_frames: "120" });
    // 1.25s 处进度场景刚开始(≈0–8%);3.7s 处填充早已完成(72%)。两帧必须不同。
    for (const [time, name] of [["1.25", "early.png"], ["3.7", "late.png"]] as const) {
      const result = spawnSync("ffmpeg", ["-v", "error", "-ss", time, "-i", output, "-frames:v", "1", path.join(root, name)], { encoding: "utf8", windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(createHash("sha256").update(fs.readFileSync(path.join(root, "early.png"))).digest("hex")).not.toBe(createHash("sha256").update(fs.readFileSync(path.join(root, "late.png"))).digest("hex"));
    if (process.env.GLINT_HTML_TEMPLATE_EVIDENCE) {
      fs.copyFileSync(output, path.join(process.env.GLINT_HTML_TEMPLATE_EVIDENCE, "progress.mp4"));
      fs.copyFileSync(path.join(root, "early.png"), path.join(process.env.GLINT_HTML_TEMPLATE_EVIDENCE, "progress-early.png"));
      fs.copyFileSync(path.join(root, "late.png"), path.join(process.env.GLINT_HTML_TEMPLATE_EVIDENCE, "progress-late.png"));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 180000);
