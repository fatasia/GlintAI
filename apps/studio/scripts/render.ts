import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import {
  composeFromMarkdown,
  composeWithLlm,
} from "@glintai/composer";
import { readSourceText } from "@glintai/knowledge";
import { OpenAICompatibleProvider } from "@glintai/llm";
import {
  parseProject,
  buildTimeline,
  estimateNarrationDurationMs,
  estimateWordTimings,
  type AspectRatio,
  type SceneScriptProject,
} from "@glintai/scenescript";
import {
  EdgeTtsProvider,
  MockTtsProvider,
  SapiTtsProvider,
  synthesizeBatch,
  QwenLocalTtsProvider,
  type TtsProvider,
} from "@glintai/tts";
import { generateAmbientMusic } from "@glintai/music";
import { copyRuntimeDecoders, ensureDecoders } from "./decoders";
import { pathToFileURL } from "node:url";
import { RenderSession } from "./render-session";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { encodingOptions } from "./encoding";
import { copyProjectAssets } from "./assets";

const DEFAULT_SOURCE = "../../examples/entropy-lecture/source.md";
const COMPOSITION_ID = "Glint";

type OutputFormat = "mp4" | "png" | "gif";
type TtsEngine = "auto" | "edge" | "sapi" | "mock" | "qwen";

interface RenderArgs {
  projectPath?: string;
  sourcePath?: string;
  engine: "heuristic" | "llm";
  format: OutputFormat;
  frame: number;
  outPath: string;
  projectId?: string;
  title?: string;
  language?: string;
  aspect?: AspectRatio;
  tts: TtsEngine;
  voice?: string;
  music?: string;
  encoding?: string;
  fast?: boolean;
  ttsConcurrency?: number;
  noCache?: boolean;
  ttsPython?: string;
  ttsModel?: string;
  referenceAudio?: string;
  referenceText?: string;
  concurrency?: number;
}

function parseArgs(argv: string[]): RenderArgs {
  const args: RenderArgs = {
    engine: "heuristic",
    format: "mp4",
    frame: 0,
    outPath: "",
    tts: "auto",
  };
  for (const arg of argv) {
    const read = (name: string) => {
      const prefix = `--${name}=`;
      return arg.startsWith(prefix) ? arg.slice(prefix.length) : undefined;
    };
    if (arg.startsWith("--project=")) args.projectPath = read("project");
    else if (arg.startsWith("--source=")) args.sourcePath = read("source");
    else if (arg.startsWith("--engine=")) args.engine = read("engine") as RenderArgs["engine"];
    else if (arg.startsWith("--format=")) args.format = read("format") as OutputFormat;
    else if (arg.startsWith("--frame=")) args.frame = Number(read("frame"));
    else if (arg.startsWith("--out=")) args.outPath = read("out") ?? "";
    else if (arg.startsWith("--id=")) args.projectId = read("id");
    else if (arg.startsWith("--title=")) args.title = read("title");
    else if (arg.startsWith("--language=")) args.language = read("language");
    else if (arg.startsWith("--aspect=")) args.aspect = read("aspect") as AspectRatio;
    else if (arg.startsWith("--tts=")) args.tts = read("tts") as TtsEngine;
    else if (arg.startsWith("--voice=")) args.voice = read("voice");
    else if (arg.startsWith("--music=")) args.music = read("music");
    else if (arg.startsWith("--encoding=")) args.encoding = read("encoding");
    else if (arg === "--fast") args.fast = true;
    else if (arg.startsWith("--tts-concurrency=")) args.ttsConcurrency = Number(read("tts-concurrency"));
    else if (arg === "--no-cache") args.noCache = true;
    else if (arg.startsWith("--tts-python=")) args.ttsPython = read("tts-python");
    else if (arg.startsWith("--tts-model=")) args.ttsModel = read("tts-model");
    else if (arg.startsWith("--reference-audio=")) args.referenceAudio = read("reference-audio");
    else if (arg.startsWith("--reference-text=")) args.referenceText = read("reference-text");
    else if (arg.startsWith("--concurrency=")) args.concurrency = Number(read("concurrency"));
    else throw new Error(`Unknown render option: ${arg}`);
  }
  encodingOptions(args.encoding);
  if (!["mp4", "png", "gif"].includes(args.format)) throw new Error("format must be mp4, png or gif");
  if (!["auto", "edge", "sapi", "mock", "qwen"].includes(args.tts)) throw new Error("tts must be auto, edge, sapi, mock or qwen");
  if (args.tts === "qwen" && (!args.ttsModel || !args.referenceAudio)) throw new Error("qwen requires --tts-model=<local directory> and --reference-audio=<local audio>");
  if (!["heuristic", "llm"].includes(args.engine)) throw new Error("Invalid engine");
  if (args.ttsConcurrency !== undefined && (!Number.isInteger(args.ttsConcurrency) || args.ttsConcurrency < 1 || args.ttsConcurrency > 8)) throw new Error("tts-concurrency must be 1..8");
  if (args.concurrency !== undefined && (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 16)) throw new Error("concurrency must be 1..16");
  if (!Number.isInteger(args.frame) || args.frame < 0) throw new Error("frame must be a nonnegative integer");
  if (args.projectPath && args.sourcePath) throw new Error("Choose project or source, not both");
  if (!args.projectPath && !args.sourcePath) args.sourcePath = DEFAULT_SOURCE;
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set GLINT_LLM_BASE_URL / GLINT_LLM_API_KEY / GLINT_LLM_MODEL, or use --engine=heuristic.`,
    );
  }
  return value;
}

async function composeProject(args: RenderArgs, sourcePath: string): Promise<SceneScriptProject> {
  const source = await readSourceText({ path: sourcePath });
  const fallbackId = path
    .basename(sourcePath)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const options = {
    projectId: args.projectId ?? (fallbackId || undefined),
    title: args.title,
    language: args.language,
    sourceName: path.basename(sourcePath),
  };
  if (args.engine === "llm") {
    const llm = new OpenAICompatibleProvider({
      baseUrl: requireEnv("GLINT_LLM_BASE_URL"),
      apiKey: requireEnv("GLINT_LLM_API_KEY"),
      model: process.env.GLINT_LLM_MODEL ?? "glm-4",
    });
    console.log(`[glint] composing with ${llm.name}...`);
    return composeWithLlm(source, llm, options);
  }
  console.log("[glint] composing (deterministic offline engine)...");
  return composeFromMarkdown(source, options);
}

/**
 * Synthesizes narration for every scene and returns a prepared copy of the
 * project whose audioRef/durationMs/segments match the produced audio, so
 * composition length and captions are audio-aligned.
 */
async function prepareAudio(
  project: SceneScriptProject,
  provider: TtsProvider,
  voice?: string,
  options: { concurrency?: number; noCache?: boolean } = {},
  publicDir = path.resolve("public"),
): Promise<SceneScriptProject> {
  const audioRoot = path.join(publicDir, "audio");
  fs.mkdirSync(audioRoot, { recursive: true });
  const audioDir = fs.mkdtempSync(path.join(audioRoot, `${project.id}-`));
  const audioPrefix = path.relative(publicDir, audioDir).split(path.sep).join("/");
  const prepared = structuredClone(project);
  let results;
  try { results = await synthesizeBatch(provider, prepared.scenes.map((scene) => ({
        text: scene.narration.text,
        voice: scene.narration.voice ?? voice,
        speakingRate: scene.narration.speakingRate,
      })), { concurrency: options.concurrency, cacheDir: options.noCache ? undefined : path.resolve(".cache", "tts") }); }
  finally { await provider.dispose?.(); }
    prepared.scenes.forEach((scene, index) => {
      const result = results[index]!;
      const fileName = `${scene.id}.${result.mimeType === "audio/wav" ? "wav" : "mp3"}`;
      fs.writeFileSync(path.join(audioDir, fileName), result.audio);
      scene.narration.audioRef = `${audioPrefix}/${fileName}`;
      scene.narration.durationMs = result.durationMs;
      scene.narration.segments = [{ text: scene.narration.text, words: result.words }];
    });
  return prepared;
}

async function buildTtsProvider(args: RenderArgs): Promise<TtsProvider> {
  const pick = (engine: TtsEngine): TtsProvider => {
    if (engine === "edge") return new EdgeTtsProvider();
    if (engine === "sapi") return new SapiTtsProvider();
    if (engine === "qwen") return new QwenLocalTtsProvider({ python: args.ttsPython ?? "python", modelDir: path.resolve(args.ttsModel!), referenceAudio: path.resolve(args.referenceAudio!), referenceText: args.referenceText });
    return new MockTtsProvider();
  };
  if (args.tts !== "auto") {
    if (args.tts === "mock") console.warn("[glint] mock speech selected: narration is SILENT (test output)");
    return pick(args.tts);
  }
  try {
    const edge = new EdgeTtsProvider();
    // Prove reachability before committing to the network provider.
    await edge.synthesize({ text: "试音", timeoutMs: 15_000 });
    return edge;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[glint] edge tts unavailable (${reason}); falling back.`);
    if (process.platform === "win32") return new SapiTtsProvider();
    throw new Error("Speech service unavailable. Configure a reachable TTS service, or explicitly use --tts=mock for a SILENT test export.");
  }
}

/** Same proportional caption timings as MockTtsProvider, with no WAV/FFmpeg audio overhead. */
export function prepareSilentProject(project: SceneScriptProject): SceneScriptProject {
  const prepared = structuredClone(project);
  for (const scene of prepared.scenes) {
    const durationMs = estimateNarrationDurationMs(scene.narration.text, { speakingRate: scene.narration.speakingRate });
    delete scene.narration.audioRef;
    scene.narration.durationMs = durationMs;
    scene.narration.segments = [{ text: scene.narration.text, words: estimateWordTimings(scene.narration.text, durationMs) }];
  }
  return prepared;
}

export async function renderOnce(argv: string[], session: RenderSession): Promise<string> {
  const started = performance.now();
  const stages: Record<string, number> = {};
  let checkpoint = started;
  const record = (stage: string) => { const now = performance.now(); stages[stage] = Math.round(now - checkpoint); checkpoint = now; };
  const args = parseArgs(argv);

  let project: SceneScriptProject;
  let projectDir: string;
  if (args.sourcePath) {
    const sourcePath = path.resolve(args.sourcePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source document not found: ${sourcePath}`);
    }
    projectDir = path.dirname(sourcePath);
    project = await composeProject(args, sourcePath);
  } else {
    const projectPath = path.resolve(args.projectPath!);
    if (!fs.existsSync(projectPath)) {
      throw new Error(`SceneScript project not found: ${projectPath}`);
    }
    projectDir = path.dirname(projectPath);
    project = parseProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  }
  if (args.aspect) {
    project = parseProject({ ...project, aspect: args.aspect });
  }
  console.log(
    `[glint] project "${project.title}" — ${project.scenes.length} scenes (${project.language ?? "unknown"}), composed id: ${project.id}`,
  );

  const publicDir = session.publicDir;
  project = await copyProjectAssets(projectDir, publicDir, project);
  record("projectAndAssetsMs");
  const prepared = args.format === "png"
    ? structuredClone(project)
    : args.tts === "mock" ? prepareSilentProject(project)
    : await prepareAudio(project, await buildTtsProvider(args), args.voice, { concurrency: args.ttsConcurrency, noCache: args.noCache }, publicDir);
  if (args.tts === "mock" && args.format !== "png") console.warn("[glint] mock speech selected: SILENT export; no silent audio files generated");
  record("speechMs");
  if (args.format === "png") console.log("[glint] still export: skipping speech synthesis");
  const totalSeconds = buildTimeline(prepared).totalMs / 1000;
  console.log(`[glint] total duration ~${totalSeconds.toFixed(1)}s`);

  // Background music: "auto" synthesizes a royalty-free ambient pad; a file
  // path mixes the user's own track. Rendered under narration at low volume.
  const musicArg = args.music ?? "auto";
  if (musicArg !== "off" && args.format !== "png") {
    const audioRoot = path.join(publicDir, "audio");
    fs.mkdirSync(audioRoot, { recursive: true });
    const audioDir = fs.mkdtempSync(path.join(audioRoot, `${prepared.id}-music-`));
    if (musicArg === "auto") {
      const bgm = await generateAmbientMusic(totalSeconds * 1000, { mood: "calm" });
      const musicPath = `${path.relative(publicDir, audioDir).split(path.sep).join("/")}/bgm.wav`;
      fs.writeFileSync(path.resolve(publicDir, musicPath), bgm.audio);
      prepared.music = { src: musicPath, volume: 0.12 };
      console.log("[glint] background music: synthesized ambient pad (volume 12%)");
    } else {
      if (!fs.existsSync(path.resolve(musicArg))) {
        throw new Error(`Music file not found: ${musicArg}`);
      }
      const baseName = path.basename(musicArg);
      fs.copyFileSync(path.resolve(musicArg), path.join(audioDir, baseName));
      const prefix = path.relative(publicDir, audioDir).split(path.sep).join("/");
      prepared.music = { src: `${prefix}/${baseName}`, volume: 0.12 };
      console.log(`[glint] background music: ${baseName} (volume 12%)`);
    }
  }

  // Draft mode trades resolution and encoder effort for speed: half-size,
  // veryfast preset. Final delivery should re-render with an explicit profile.
  const isDraft = args.fast;
  const scale = isDraft ? 0.5 : 1;
  const concurrency = args.concurrency ?? Math.max(1, Math.min(4, os.cpus().length - 1));
  record("musicMs");

  console.log("[glint] bundling composition...");
  await Promise.all([
    prepared.scenes.some(scene => scene.kind === "html" && scene.animation) ? copyRuntimeDecoders(publicDir) : Promise.resolve(),
    prepared.scenes.some(scene => scene.kind === "three" && scene.model === "gltf") ? ensureDecoders(publicDir) : Promise.resolve(),
  ]);
  const { serveUrl, puppeteerInstance } = await session.acquire();
  record("bundleAndBrowserMs");
  const inputProps = { project: prepared };
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
    puppeteerInstance,
  });
  record("compositionMs");

  fs.mkdirSync(path.resolve("out"), { recursive: true });
  const output = args.outPath
    ? path.resolve(args.outPath)
    : path.resolve("out", `${prepared.id}.${args.format}`);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (args.format === "png") {
    console.log(`[glint] rendering still (frame ${args.frame}) → ${output}`);
    await renderStill({
      composition,
      serveUrl,
      inputProps,
      output,
      frame: args.frame,
      puppeteerInstance,
    });
  } else if (args.format === "gif") {
    const frameRange: [number, number] = [
      0,
      Math.min(composition.durationInFrames - 1, composition.fps * 6),
    ];
    console.log(
      `[glint] rendering GIF (first ${((frameRange[1] + 1) / composition.fps).toFixed(1)}s, 50% scale) → ${output}`,
    );
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      codec: "gif",
      outputLocation: output,
      frameRange,
      scale: 0.5,
      puppeteerInstance,
    });
  } else {
    console.log(
      `[glint] rendering ${composition.width}x${composition.height}${isDraft ? " (draft 50%)" : ""} @ ${composition.fps}fps → ${output}`,
    );
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      codec: "h264",
      pixelFormat: "yuv420p",
      scale,
      ...(isDraft
        ? encodingOptions("draft")
        : encodingOptions(args.encoding ?? "balanced")),
      outputLocation: output,
      concurrency,
      puppeteerInstance,
    });
  }
  console.log(`[glint] done: ${output}`);
  record("renderAndEncodeMs");
  fs.writeFileSync(`${output}.metrics.json`, JSON.stringify({ version: 1, format: args.format, tts: args.tts, encoding: args.fast ? "draft" : args.encoding ?? "balanced", concurrency, scale: args.format === "png" ? 1 : args.format === "gif" ? 0.5 : scale, frames: composition.durationInFrames, fps: composition.fps, stages, totalMs: Math.round(performance.now() - started), bytes: fs.statSync(output).size, session: session.stats }, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
const session = new RenderSession();
renderOnce(process.argv.slice(2), session).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[glint] render failed: ${message}`);
  process.exitCode = 1;
}).finally(() => session.dispose());
}
