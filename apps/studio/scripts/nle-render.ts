import fs from "node:fs";
import { publishExclusive } from "./nle-publish";
import { createHash } from "node:crypto";
import { checkMotionBudget, motionCuts, motionCliOptions, motionOptions, motionTimes } from "./nle-motion";
import type { MotionCaptureHost } from "./nle-motion-capture";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nleAlphaIssues, parseNleProject, type NleProject } from "@glintai/scenescript";
import { renderNleAudioPart, type NleAudioPart } from "./nle-audio";
import { openCaptureBrowser, startAssetServer } from "./direct-browser/host";
import { runMediaProcess } from "./native-process";
import { encodingOptions } from "./encoding";

export const nleInlineJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/**
 * NLE render: the browser is the render engine.
 *
 * The same nle-dom frame contract that drives the editor preview runs in a
 * headless Chrome page; we seek frame by frame (waiting for every media seek),
 * screenshot each frame and hand the sequence to ffmpeg with a filter_complex
 * audio mix. Preview and export cannot drift apart — there is one implementation.
 */

export function nleAssetNames(project: NleProject): string[] {
  const names = new Set<string>();
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.kind === "video" || clip.kind === "image" || clip.kind === "audio") names.add(clip.src.slice("assets/".length));
  }
  return [...names];
}

/** DELIVER-03 封面帧选择：时间点→帧号；省略/非正数取首帧，超界夹到最后一帧。 */
export function coverFrameIndex(coverAtMs: number | undefined, fps: number, totalFrames: number): number {
  if (!coverAtMs || coverAtMs <= 0) return 0;
  return Math.min(Math.max(0, totalFrames - 1), Math.max(0, Math.round(coverAtMs / 1000 * fps)));
}

export async function renderNle({ projectFile, assetsDir, out, encoding = "balanced", concurrency = 4, coverAtMs, alpha = false, motionSamples = 1, shutterAngle = 180, signal: externalSignal }: {
  projectFile: string; assetsDir: string; out: string; encoding?: string; concurrency?: number; coverAtMs?: number; alpha?: boolean; motionSamples?: number; shutterAngle?: number; signal?: AbortSignal;
}): Promise<{ output: string; bytes: number; durationMs: number; cover?: string; motion?: { samples: number; shutterAngle: number; frameSha256: string; outputSha256: string; samplesRendered: number } }> {
  void concurrency; // One deterministic capture page; parallelism lives in the encoder, not the seek clock.
  const project = parseNleProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
  if (alpha) {
    if (!/\.webm$/i.test(out)) throw new Error("透明导出需要 .webm 输出文件。");
    const issues = nleAlphaIssues(project);
    if (issues.length) throw new Error(`透明导出不支持画面片段：${issues.map(issue => `${issue.trackId}/${issue.clipId}`).join("、")}`);
    const scale = encoding === "draft" ? 0.5 : 1;
    if (Math.round(project.width * scale) % 2 || Math.round(project.height * scale) % 2) throw new Error("透明 WebM 的输出宽高必须为偶数。");
  }
  const motion = motionOptions(motionSamples, shutterAngle), enabled = motion.samples > 1;
  const viewScale = encoding === "draft" ? 0.5 : 1;
  const viewportWidth = Math.round(project.width * viewScale), viewportHeight = Math.round(project.height * viewScale);
  const fps = project.fps;
  const totalMs = Math.max(...project.tracks.flatMap(track => track.clips.map(clip => clip.startMs + clip.durationMs)), 100);
  const totalFrames = Math.max(1, Math.round(totalMs / 1000 * fps));
  checkMotionBudget(motion, viewportWidth, viewportHeight, totalFrames);
  const signal = enabled ? AbortSignal.any([AbortSignal.timeout(300_000), ...(externalSignal ? [externalSignal] : [])]) : externalSignal;
  signal?.throwIfAborted();
  const cover = out.replace(/\.[a-z0-9]+$/i, "") + ".cover.jpg";
  if (enabled && (fs.existsSync(out) || fs.existsSync(cover))) throw new Error("Motion output or cover already exists; choose a new path");
  const profile = encodingOptions(encoding);
  const sourceDir = path.resolve(assetsDir);
  const workspace = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), "glint-nle-"));
  const framesDir = path.join(workspace, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  let server: Awaited<ReturnType<typeof startAssetServer>> | undefined;
  let completed = false, ownOutput = false, ownCover = false;
  const renderOutput = enabled ? path.join(workspace, alpha ? "render.webm" : "render.mp4") : out;
  const renderCover = enabled ? path.join(workspace, "cover.jpg") : cover;
  let closing: Promise<void> | undefined;
  const closeBrowser = () => {
    if (!browser) return Promise.resolve();
    closing ??= browser.browser.close();
    return closing;
  };
  const abort = () => { void closeBrowser().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const frameHash = createHash("sha256"); let samplesRendered = 0;
  try {
    for (const name of nleAssetNames(project)) {
      signal?.throwIfAborted();
      const source = path.join(sourceDir, name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("NLE asset must be a regular file: " + name);
      if (stat.size > 512 * 1024 * 1024) throw new Error("NLE asset exceeds 512 MB: " + name);
      fs.mkdirSync(path.dirname(path.join(workspace, "assets", name)), { recursive: true });
      fs.copyFileSync(source, path.join(workspace, "assets", name));
    }

    // The portable package pre-bundles the harness (esbuild cannot be bundled):
    // use it when present, otherwise build from source for development.
    const prebuilt = process.env.GLINT_NLE_HARNESS;
    const harness = prebuilt && fs.existsSync(prebuilt)
      ? fs.readFileSync(prebuilt, "utf8")
      : (await (await import("esbuild")).build({
        entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "nle-capture-page.ts")],
        bundle: true, platform: "browser", format: "iife", target: "chrome120", write: false, logLevel: "silent",
      })).outputFiles[0]!.text;
    fs.writeFileSync(path.join(workspace, "harness.js"), harness);
    const embedded = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    const inline = nleInlineJson(embedded);
    fs.writeFileSync(path.join(workspace, "harness.html"), '<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif}</style><div id="root"></div><script>window.__GLINT_PROJECT=' + inline + ';</script><script src="/harness.js"></script>');

    // Draft renders at half size for speed; the DOM keeps project resolution.
    server = await startAssetServer(workspace);
    browser = await openCaptureBrowser(viewportWidth, viewportHeight);
    signal?.throwIfAborted();
    const { page } = browser;
    await page.goto(server.url + "/harness.html", { waitUntil: "load" });
    await page.evaluate((options: { scale: number; alpha: boolean }) => {
      return (window as unknown as { __glintNleInit(project: unknown, assetBase: string, viewScale: number, transparent: boolean): Promise<void> }).__glintNleInit((window as unknown as { __GLINT_PROJECT: unknown }).__GLINT_PROJECT, "/assets/", options.scale, options.alpha);
    }, { scale: viewScale, alpha });
    if (alpha) {
      const transparent = await page.evaluate(() => [document.body, document.getElementById("root")!].every(element => getComputedStyle(element).backgroundColor === "rgba(0, 0, 0, 0)"));
      if (!transparent) throw new Error("透明渲染器版本不匹配；请重新构建桌面运行包。");
    }

    signal?.throwIfAborted();
    if (enabled && !await page.evaluate(() => typeof (window as unknown as MotionCaptureHost).__glintMotionStart === "function")) throw new Error("Motion capture harness unavailable; rebuild the portable harness");
    const cuts = enabled ? motionCuts(project) : []; let frameBytes = 0;
    for (let frame = 0; frame < totalFrames; frame++) {
      signal?.throwIfAborted();
      const filename = path.join(framesDir, String(frame).padStart(6, "0") + ".png");
      if (!enabled) {
        const tMs = frame / fps * 1000;
        await page.evaluate((t: number) => (window as unknown as { __glintNleSeek(t: number): Promise<void> }).__glintNleSeek(t), tMs);
        await page.screenshot({ path: filename, omitBackground: alpha, clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight } });
      } else {
        await page.evaluate((w, h, n) => (window as unknown as MotionCaptureHost).__glintMotionStart(w, h, n), viewportWidth, viewportHeight, motion.samples);
        try {
          for (const time of motionTimes(frame, fps, cuts, motion)) {
            signal?.throwIfAborted();
            await page.evaluate((t: number) => (window as unknown as { __glintNleSeek(t: number): Promise<void> }).__glintNleSeek(t), time);
            const png = await page.screenshot({ omitBackground: alpha, clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight } });
            if (png.byteLength > 16 * 1024 * 1024) throw new Error("Motion sample exceeds 16 MiB");
            await page.evaluate(data => (window as unknown as MotionCaptureHost).__glintMotionSample(data), Buffer.from(png).toString("base64"));
            samplesRendered++;
          }
          const png = Buffer.from(await page.evaluate(() => (window as unknown as MotionCaptureHost).__glintMotionFinish()), "base64");
          frameBytes += png.length;
          if (frameBytes > 256 * 1024 * 1024) throw new Error("Motion frames exceed 256 MiB");
          frameHash.update(png); fs.writeFileSync(filename, png);
        } finally { await page.evaluate(() => (window as unknown as MotionCaptureHost).__glintMotionDispose()).catch(() => {}); }
      }
    }

    // Audio mix: every audio clip plus every audible video clip, positioned on the timeline.
    // Solo (audition isolation) wins over mute: when any track is solo, only solo tracks are heard.
    const soloTracks = project.tracks.filter(track => track.solo);
    const audible = (track: (typeof project.tracks)[number]) => !track.muted && (!soloTracks.length || track.solo === true);
    const parts: NleAudioPart[] = [];
    for (const track of project.tracks) {
      if (!audible(track)) continue;
      for (const clip of track.clips) {
        const ramp = clip.speedRamp;
        if (clip.kind === "audio") parts.push({ input: path.join(workspace, "assets", clip.src.slice("assets/".length)), sourceInMs: clip.trimStartMs ?? 0, startMs: clip.startMs, durationMs: clip.durationMs, speed: clip.speed ?? 1, volume: clip.volume ?? 1, curve: clip.speedCurve, ramp });
        if (clip.kind === "video" && (clip.volume ?? 1) > 0) parts.push({ input: path.join(workspace, "assets", clip.src.slice("assets/".length)), sourceInMs: clip.trimStartMs ?? 0, startMs: clip.startMs, durationMs: clip.durationMs, speed: clip.speed ?? 1, volume: clip.volume ?? 1, curve: clip.speedCurve, ramp });
      }
    }
    let mixedAudio: string | undefined;
    if (parts.length) {
      const rendered: string[] = [];
      for (const [index, part] of parts.entries()) {
        const partPath = path.join(workspace, "part-" + index + ".wav");
        await renderNleAudioPart(part, partPath, totalMs, signal);
        rendered.push(partPath);
      }
      mixedAudio = path.join(workspace, "mix.m4a");
      await runMediaProcess("ffmpeg", ["-v", "error", "-y",
        ...rendered.flatMap(file => ["-i", file]),
        "-filter_complex", "amix=inputs=" + rendered.length + ":normalize=0:dropout_transition=0,apad=whole_dur=" + (totalMs / 1000).toFixed(3) + "[aout]",
        "-map", "[aout]", "-t", (totalMs / 1000).toFixed(3), "-c:a", "aac", "-b:a", profile.audioBitrate, mixedAudio], { signal, timeoutMs: 300_000 });
    }

    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await runMediaProcess("ffmpeg", [
      "-v", "error", "-y", "-framerate", String(fps), "-i", path.join(framesDir, "%06d.png"),
      ...(mixedAudio ? ["-i", mixedAudio, "-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0:v:0", "-an"]),
      ...(alpha ? ["-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "4", "-crf", String(profile.crf), "-b:v", "0", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", ...(mixedAudio ? ["-c:a", "libopus"] : [])] : ["-c:v", "libx264", "-preset", profile.x264Preset, "-crf", String(profile.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]),
      renderOutput,
    ], { signal, timeoutMs: 600_000 });
    // Delivery cover frame (DELIVER-03): a still next to the video, first frame
    // by default or at --cover-at=<ms> when a better thumbnail is wanted.
    const coverFrame = coverFrameIndex(coverAtMs, fps, totalFrames);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", ...(alpha ? [path.join(framesDir, String(coverFrame).padStart(6, "0") + ".png")] : [renderOutput, "-vf", `select=eq(n\\,${coverFrame})`]), "-frames:v", "1", "-q:v", "3", renderCover], { signal, timeoutMs: 60_000 });
    signal?.throwIfAborted();
    const digestFile = async (file: string) => {
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
      return hash.digest("hex");
    };
    let outputSha256 = "";
    if (enabled) {
      outputSha256 = await digestFile(renderOutput);
      const coverSha256 = await digestFile(renderCover);
      signal?.throwIfAborted();
      await publishExclusive(renderOutput, out, signal); ownOutput = true;
      if (await digestFile(out) !== outputSha256) throw new Error("Published motion output digest mismatch");
      await publishExclusive(renderCover, cover, signal); ownCover = true;
      if (await digestFile(cover) !== coverSha256) throw new Error("Published motion cover digest mismatch");
      signal?.throwIfAborted();
    }
    completed = true;
    return { ...(enabled ? { motion: { ...motion, frameSha256: frameHash.digest("hex"), outputSha256, samplesRendered } } : {}), output: path.resolve(out), bytes: fs.statSync(out).size, durationMs: totalMs, cover: fs.existsSync(cover) ? cover : undefined };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (enabled && !completed) { if (ownOutput) fs.rmSync(out, { force: true }); if (ownCover) fs.rmSync(cover, { force: true }); }
    await closeBrowser().catch(() => {});
    await server?.close().catch(() => {});
    if (path.dirname(path.resolve(workspace)) === path.dirname(path.resolve(out))) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/** CLI entry: `glint nle-render --project= --assets= --out= [--encoding=]`. */
if (process.argv[1] && /nle-render\.(?:ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (name: string) => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const projectFile = arg("project"), assets = arg("assets"), out = arg("out");
  if (!projectFile || !assets || !out) {
    console.error("[glint] nle-render requires --project=<nle.json> --assets=<dir> --out=<mp4>");
    process.exit(1);
  }
  const cliMotion = motionCliOptions(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  renderNle({ signal: controller.signal, motionSamples: cliMotion.samples, shutterAngle: cliMotion.shutterAngle, projectFile, assetsDir: assets, out, encoding: arg("encoding") ?? "balanced", concurrency: Number(arg("concurrency") ?? 4), coverAtMs: Number(arg("cover-at")) || undefined, alpha: process.argv.slice(2).includes("--alpha") })
    .then(result => { if (result.motion) console.log(JSON.stringify({ motion: result.motion })); console.log(`[glint] NLE rendered: ${result.output} (${Math.round(result.bytes / 1024)} KB, ${(result.durationMs / 1000).toFixed(2)}s)`); })
    .catch(error => { console.error(`[glint] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; })
    .finally(() => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); });
}
