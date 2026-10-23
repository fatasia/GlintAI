#!/usr/bin/env node
/**
 * 10 风格包 × 15 秒样片生成器（HANDOFF 9.4）。
 *
 * 用法（仓库根目录）：
 *   node --import <tsx> scripts/render-style-samples.mjs [--only=id,id] [--force]
 *
 * 产物（outputs/style-samples/）：
 *   <style-id>.mp4              1280x720 / 30fps / H.264 draft(crf24 veryfast) / 无音轨
 *   <style-id>.project.json     实际送入渲染器的 SceneScript（可复核主题与分镜）
 *   <style-id>.metrics.json     命令、耗时、字节、ffprobe、主题 token、抽帧统计
 *   <style-id>.probe.json       该支的 ffprobe 原始 JSON
 *   frames/<style-id>.png       第 2 秒抽帧
 *   contact-sheet.png           可用帧拼成的 contact sheet
 *   manifest.json               总清单（含失败项与原因）
 *
 * 另有 <style-id>.qa.json 由单独一步生成（不属本脚本）：
 *   pnpm glint qa --video=outputs/style-samples/<id>.mp4 --out=outputs/style-samples/<id>.qa.json
 *
 * 渲染器：与 `pnpm glint render` 同一条 Remotion 管线（Glint composition），
 * 唯一差别是 scale=2/3（1280x720）。CLI 的 `--fast` 固定 50%（960x540），
 * `--encoding=draft` 固定 100%（1920x1080），没有 720p 档位，故由本脚本直接
 * 调用 @remotion/renderer。TTS=mock、music=off：输出无音轨。
 *
 * 串行渲染；每支完成后立即 ffprobe + 抽帧 + 亮度方差校验，任一失败记 failed。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STUDIO = path.join(ROOT, "apps", "studio");
const OUT = path.join(ROOT, "outputs", "style-samples");
const FRAMES = path.join(OUT, "frames");
const FPS = 30;
const FRAME_AT_SEC = 2;
const TARGET_SEC = 15;

const args = process.argv.slice(2);
const readArg = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const hasFlag = (name) => args.includes(`--${name}`);
const only = readArg("only")?.split(",").map((id) => id.trim()).filter(Boolean);
const force = hasFlag("force");
const concurrency = Number(readArg("concurrency") ?? 4);
const skipSheet = hasFlag("skip-sheet");

function log(message) {
  console.log(`[style-samples] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function findSystemChrome() {
  if (process.env.GLINT_CHROME_EXECUTABLE && fs.existsSync(process.env.GLINT_CHROME_EXECUTABLE)) {
    return process.env.GLINT_CHROME_EXECUTABLE;
  }
  const programFiles = process.env.PROGRAMFILES ?? "C:/Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${localAppData}/Google/Chrome/Application/chrome.exe`,
    `${programFiles}/Google/Chrome/Application/chrome.exe`,
    `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}

/** 与 apps/studio/src/Root.tsx 的 Glint composition 同源；4 镜合计 15.0s（静音时长估算）。 */
const SCENES = [
  {
    id: "title",
    kind: "title",
    title: "风格，是决策",
    subtitle: "十套风格包 · 同一份脚本",
    narration: { text: "同一份十五秒脚本，我们换十种风格来看。" },
  },
  {
    id: "definition",
    kind: "definition",
    term: "风格包",
    definition: "一组固定的审美决策：配色、字体、构图、动效与节奏。",
    narration: { text: "每个风格包都固定了配色、字体和节奏。" },
  },
  {
    id: "comparison",
    kind: "comparison",
    heading: "同一段文字，两种读法",
    left: { label: "元数据", points: ["主题名与 token", "字体与字号阶梯", "动效与节奏规则"] },
    right: { label: "渲染像素", points: ["背景与强调色", "圆角与留白", "标题与字幕"] },
    narration: { text: "左边是元数据，右边是实际渲染出来的像素。" },
  },
  {
    id: "quote",
    kind: "quote",
    text: "风格不是滤镜，是一整套约束。",
    attribution: "Glint 风格包 · 样片 15s",
    narration: { text: "风格不是滤镜，而是一整套审美的约束。" },
  },
];

function projectFor(styleId, label) {
  return {
    schemaVersion: 1,
    id: `style-sample-${styleId}`,
    title: `风格样片 · ${label}`,
    language: "zh-CN",
    aspect: "16:9",
    fps: FPS,
    knowledgeSources: [],
    theme: styleId,
    // A gentle one-pass drift keeps the still-life layouts from reading as frozen slides.
    scenes: structuredClone(SCENES).map(scene => ({ ...scene, camera: { type: "drift", intensity: 0.35 } })),
  };
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    cwd: options.cwd ?? ROOT,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").toString().trim().split("\n").slice(-6).join("\n");
    fail(`${command} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function probe(file) {
  const result = run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const data = JSON.parse(result.stdout);
  const video = (data.streams ?? []).find((stream) => stream.codec_type === "video");
  if (!video) fail(`no video stream in ${file}`);
  return {
    raw: data,
    codec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    durationSec: Number(data.format?.duration ?? video.duration),
    fps: video.r_frame_rate,
    nbFrames: Number(video.nb_frames ?? 0) || null,
    audioStreams: (data.streams ?? []).filter((stream) => stream.codec_type === "audio").length,
    bytes: Number(data.format?.size ?? fs.statSync(file).size),
  };
}

/** 抽第 2 秒一帧；同时用 64x36 原始像素算亮度均值/标准差，证明不是空白/黑帧。 */
function extractFrame(file, pngPath) {
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  run("ffmpeg", ["-v", "error", "-y", "-i", file, "-ss", String(FRAME_AT_SEC), "-frames:v", "1", pngPath]);
  if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size < 2048) {
    fail(`frame extraction produced no usable PNG: ${pngPath}`);
  }
  const raw = run("ffmpeg", [
    "-v", "error", "-i", file, "-ss", String(FRAME_AT_SEC), "-frames:v", "1",
    "-vf", "scale=64:36", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
  ], { encoding: "buffer" });
  const pixels = raw.stdout;
  const colors = new Set();
  let sum = 0;
  let sumSq = 0;
  const count = Math.floor(pixels.length / 3);
  for (let i = 0; i < count; i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    colors.add((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
  }
  const mean = count ? sum / count : 0;
  const stddev = count ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : 0;
  return {
    path: path.relative(ROOT, pngPath).split(path.sep).join("/"),
    bytes: fs.statSync(pngPath).size,
    lumaMean: Number(mean.toFixed(2)),
    lumaStdDev: Number(stddev.toFixed(2)),
    sampledColors: colors.size,
    blank: stddev < 3 || colors.size < 8,
  };
}

function contactSheet(framePaths, sheetPath) {
  if (framePaths.length === 0) return null;
  if (framePaths.length === 1) {
    // xstack needs at least two inputs; a single tile is still a valid (degenerate) sheet.
    run("ffmpeg", ["-v", "error", "-y", "-i", framePaths[0], "-vf", "scale=1280:720", "-frames:v", "1", sheetPath]);
    return { path: path.relative(ROOT, sheetPath).split(path.sep).join("/"), bytes: fs.statSync(sheetPath).size, cols: 1, rows: 1, tiles: 1 };
  }
  const cols = framePaths.length >= 8 ? 5 : Math.min(4, framePaths.length);
  const rows = Math.ceil(framePaths.length / cols);
  const tileW = 512;
  const tileH = 288;
  const cellW = tileW + 8;
  const cellH = tileH + 8;
  const filter = framePaths.map((_, index) => `[${index}:v]scale=${tileW}:${tileH},pad=${cellW}:${cellH}:4:4:0x141414[p${index}]`).join(";");
  const layout = framePaths.map((_, index) => `${(index % cols) * cellW}_${Math.floor(index / cols) * cellH}`).join("|");
  const stack = framePaths.map((_, index) => `[p${index}]`).join("") + `xstack=inputs=${framePaths.length}:layout=${layout}[out]`;
  run("ffmpeg", [
    "-v", "error", "-y",
    ...framePaths.flatMap((file) => ["-i", file]),
    "-filter_complex", `${filter};${stack}`,
    "-map", "[out]", "-frames:v", "1", sheetPath,
  ]);
  return { path: path.relative(ROOT, sheetPath).split(path.sep).join("/"), bytes: fs.statSync(sheetPath).size, cols, rows, tiles: framePaths.length };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const designTokens = await import(pathToFileURL(path.join(ROOT, "packages/design-tokens/src/index.ts")).href);
  const { parseProject } = await import(pathToFileURL(path.join(ROOT, "packages/scenescript/src/index.ts")).href);
  const { prepareSilentProject } = await import(pathToFileURL(path.join(STUDIO, "scripts/render.ts")).href);
  const { RenderSession } = await import(pathToFileURL(path.join(STUDIO, "scripts/render-session.ts")).href);
  const { encodingOptions } = await import(pathToFileURL(path.join(STUDIO, "scripts/encoding.ts")).href);

  const requireStudio = createRequire(path.join(STUDIO, "package.json"));
  const rendererRoot = path.dirname(requireStudio.resolve("@remotion/renderer/package.json"));
  const rendererEntry = path.join(rendererRoot, "dist", "esm", "index.mjs");
  if (!fs.existsSync(rendererEntry)) fail(`@remotion/renderer ESM entry not found: ${rendererEntry}`);
  const { selectComposition, renderMedia } = await import(pathToFileURL(rendererEntry).href);

  const packs = designTokens.STYLE_PACKS;
  const themes = designTokens.themes;
  const allIds = packs.map((pack) => pack.name);
  const selected = only && only.length ? only : allIds;
  for (const id of selected) {
    if (!allIds.includes(id)) fail(`unknown style id "${id}"; known: ${allIds.join(", ")}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(FRAMES, { recursive: true });

  const chrome = findSystemChrome();
  if (chrome) process.env.GLINT_CHROME_EXECUTABLE = chrome;

  // RenderSession bundles `path.resolve("src/index.ts")`, so the process cwd must be apps/studio.
  process.chdir(STUDIO);

  log(`style packs: ${allIds.length} (${allIds.join(", ")})`);
  log(`selected: ${selected.length}; renderer=remotion Glint composition; scale=2/3 (1280x720); encoding=draft; tts=mock; music=off`);
  log(`chrome: ${chrome ?? "remotion-managed browser"}`);

  const manifestPath = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { version: 1, generatedAt: null, renderer: null, baseProject: null, entries: [] };
  manifest.generatedAt = new Date().toISOString();
  manifest.invocation = process.argv.slice(1).map((item) =>
    path.isAbsolute(item) ? path.relative(ROOT, item).split(path.sep).join("/") : item,
  );
  manifest.renderer = {
    pipeline: "remotion",
    composition: "Glint",
    scale: 2 / 3,
    encoding: encodingOptions("draft"),
    tts: "mock (silent, estimated durations)",
    music: "off",
    frameAtSec: FRAME_AT_SEC,
    chrome: chrome ?? "remotion-managed",
  };
  manifest.baseProject = {
    id: "style-sample-*",
    aspect: "16:9",
    fps: FPS,
    scenes: SCENES.map((scene) => ({ id: scene.id, kind: scene.kind })),
    estimatedDurationMs: null,
  };
  manifest.entries = manifest.entries.filter((entry) => !selected.includes(entry.id));
  writeJson(manifestPath, manifest);

  const session = new RenderSession();
  const sessionStarted = performance.now();
  const frames = [];
  try {
    const { serveUrl, puppeteerInstance } = await session.acquire();
    log(`bundle ready (${Math.round(performance.now() - sessionStarted)}ms)`);

    for (const [index, id] of selected.entries()) {
      const pack = packs.find((item) => item.name === id);
      const theme = themes[id];
      const label = pack.label;
      const outFile = path.join(OUT, `${id}.mp4`);
      const projectFile = path.join(OUT, `${id}.project.json`);
      const metricsFile = path.join(OUT, `${id}.metrics.json`);
      const probeFile = path.join(OUT, `${id}.probe.json`);
      const frameFile = path.join(FRAMES, `${id}.png`);
      const prefix = `(${index + 1}/${selected.length}) ${id}`;
      const startedAt = new Date().toISOString();
      const hostStart = performance.now();
      const entry = {
        id,
        label,
        category: pack.category,
        status: "failed",
        themeOverride: null,
        rerunCommand: `node --import tsx scripts/render-style-samples.mjs --only=${id}${force ? " --force" : ""}`,
        renderer: "remotion/Glint",
        output: path.relative(ROOT, outFile).split(path.sep).join("/"),
        project: path.relative(ROOT, projectFile).split(path.sep).join("/"),
        startedAt,
        hostWallMs: null,
        renderMs: null,
        bytes: null,
        probe: null,
        frame: null,
        error: null,
      };

      try {
        let project;
        try {
          project = parseProject(projectFor(id, label));
        } catch (error) {
          fail(`project invalid for ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const prepared = prepareSilentProject(project);
        const inputProps = { project: prepared };
        const timelineMs = prepared.scenes.reduce((total, scene) => total + (scene.narration.durationMs ?? 0), 0);
        manifest.baseProject.estimatedDurationMs = timelineMs;

        fs.rmSync(outFile, { force: true });
        writeJson(projectFile, prepared);

        log(`${prefix}: rendering ${timelineMs}ms → ${path.relative(ROOT, outFile)}`);
        const renderStart = performance.now();
        const composition = await selectComposition({ serveUrl, id: "Glint", inputProps, puppeteerInstance });
        let lastLogged = -1;
        await renderMedia({
          composition,
          serveUrl,
          inputProps,
          codec: "h264",
          pixelFormat: "yuv420p",
          scale: 2 / 3,
          ...encodingOptions("draft"),
          outputLocation: outFile,
          concurrency,
          puppeteerInstance,
          onProgress: ({ progress }) => {
            const bucket = Math.floor(progress * 4);
            if (bucket > lastLogged) {
              lastLogged = bucket;
              log(`${prefix}: ${Math.round(progress * 100)}%`);
            }
          },
        });
        entry.renderMs = Math.round(performance.now() - renderStart);
        entry.hostWallMs = Math.round(performance.now() - hostStart);
        entry.bytes = fs.statSync(outFile).size;
        entry.composition = {
          width: composition.width,
          height: composition.height,
          fps: composition.fps,
          durationInFrames: composition.durationInFrames,
        };

        const probed = probe(outFile);
        fs.writeFileSync(probeFile, `${JSON.stringify(probed.raw, null, 2)}\n`);
        entry.probe = {
          durationSec: probed.durationSec,
          width: probed.width,
          height: probed.height,
          codec: probed.codec,
          fps: probed.fps,
          nbFrames: probed.nbFrames,
          audioStreams: probed.audioStreams,
          bytes: probed.bytes,
        };
        if (probed.width !== 1280 || probed.height !== 720) fail(`unexpected resolution ${probed.width}x${probed.height}`);
        if (!(Math.abs(probed.durationSec - TARGET_SEC) <= 1)) fail(`duration ${probed.durationSec}s outside ${TARGET_SEC}s ± 1s`);
        if (probed.audioStreams !== 0) fail(`expected a silent draft (0 audio streams), found ${probed.audioStreams}`);

        entry.frame = extractFrame(outFile, frameFile);
        if (entry.frame.blank) fail(`frame at ${FRAME_AT_SEC}s looks blank (luma stddev ${entry.frame.lumaStdDev}, ${entry.frame.sampledColors} colors)`);

        entry.theme = {
          name: theme ? id : null,
          tokens: theme ? {
            colors: theme.colors,
            fonts: theme.fonts,
            fontSizes: theme.fontSizes,
            radius: theme.radius,
            motion: theme.motion,
          } : null,
          aesthetic: pack.aesthetic,
        };
        entry.status = "done";
        log(`${prefix}: done in ${entry.hostWallMs}ms (${entry.renderMs}ms render), ${probed.width}x${probed.height}, ${probed.durationSec}s, ${entry.bytes} bytes`);
      } catch (error) {
        entry.status = "failed";
        entry.error = error instanceof Error ? error.message : String(error);
        entry.hostWallMs = Math.round(performance.now() - hostStart);
        log(`${prefix}: FAILED — ${entry.error}`);
      }

      manifest.entries = manifest.entries.filter((item) => item.id !== id);
      manifest.entries.push(entry);
      manifest.entries.sort((a, b) => allIds.indexOf(a.id) - allIds.indexOf(b.id));
      writeJson(metricsFile, entry);
      writeJson(manifestPath, manifest);

      if (entry.status === "done" && entry.frame) {
        frames.push(path.join(ROOT, entry.frame.path));
      }
    }
  } finally {
    await session.dispose();
  }

  const runEntries = manifest.entries.filter((entry) => selected.includes(entry.id));
  manifest.totals = {
    requested: manifest.entries.length,
    done: manifest.entries.filter((entry) => entry.status === "done").length,
    failed: manifest.entries.filter((entry) => entry.status === "failed").length,
    bytes: manifest.entries.filter((entry) => entry.status === "done").reduce((total, entry) => total + (entry.bytes ?? 0), 0),
  };
  // This invocation only — a `--only=` rerun must not report the whole set as its own cost.
  manifest.lastRun = {
    selected,
    hostWallMs: Math.round(performance.now() - sessionStarted),
    renderMs: runEntries.reduce((total, entry) => total + (entry.renderMs ?? 0), 0),
    finishedAt: null,
  };

  if (!skipSheet) {
    try {
      const sheet = contactSheet(frames, path.join(OUT, "contact-sheet.png"));
      manifest.contactSheet = sheet;
      if (sheet) log(`contact sheet: ${sheet.tiles} tiles (${sheet.cols}x${sheet.rows}) → ${sheet.path}`);
    } catch (error) {
      manifest.contactSheet = { error: error instanceof Error ? error.message : String(error) };
      log(`contact sheet FAILED — ${manifest.contactSheet.error}`);
    }
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.lastRun.finishedAt = manifest.finishedAt;
  writeJson(manifestPath, manifest);
  const runDone = runEntries.filter((entry) => entry.status === "done").length;
  log(`done: ${runDone}/${runEntries.length} in this run; ${manifest.totals.done}/${manifest.totals.requested} total, ${manifest.totals.failed} failed, ${(manifest.lastRun.hostWallMs / 1000).toFixed(1)}s this run`);
  if (manifest.totals.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[style-samples] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
