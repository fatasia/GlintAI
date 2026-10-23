import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { parseProject, buildTimeline, timelineToFrames, frameRateOf, type Scene } from "@glintai/scenescript";
import { renderSceneSvg, supportsNativeScene } from "./native-svg";
import { createTextOutliner } from "./native-svg/outline";
import { resolveTheme } from "@glintai/design-tokens";
import { createDirectCapture } from "./direct-browser";
import { prepareNativeAudio } from "./native-audio";
import { runMediaProcess, startPngEncoder } from "./native-process";
import { buildProjectCues, formatSrt } from "./jianying";
import { buildStitchPlan } from "./native-stitch";
import { assetFingerprint, sceneMediaFingerprint, sceneAssetFingerprint, nativeCacheEnvironment, sceneCacheKey, visualSceneIdentity, cacheArtifactValid, recordCacheArtifact } from "./native-cache";

export interface NativeRenderOptions {
  beatGrid?: import("@glintai/music").BeatGrid;
  projectPath: string;
  output: string;
  fast?: boolean;
  plate?: boolean;
  scenes?: string[];
  tts?: string;
  music?: string;
  noCache?: boolean;
  /** Output height preset: 540/720/1080/1440/2160. Overrides --fast scaling. Vector scenes stay crisp at any height. */
  resolution?: "540" | "720" | "1080" | "1440" | "2160";
  signal?: AbortSignal;
  /** Structured logging hook; the MCP server routes this to stderr to keep stdout protocol-clean. */
  log?: (message: string) => void;
}

const RENDER_VERSION = 1;
export function nativeCacheKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function renderNative(options: NativeRenderOptions) {
  const log = options.log ?? console.log;
  const started = performance.now(), sourcePath = path.resolve(options.projectPath), projectDir = path.dirname(sourcePath);
  let project = parseProject(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
  if (options.scenes) {
    if (!options.scenes.length || options.scenes.some(id => !project.scenes.some(s => s.id === id))) throw new Error("Unknown or empty scene subset");
    project = parseProject({ ...project, scenes: project.scenes.filter(s => options.scenes!.includes(s.id)) });
  }
  const unsupported = project.scenes.filter(scene => !supportsNativeScene(scene));
  const browserScenes = unsupported.filter(scene => ["html", "three", "image", "video"].includes(scene.kind));
  if (unsupported.length !== browserScenes.length) throw new Error(`Unsupported scene kinds: ${unsupported.filter(s => !browserScenes.includes(s)).map(s => `${s.id} (${s.kind})`).join(", ")}`);
  if (browserScenes.length) log(`[glint] browser backend for: ${browserScenes.map(s => s.id).join(", ")}; SVG backend for the rest`);
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error(`Output already exists; choose a new --out path: ${output}`);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "glint-native-"));
  const cacheDir = path.resolve(".cache", "native-scenes");
  fs.mkdirSync(cacheDir, { recursive: true }); fs.mkdirSync(path.dirname(output), { recursive: true });
  const partial = path.join(path.dirname(output), `.${path.basename(output)}-${randomUUID()}.mp4`);
  let capture: Awaited<ReturnType<typeof createDirectCapture>> | undefined;
  try {
    const audio = await prepareNativeAudio(project, projectDir, workspace, options);
    project = audio.project;
    const rate = frameRateOf(project.fps ?? 30);
    const { entries, durationInFrames } = timelineToFrames(buildTimeline(project), project.fps ?? 30);
    const fps = rate.value;
    const resolutionScale = options.resolution ? { "540": 0.5, "720": 2 / 3, "1080": 1, "1440": 4 / 3, "2160": 2 }[options.resolution] : undefined;
    const scale = resolutionScale ?? (options.fast ? 0.5 : 1);
    const dimensions = project.aspect === "9:16" ? [1080, 1920] : project.aspect === "1:1" ? [1080, 1080] : [1920, 1080];
    const width = Math.round(dimensions[0]! * scale), height = Math.round(dimensions[1]! * scale);
    let cacheHits = 0, renderedFrames = 0, rasterMs = 0, encodeMs = 0;
    const clips: string[] = [];
    const sceneReports: { id: string; key: string; cached: boolean }[] = [];
    const browserFor = new Set(browserScenes.map(scene => scene.id));
    // Include local implementation source in the cache identity, not only the schema.
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const fontFiles = process.platform === "win32" ? ["msyh.ttc", "msyhbd.ttc", "simkai.ttf", "consola.ttf"].map(name => path.join(process.env.WINDIR ?? "C:/Windows", "Fonts", name)).filter(file => fs.existsSync(file)) : [];
    const assets = browserScenes.length ? assetFingerprint(projectDir) : "no-assets";
    const cacheEnvironment = nativeCacheEnvironment(scriptDir, { browserRequired: browserScenes.length > 0, fontFiles });
    const outlineText = createTextOutliner({ loadSystemFonts: fontFiles.length === 0, fontFiles, defaultFontFamily: "Microsoft YaHei" }, width, height, resolveTheme(project.theme).fonts.body);
    for (const [index, entry] of entries.entries()) {
      options.signal?.throwIfAborted();
      const previous = project.scenes[index - 1];
      const key = sceneCacheKey({ environment: cacheEnvironment, scene: visualSceneIdentity(entry.scene, Boolean(options.plate)), media: sceneMediaFingerprint(entry.scene, projectDir, assets), assets: sceneAssetFingerprint(project, entry.scene), previousShared: entry.scene.transition?.in === "magic-move" ? previous?.sharedElements : undefined, theme: resolveTheme(project.theme), width, height, fps, duration: entry.duration, plate: Boolean(options.plate) });
      sceneReports.push({ id: entry.scene.id, key, cached: false });
      const clip = path.join(cacheDir, `${key}.mp4`);
      if (!options.noCache && cacheArtifactValid(clip)) {
        cacheHits++; sceneReports[sceneReports.length - 1]!.cached = true; log(`[glint] native cache hit: ${entry.scene.id}`); clips.push(clip); continue;
      }
      if (browserFor.has(entry.scene.id)) {
        capture ??= await createDirectCapture(project, projectDir, path.join(workspace, "public"), width, height, options.signal);
        await capture.load(entry.scene, Boolean(options.plate));
      }
      log(`[glint] native rendering ${entry.scene.id}: ${entry.duration} frames${browserFor.has(entry.scene.id) ? " (browser)" : " (svg)"}`);
      const encoder = startPngEncoder({ fps, frameRateText: rate.text, crf: options.fast ? 24 : 20, preset: options.fast ? "veryfast" : "medium", output: path.join(workspace, `clip-${index}.mp4`), signal: options.signal });
      const rasterStart = performance.now();
      try {
        for (let frame = 0; frame < entry.duration; frame++) {
          options.signal?.throwIfAborted();
          if (capture && browserFor.has(entry.scene.id)) {
            const shot = path.join(workspace, `shot-${index}-${frame}.png`);
            await capture.screenshot(frame, shot);
            await encoder.write(fs.readFileSync(shot));
            fs.rmSync(shot, { force: true });
          } else {
            const svg = renderSceneSvg(project, entry.scene, frame, { width, height, plate: options.plate, previousScene: previous });
            await encoder.write(new Resvg(outlineText(svg), { font: { loadSystemFonts: false } }).render().asPng());
          }
          renderedFrames++;
          if (frame % 30 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        const flushStart = performance.now();
        await encoder.finish();
        encodeMs += performance.now() - flushStart;
      } catch (error) { await encoder.finish().catch(() => {}); throw error; }
      rasterMs += performance.now() - rasterStart;
      const tempClip = path.join(workspace, `clip-${index}.mp4`);
      const cacheTemp = `${clip}.${randomUUID()}.tmp`; fs.copyFileSync(tempClip, cacheTemp); fs.renameSync(cacheTemp, clip); recordCacheArtifact(clip);
      clips.push(clip);
    }
    const concat = path.join(workspace, "concat.txt");
    fs.writeFileSync(concat, clips.map(file => `file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const muxStart = performance.now();
    const stitch = buildStitchPlan(entries, fps);
    // Container cache: identical scene clips + identical audio + identical stitch
    // parameters must produce the same file, so a repeat build can copy instead of mux.
    const containerKey = createHash("sha256").update(JSON.stringify({
      version: 2,
      clips: clips.map(file => path.basename(file)),
      audio: audio.audioPath ? createHash("sha256").update(fs.readFileSync(audio.audioPath)).digest("hex") : null,
      overlaps: stitch.overlaps, durationInFrames, fps,
      crf: options.fast ? 24 : 20, preset: options.fast ? "veryfast" : "medium",
      filter: stitch.overlaps.some(Boolean) ? stitch.filter : "concat",
    })).digest("hex");
    const containerCache = path.join(path.resolve(".cache", "native-container"), `${containerKey}.mp4`);
    let containerHit = false;
    if (cacheArtifactValid(containerCache)) { fs.copyFileSync(containerCache, partial); containerHit = true; }
    else if (stitch.overlaps.some(Boolean)) {
      await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-filter_complex_threads", "1", ...clips.flatMap(file => ["-i", file]), ...(audio.audioPath ? ["-i", audio.audioPath] : []), "-filter_complex", stitch.filter, "-map", `[${stitch.output}]`, ...(audio.audioPath ? ["-map", `${clips.length}:a:0`, "-c:a", "aac", "-b:a", "160k"] : []), "-c:v", "libx264", "-preset", options.fast ? "veryfast" : "medium", "-crf", options.fast ? "24" : "20", "-pix_fmt", "yuv420p", "-frames:v", String(durationInFrames), "-movflags", "+faststart", partial], { signal: options.signal });
    } else {
      await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat, ...(audio.audioPath ? ["-i", audio.audioPath] : []), "-map", "0:v:0", ...(audio.audioPath ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "160k"] : []), "-c:v", "copy", "-movflags", "+faststart", "-t", String(durationInFrames / fps), partial], { signal: options.signal });
    }
    if (!containerHit) {
      fs.mkdirSync(path.dirname(containerCache), { recursive: true });
      const cacheTemp = `${containerCache}.${randomUUID()}.tmp`;
      fs.copyFileSync(partial, cacheTemp); fs.renameSync(cacheTemp, containerCache); recordCacheArtifact(containerCache);
    }
    fs.renameSync(partial, output);
    const metrics = { backend: browserScenes.length ? "independent-mixed" : "native-svg", remotionLoaded: false, chromiumLaunched: Boolean(capture), width, height, fps, frames: durationInFrames, renderedFrames, cacheHits, overlaps: stitch.overlaps, sceneCount: entries.length, rasterMs: Math.round(rasterMs), encodeMs: Math.round(encodeMs), muxMs: Math.round(performance.now() - muxStart), totalMs: Math.round(performance.now() - started), bytes: fs.statSync(output).size };
    fs.writeFileSync(`${output}.metrics.json`, JSON.stringify(metrics, null, 2));
    const portableProject = structuredClone(project);
    const mediaDirectory = `${output}.assets`;
    for (const scene of portableProject.scenes) {
      const synthesized = fs.readdirSync(workspace).find(name => name === `${scene.id}.wav` || name === `${scene.id}.mp3`);
      if (!synthesized) continue;
      fs.mkdirSync(mediaDirectory, { recursive: true });
      fs.copyFileSync(path.join(workspace, synthesized), path.join(mediaDirectory, synthesized));
      scene.narration.audioRef = `${path.basename(mediaDirectory)}/${synthesized}`;
    }
    fs.writeFileSync(`${output}.project.json`, JSON.stringify(portableProject, null, 2));
    fs.writeFileSync(`${output}.srt`, formatSrt(buildProjectCues(project)));
    log(`[glint] native done: ${output} (${metrics.totalMs}ms, ${cacheHits}/${entries.length} cached)`);
    return { output, metrics, scenes: sceneReports, environment: cacheEnvironment };
  } finally {
    await capture?.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(partial, { force: true });
  }
}
