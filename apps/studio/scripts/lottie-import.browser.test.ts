import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { parseProject, sceneDurationMs } from "@glintai/scenescript";
import { createDirectCapture } from "./direct-browser";
import { findSystemBrowser } from "./direct-browser/host";
import { readImportedLottie, runLottieImport } from "./lottie-import";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("renders edited static text through Chromium without changing animated transforms", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-text-"));
  const base = path.join(root, "base.json"), source = path.join(root, "text-source.json"), imported = path.join(root, "imported.json"), edited = path.join(root, "edited.json");
  const examples = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../examples/local-media/readiness.scenescript.json", import.meta.url)), "utf8"));
  const fixture = examples.scenes.find((entry: { animation?: string }) => entry.animation === "lottie");
  const lottie = JSON.parse(fixture.html.match(/window\.__glintLottie=([\s\S]*);<\/script>/)[1]);
  lottie.fonts = { list: [{ fName: "Arial", fFamily: "Arial", fStyle: "Regular", ascent: 75 }] };
  lottie.layers.push({ ty: 5, ind: 2, nm: "Title", ip: lottie.ip, op: lottie.op, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [180, 140, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, t: { d: { k: [{ t: 0, s: { t: "MMMM", f: "Arial", s: 60, j: 0, tr: 0, lh: 72, ls: 0, fc: [1, 1, 1] } }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] } });
  fs.writeFileSync(source, JSON.stringify(lottie));
  fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "text-test", title: "Text", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  runLottieImport([`--project=${base}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
  const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${imported}`, "--scene=animation", "--layer-index=1", "--layer-text=IIII", `--out=${edited}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
  const first = parseProject(JSON.parse(fs.readFileSync(imported, "utf8"))).scenes[1]!, second = parseProject(JSON.parse(fs.readFileSync(edited, "utf8"))).scenes[1]!;
  const project = parseProject({ schemaVersion: 1, id: "text-pixels", title: "Text", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [first, { ...second, id: "edited" }] });
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  try {
    capture = await createDirectCapture(project, root, path.join(root, "public"), 480, 270);
    await capture.load(project.scenes[0]!); await capture.screenshot(5, path.join(root, "before.png"));
    await capture.load(project.scenes[1]!); await capture.screenshot(5, path.join(root, "after.png"));
    await capture.screenshot(2, path.join(root, "early.png")); await capture.screenshot(5, path.join(root, "repeat.png"));
    const hash = (name: string) => createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
    expect(hash("after.png")).not.toBe(hash("before.png"));
    expect(hash("repeat.png")).toBe(hash("after.png"));
    expect(hash("early.png")).not.toBe(hash("after.png"));
    const output = path.join(root, "text.mp4"), renderEnv = { ...process.env, HOME: root, GLINT_CHROME_PATH: findSystemBrowser() };
    const rendered = spawnSync(process.execPath, ["--import", tsx, cli, "render-native", `--project=${edited}`, "--scenes=animation", `--out=${output}`, "--fast", "--no-cache", "--tts=mock", "--music=off"], { cwd: root, env: renderEnv, encoding: "utf8", timeout: 120000 });
    expect(rendered.status, rendered.stderr + rendered.stdout).toBe(0);
    const pixels = (args: string[]) => {
      const result = spawnSync("ffmpeg", ["-v", "error", ...args, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1024 * 1024, windowsHide: true, env });
      expect(result.status, result.stderr.toString()).toBe(0); return result.stdout;
    };
    const expected = pixels(["-i", path.join(root, "after.png")]);
    const decoded = pixels(["-i", output, "-vf", "select=eq(n\\,5),scale=480:270", "-frames:v", "1"]);
    expect(decoded.length).toBe(expected.length);
    let error = 0;
    for (let i = 0; i < expected.length; i += 4) for (let c = 0; c < 3; c++) error += Math.abs(expected[i + c]! - decoded[i + c]!);
    expect(error / (480 * 270 * 3)).toBeLessThan(8);
  } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("renders a covered exported glyph after a real CLI text edit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-glyph-"));
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  try {
    const examples = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../examples/local-media/readiness.scenescript.json", import.meta.url)), "utf8"));
    const fixture = examples.scenes.find((entry: { animation?: string }) => entry.animation === "lottie");
    const lottie = JSON.parse(fixture.html.match(/window\.__glintLottie=([\s\S]*);<\/script>/)[1]);
    lottie.fonts = { list: [{ fName: "TestRegular", fFamily: "Test", fStyle: "Regular", ascent: 75 }] };
    const glyph = (ch: string, width: number) => ({ ch, fFamily: "Test", style: "Regular", w: 90, data: { shapes: [{ ty: "gr", it: [{ ty: "sh", ks: { a: 0, k: { i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], v: [[0, 0], [width, 0], [width, -80], [0, -80]], c: true } } }, { ty: "no" }] }] } });
    lottie.chars = [glyph("A", 65), glyph("B", 25)];
    lottie.layers.push({ ty: 5, ind: 2, nm: "Title", ip: lottie.ip, op: lottie.op, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [180, 140, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, t: { d: { k: [{ t: 0, s: { t: "AAAA", f: "TestRegular", s: 60, j: 0, tr: 0, lh: 72, ls: 0, fc: [1, 1, 1] } }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] } });
    const source = path.join(root, "source.json"), base = path.join(root, "base.json"), imported = path.join(root, "imported.json"), edited = path.join(root, "edited.json");
    fs.writeFileSync(source, JSON.stringify(lottie));
    fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "glyph-test", title: "Glyph", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
    runLottieImport([`--project=${base}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
    const original = fs.readFileSync(imported), cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${imported}`, "--scene=animation", "--layer-index=1", "--layer-text=BBBB", `--out=${edited}`], { cwd: root, env, encoding: "utf8", timeout: 30000 });
    expect(result.status, result.stderr).toBe(0); expect(fs.readFileSync(imported)).toEqual(original);
    const first = parseProject(JSON.parse(original.toString())).scenes[1]!, second = parseProject(JSON.parse(fs.readFileSync(edited, "utf8"))).scenes[1]!;
    const project = parseProject({ schemaVersion: 1, id: "glyph-pixels", title: "Glyph", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [first, { ...second, id: "edited" }] });
    capture = await createDirectCapture(project, root, path.join(root, "public"), 480, 270);
    await capture.load(project.scenes[0]!); await capture.screenshot(5, path.join(root, "before.png"));
    await capture.load(project.scenes[1]!); await capture.screenshot(5, path.join(root, "after.png"));
    const pixels = (name: string) => { const p = spawnSync("ffmpeg", ["-v", "error", "-i", path.join(root, name), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1024 * 1024, env }); expect(p.status, p.stderr.toString()).toBe(0); return p.stdout; };
    const before = pixels("before.png"), after = pixels("after.png");
    let difference = 0; for (let i = 0; i < before.length; i += 4) if ([0, 1, 2].some(c => Math.abs(before[i + c]! - after[i + c]!) > 10)) difference++;
    expect(difference).toBeGreaterThan(100);
    await capture.close(); capture = undefined;
    const video = path.join(root, "glyph.mp4"), renderEnv = { ...process.env, HOME: root, GLINT_CHROME_PATH: findSystemBrowser() };
    const rendered = spawnSync(process.execPath, ["--import", tsx, cli, "render-native", `--project=${edited}`, "--scenes=animation", `--out=${video}`, "--fast", "--no-cache", "--tts=mock", "--music=off"], { cwd: root, env: renderEnv, encoding: "utf8", timeout: 120000 });
    expect(rendered.status, rendered.stderr + rendered.stdout).toBe(0);
    const frame = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", "select=eq(n\\,5),scale=480:270", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1024 * 1024, env });
    expect(frame.status, frame.stderr.toString()).toBe(0); expect(frame.stdout.length).toBe(after.length);
    let error = 0; for (let i = 0; i < after.length; i += 4) for (let c = 0; c < 3; c++) error += Math.abs(after[i + c]! - frame.stdout[i + c]!);
    expect(error / (480 * 270 * 3)).toBeLessThan(8);
  } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("renders imported Lottie with overall and per-layer controls and deterministic seeks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-render-"));
  const base = path.join(root, "base.json"), source = path.join(root, "motion.json"), imported = path.join(root, "imported.json");
  const examples = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../examples/local-media/readiness.scenescript.json", import.meta.url)), "utf8"));
  const fixture = examples.scenes.find((entry: { animation?: string }) => entry.animation === "lottie");
  fs.writeFileSync(source, fixture.html.match(/window\.__glintLottie=([\s\S]*);<\/script>/)[1]);
  // 夹具只有一层且位置是关键帧;克隆出带静态位置的第二层供逐层位置编辑。
  const lottie = JSON.parse(fs.readFileSync(source, "utf8"));
  const second = structuredClone(lottie.layers[0]); second.nm = "Second"; second.ind = 2;
  second.ks.p = { a: 0, k: [260, 250, 0] };
  second.ks.o = { a: 1, k: [{ t: 0, s: [100], h: 1 }, { t: 12, s: [0], h: 1 }, { t: 24, s: [100] }] };
  lottie.layers[0].shapes.push({ ty: "st", c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 20 }, lc: 1, lj: 1, ml: 4 });
  lottie.layers.push(second); fs.writeFileSync(source, JSON.stringify(lottie));
  fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "lottie-test", title: "Lottie", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  runLottieImport([`--project=${base}`, "--scene=animation", "--append", `--source=${source}`, "--speed=0.5", `--out=${imported}`]);
  const sceneAt = (file: string) => parseProject(JSON.parse(fs.readFileSync(file, "utf8"))).scenes[1]!;
  const original = sceneAt(imported), variants = [original];
  for (const [index, flags] of [["--speed=1"], ["--scale=1.5"], ["--opacity=0.5"], ["--layer-index=0", "--layer-opacity=25"], ["--layer-index=1", "--layer-pos=700,180"], ["--layer-index=0", "--fill-path=1", "--fill-color=#FF0000"], ["--layer-index=1", "--opacity-keyframe=0", "--keyframe-opacity=0"], ["--layer-index=1", "--opacity-keyframe=1", "--keyframe-frame=2"], ["--layer-index=0", "--stroke-path=2", "--stroke-color=#FF0000"], ["--layer-index=0", "--position-keyframe=1", "--keyframe-pos=300,140"]].entries()) {
    const file = path.join(root, `variant-${index}.json`);
    runLottieImport([`--project=${imported}`, "--scene=animation", ...flags, `--out=${file}`]);
    variants.push({ ...sceneAt(file), id: `variant-${index}` });
  }
  const project = parseProject({ schemaVersion: 1, id: "lottie-pixel-test", title: "Lottie", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: variants });
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  try {
    capture = await createDirectCapture(project, root, path.join(root, "public"), 480, 270);
    for (const scene of project.scenes) { await capture.load(scene); await capture.screenshot(5, path.join(root, `${scene.id}.png`)); }
    const baseline = hash(path.join(root, "animation.png"));
    for (let index = 0; index < 10; index++) expect(hash(path.join(root, `variant-${index}.png`)), `variant ${index}`).not.toBe(baseline);
    const rgba = (name: string) => {
      const result = spawnSync("ffmpeg", ["-v", "error", "-i", path.join(root, name), "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1024 * 1024, windowsHide: true });
      expect(result.status, result.stderr.toString()).toBe(0); return result.stdout;
    };
    const before = rgba("animation.png"), layerChanged = rgba("variant-3.png"), layerMoved = rgba("variant-4.png");
    expect(before.length).toBe(480 * 270 * 4); expect(layerChanged.length).toBe(before.length); expect(layerMoved.length).toBe(before.length);
    const changedPixelsOf = (other: Buffer) => {
      let changedPixels = 0;
      for (let offset = 0; offset < before.length; offset += 4) {
        if ([0, 1, 2].some(channel => Math.abs(before[offset + channel]! - other[offset + channel]!) > 4)) changedPixels++;
      }
      return changedPixels;
    };
    expect(changedPixelsOf(layerChanged)).toBeGreaterThan(100);
    expect(changedPixelsOf(layerMoved)).toBeGreaterThan(100);
    expect(changedPixelsOf(rgba("variant-5.png"))).toBeGreaterThan(100);
    expect(changedPixelsOf(rgba("variant-6.png"))).toBeGreaterThan(100);
    expect(changedPixelsOf(rgba("variant-7.png"))).toBeGreaterThan(100);
    expect(changedPixelsOf(rgba("variant-8.png"))).toBeGreaterThan(20);
    expect(changedPixelsOf(rgba("variant-9.png"))).toBeGreaterThan(100);
    await capture.load(project.scenes[7]!); await capture.screenshot(2, path.join(root, "keyframe-early.png")); await capture.screenshot(5, path.join(root, "keyframe-repeat.png"));
    expect(hash(path.join(root, "keyframe-repeat.png"))).toBe(hash(path.join(root, "variant-6.png")));
    await capture.load(project.scenes[0]!); await capture.screenshot(2, path.join(root, "early.png")); await capture.screenshot(5, path.join(root, "repeat.png"));
    expect(hash(path.join(root, "repeat.png"))).toBe(baseline); expect(hash(path.join(root, "early.png"))).not.toBe(baseline);
    await capture.load(project.scenes[8]!); await capture.screenshot(2, path.join(root, "move-early.png")); await capture.screenshot(5, path.join(root, "move-repeat.png"));
    expect(hash(path.join(root, "move-repeat.png"))).toBe(hash(path.join(root, "variant-7.png")));
    const cli = fileURLToPath(new URL("./glint.ts", import.meta.url));
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const output = path.join(root, "moved.mp4");
    const rendered = spawnSync(process.execPath, ["--import", tsx, cli, "render-native", `--project=${path.join(root, "variant-8.json")}`, "--scenes=animation", `--out=${output}`, "--fast", "--no-cache", "--tts=mock", "--music=off"], { cwd: root, encoding: "utf8", timeout: 120000 });
    expect(rendered.status, rendered.stderr + rendered.stdout).toBe(0);
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_frames,duration", "-of", "json", output], { encoding: "utf8" });
    expect(probe.status, probe.stderr).toBe(0);
    const stream = JSON.parse(probe.stdout).streams[0];
    expect(stream.codec_name).toBe("h264"); expect(stream.width).toBeGreaterThan(0); expect(stream.height).toBeGreaterThan(0);
    expect(Number(stream.nb_frames)).toBe(Math.round(sceneDurationMs(sceneAt(path.join(root, "variant-8.json"))) * 24 / 1000));
    const extracted = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "select=eq(n\\,5),scale=480:270", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1024 * 1024, windowsHide: true });
    expect(extracted.status, extracted.stderr.toString()).toBe(0);
    const expected = rgba("variant-8.png"), decoded = extracted.stdout;
    expect(decoded.length).toBe(expected.length);
    let absoluteError = 0;
    for (let i = 0; i < expected.length; i += 4) for (let c = 0; c < 3; c++) absoluteError += Math.abs(expected[i + c]! - decoded[i + c]!);
    expect(absoluteError / (480 * 270 * 3)).toBeLessThan(8);
    if (process.env.GLINT_LOTTIE_EVIDENCE) for (const name of ["animation.png", "variant-0.png", "variant-1.png", "variant-2.png", "variant-3.png", "variant-4.png", "variant-9.png"]) fs.copyFileSync(path.join(root, name), path.join(process.env.GLINT_LOTTIE_EVIDENCE, name));
  } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 240000);

/** 素材回库端到端回归：内嵌图片真实渲染 → 独占回库 → 工程引用回读 → 原生渲染同帧对照。 */
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("restores an embedded image into a library and renders the same resource natively", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lottie-restore-"));
  const base = path.join(root, "base.json"), source = path.join(root, "motion.json"), imported = path.join(root, "imported.json"), library = path.join(root, "library");
  fs.mkdirSync(library);
  const examples = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../examples/local-media/readiness.scenescript.json", import.meta.url)), "utf8"));
  const fixture = examples.scenes.find((entry: { animation?: string }) => entry.animation === "lottie");
  const lottie = JSON.parse(fixture.html.match(/window\.__glintLottie=([\s\S]*);<\/script>/)[1]);
  const staged = path.join(root, "staged.png");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=200x120", "-frames:v", "1", staged], { timeout: 60_000 });
  const image = fs.readFileSync(staged);
  lottie.assets = [{ id: "img_red", w: 200, h: 120, u: "", p: `data:image/png;base64,${image.toString("base64")}` }];
  lottie.layers.push({ ddd: 0, ind: 2, ty: 2, nm: "Photo", refId: "img_red", sr: 1, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [400, 120, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, ao: 0, ip: lottie.ip, op: lottie.op, st: 0, bm: 0 });
  fs.writeFileSync(source, JSON.stringify(lottie));
  fs.writeFileSync(base, JSON.stringify({ schemaVersion: 1, id: "restore-test", title: "Restore", aspect: "16:9", fps: 24, knowledgeSources: [], scenes: [{ id: "start", kind: "title", title: "Start", narration: { text: "Start", durationMs: 1000 } }] }));
  runLottieImport([`--project=${base}`, "--scene=animation", "--append", `--source=${source}`, `--out=${imported}`]);
  const sha256 = createHash("sha256").update(image).digest("hex");
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  try {
    const project = parseProject(JSON.parse(fs.readFileSync(imported, "utf8")));
    capture = await createDirectCapture(project, root, path.join(root, "public"), 480, 270);
    await capture.load(project.scenes[1]!);
    await capture.screenshot(5, path.join(root, "with-image.png"));
    const rgba = (file: string, args: string[] = []) => {
      const result = spawnSync("ffmpeg", ["-v", "error", "-i", file, ...args, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 1024 * 1024, windowsHide: true });
      expect(result.status, result.stderr.toString()).toBe(0); return result.stdout;
    };
    const redPixels = (pixels: Buffer) => {
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset]! > 200 && pixels[offset + 1]! < 80 && pixels[offset + 2]! < 80) count++;
      return count;
    };
    const capturePixels = rgba(path.join(root, "with-image.png"));
    expect(capturePixels.length).toBe(480 * 270 * 4);
    // 内嵌资源确实是真实渲染输入：截图里出现成片的红色图像。
    expect(redPixels(capturePixels)).toBeGreaterThan(1000);
    // 真实 CLI 素材回库：独占写 + 工程引用回读由命令内部完成后输出回执。
    const cli = fileURLToPath(new URL("./glint.ts", import.meta.url)), tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root };
    const restored = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${imported}`, "--scene=animation", `--save-assets=${library}`], { cwd: root, env, encoding: "utf8", timeout: 60000 });
    expect(restored.status, restored.stderr).toBe(0);
    const receipt = JSON.parse(restored.stdout);
    expect(receipt.saved).toHaveLength(1);
    expect(receipt.saved[0]).toMatchObject({ file: `lottie-${sha256}.png`, sha256, bytes: image.length, state: "created", assetIds: ["img_red"] });
    expect(fs.readFileSync(path.join(library, receipt.saved[0].file))).toEqual(image);
    // 工程引用回读：重新解析工程、提取内嵌资源，哈希必须与库内文件一致。
    const scene = parseProject(JSON.parse(fs.readFileSync(imported, "utf8"))).scenes[1]!;
    if (scene.kind !== "html") throw new Error("Expected html");
    const extracted = readImportedLottie(scene).source.assets as Array<{ p?: string }>;
    const embeddedSha = extracted.filter(asset => typeof asset.p === "string" && asset.p!.startsWith("data:")).map(asset => createHash("sha256").update(Buffer.from(asset.p!.replace(/^data:image\/[a-z]+;base64,/, ""), "base64")).digest("hex"));
    expect(embeddedSha).toContain(receipt.saved[0].sha256);
    // 幂等重跑只验证不覆盖。
    const again = spawnSync(process.execPath, ["--import", tsx, cli, "lottie-import", `--project=${imported}`, "--scene=animation", `--save-assets=${library}`], { cwd: root, env, encoding: "utf8", timeout: 60000 });
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).saved[0].state).toBe("verified");
    // 本地原生渲染回归：渲染出的同一帧必须包含同一内嵌资源，且与浏览器捕获像素一致。
    // 渲染子进程沿用套件既有口径（仅重定向 HOME）：Edge 156 在 USERPROFILE/LOCALAPPDATA
    // 指向临时目录时会拒绝带远程调试的启动，导致渲染浏览器无法拉起。
    await capture.close();
    capture = undefined;
    const output = path.join(root, "restored.mp4");
    const renderEnv = { ...process.env, HOME: root, GLINT_CHROME_PATH: findSystemBrowser() };
    const rendered = spawnSync(process.execPath, ["--import", tsx, cli, "render-native", `--project=${imported}`, "--scenes=animation", `--out=${output}`, "--fast", "--no-cache", "--tts=mock", "--music=off"], { cwd: root, env: renderEnv, encoding: "utf8", timeout: 180000 });
    expect(rendered.status, rendered.stderr + rendered.stdout).toBe(0);
    const frame = rgba(output, ["-vf", "select=eq(n\\,5),scale=480:270", "-frames:v", "1"]);
    expect(frame.length).toBe(capturePixels.length);
    expect(redPixels(frame)).toBeGreaterThan(1000);
    let error = 0;
    for (let i = 0; i < capturePixels.length; i += 4) for (let c = 0; c < 3; c++) error += Math.abs(capturePixels[i + c]! - frame[i + c]!);
    expect(error / (480 * 270 * 3)).toBeLessThan(8);
    if (process.env.GLINT_LOTTIE_EVIDENCE) {
      fs.copyFileSync(path.join(root, "with-image.png"), path.join(process.env.GLINT_LOTTIE_EVIDENCE, "with-image.png"));
      spawnSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "select=eq(n\\,5),scale=480:270", "-frames:v", "1", "-y", path.join(process.env.GLINT_LOTTIE_EVIDENCE, "render-frame-5.png")], { windowsHide: true });
    }
  } finally { await capture?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 240000);
