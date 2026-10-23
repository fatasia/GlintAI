import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { openCaptureBrowser, startAssetServer } from "./direct-browser/host";
import { runMediaProcess } from "./native-process";
import { encodingOptions } from "./encoding";

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

/** atempo accepts 0.5..2 per stage; chain stages to cover the 0.25..4 contract. */
function atempoChain(speed: number): string {
  const stages: string[] = [];
  let remaining = speed;
  while (remaining > 2.0001) { stages.push("atempo=2.0"); remaining /= 2; }
  while (remaining < 0.4999) { stages.push("atempo=0.5"); remaining *= 2; }
  stages.push("atempo=" + Math.min(2, Math.max(0.5, remaining)).toFixed(6));
  return stages.join(",");
}

interface AudioPart { input: string; sourceInMs: number; startMs: number; durationMs: number; speed: number; volume: number }

/** Render one clip to a WAV sitting at its absolute timeline position. */
async function renderAudioPart(part: AudioPart, outPath: string, totalMs: number): Promise<void> {
  await runMediaProcess("ffmpeg", ["-v", "error", "-y",
    "-ss", (part.sourceInMs / 1000).toFixed(3), "-t", (part.durationMs * part.speed / 1000).toFixed(3), "-i", part.input,
    "-af", atempoChain(part.speed) + ",volume=" + part.volume.toFixed(4) + ",adelay=" + part.startMs + "|" + part.startMs,
    "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", outPath], { timeoutMs: 120_000 });
}

export async function renderNle({ projectFile, assetsDir, out, encoding = "balanced", concurrency = 4 }: {
  projectFile: string; assetsDir: string; out: string; encoding?: string; concurrency?: number;
}): Promise<{ output: string; bytes: number; durationMs: number }> {
  void concurrency; // One deterministic capture page; parallelism lives in the encoder, not the seek clock.
  const project = parseNleProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
  const profile = encodingOptions(encoding);
  const sourceDir = path.resolve(assetsDir);
  const workspace = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), "glint-nle-"));
  const framesDir = path.join(workspace, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  let server: Awaited<ReturnType<typeof startAssetServer>> | undefined;
  try {
    for (const name of nleAssetNames(project)) {
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
    const inline = JSON.stringify(embedded).replace(/<\//g, "<\/");
    fs.writeFileSync(path.join(workspace, "harness.html"), '<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif}</style><div id="root"></div><script>window.__GLINT_PROJECT=' + inline + ';</script><script src="/harness.js"></script>');

    // Draft renders at half size for speed; the DOM keeps project resolution.
    const viewScale = encoding === "draft" ? 0.5 : 1;
    const viewportWidth = Math.round(project.width * viewScale), viewportHeight = Math.round(project.height * viewScale);
    server = await startAssetServer(workspace);
    browser = await openCaptureBrowser(viewportWidth, viewportHeight);
    const { page } = browser;
    await page.goto(server.url + "/harness.html", { waitUntil: "load" });
    await page.evaluate((viewScale: number) => {
      return (window as unknown as { __glintNleInit(project: unknown, assetBase: string, viewScale: number): Promise<void> }).__glintNleInit((window as unknown as { __GLINT_PROJECT: unknown }).__GLINT_PROJECT, "/assets/", viewScale);
    }, viewScale);

    const fps = project.fps;
    const totalMs = Math.max(...project.tracks.flatMap(track => track.clips.map(clip => clip.startMs + clip.durationMs)), 100);
    const totalFrames = Math.max(1, Math.round(totalMs / 1000 * fps));
    for (let frame = 0; frame < totalFrames; frame++) {
      const tMs = frame / fps * 1000;
      await page.evaluate((t: number) => (window as unknown as { __glintNleSeek(t: number): Promise<void> }).__glintNleSeek(t), tMs);
      await page.screenshot({ path: path.join(framesDir, String(frame).padStart(6, "0") + ".png"), clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight } });
    }

    // Audio mix: every audio clip plus every audible video clip, positioned on the timeline.
    const parts: AudioPart[] = [];
    for (const track of project.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        if (clip.kind === "audio") parts.push({ input: path.join(workspace, "assets", clip.src.slice("assets/".length)), sourceInMs: clip.trimStartMs ?? 0, startMs: clip.startMs, durationMs: clip.durationMs, speed: clip.speed ?? 1, volume: clip.volume ?? 1 });
        if (clip.kind === "video" && (clip.volume ?? 1) > 0) parts.push({ input: path.join(workspace, "assets", clip.src.slice("assets/".length)), sourceInMs: clip.trimStartMs ?? 0, startMs: clip.startMs, durationMs: clip.durationMs, speed: clip.speed ?? 1, volume: clip.volume ?? 1 });
      }
    }
    let mixedAudio: string | undefined;
    if (parts.length) {
      const rendered: string[] = [];
      for (const [index, part] of parts.entries()) {
        const partPath = path.join(workspace, "part-" + index + ".wav");
        await renderAudioPart(part, partPath, totalMs);
        rendered.push(partPath);
      }
      mixedAudio = path.join(workspace, "mix.m4a");
      await runMediaProcess("ffmpeg", ["-v", "error", "-y",
        ...rendered.flatMap(file => ["-i", file]),
        "-filter_complex", "amix=inputs=" + rendered.length + ":normalize=0:dropout_transition=0,apad=whole_dur=" + (totalMs / 1000).toFixed(3) + "[aout]",
        "-map", "[aout]", "-t", (totalMs / 1000).toFixed(3), "-c:a", "aac", "-b:a", profile.audioBitrate, mixedAudio], { timeoutMs: 300_000 });
    }

    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    await runMediaProcess("ffmpeg", [
      "-v", "error", "-y", "-framerate", String(fps), "-i", path.join(framesDir, "%06d.png"),
      ...(mixedAudio ? ["-i", mixedAudio, "-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0:v:0", "-an"]),
      "-c:v", "libx264", "-preset", profile.x264Preset, "-crf", String(profile.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ], { timeoutMs: 600_000 });
    return { output: path.resolve(out), bytes: fs.statSync(out).size, durationMs: totalMs };
  } finally {
    await browser?.browser.close().catch(() => {});
    await server?.close().catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
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
  renderNle({ projectFile, assetsDir: assets, out, encoding: arg("encoding") ?? "balanced", concurrency: Number(arg("concurrency") ?? 4) })
    .then(result => console.log(`[glint] NLE rendered: ${result.output} (${Math.round(result.bytes / 1024)} KB, ${(result.durationMs / 1000).toFixed(2)}s)`))
    .catch(error => { console.error(`[glint] failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
