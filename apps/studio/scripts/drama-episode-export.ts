// DRAMA-07 / SKILL-09 整集合成与导出冒烟：剧本 → 分镜计划 → mock TTS → 多轨时间线
// 工程（NleProject）→ 真实 ffmpeg/浏览器渲染成片 → ffprobe 断言 → FCPXML/EDL 导出。
//   tsx scripts/drama-episode-export.ts --script=<剧本.txt> --out-dir=<evidence 目录>
//       [--episode=1] [--episode-size=6] [--aspect=9:16] [--fps=24] [--encoding=balanced]
// 约束：离线闭环——TTS 用 MockTtsProvider（静音 WAV，真实合同），渲染与混音全部本地
// ffmpeg + 本机 Chromium，不触任何在线模型或网关；断言失败以非零码退出。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildDramaEpisodePlan } from "@glintai/composer/drama-pipeline";
import { MockTtsProvider } from "@glintai/tts";
import { renderNle } from "./nle-render";
import { exportNleProjectTimeline } from "./nle-export";
import { buildDramaTimeline } from "./drama-timeline";
import { runMediaProcess } from "./native-process";

const arg = (name: string) => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = path.resolve(arg("out-dir") ?? path.join("evidence", "DRAMA-07", `run-${new Date().toISOString().slice(0, 10)}`));
const scriptFile = arg("script");
if (!scriptFile) { console.error("[drama07] requires --script=<剧本.txt> --out-dir=<dir>"); process.exit(1); }
const aspect = (arg("aspect") ?? "9:16") as "16:9" | "9:16" | "1:1";
const fps = Number(arg("fps") ?? 24);
const encoding = arg("encoding") ?? "balanced";
fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

// 1) 剧本 → 分镜计划（复用既有 buildDramaEpisodePlan，零模型）。
const screenplay = fs.readFileSync(scriptFile, "utf8");
fs.writeFileSync(path.join(outDir, "screenplay.txt"), screenplay, "utf8");
const { plan, episodes, characters } = buildDramaEpisodePlan({ screenplay, episode: Number(arg("episode") ?? 1) || 1, episodeSize: Number(arg("episode-size")) || undefined, aspect });
if (plan.scenes.length < 2) throw new Error(`整集至少需要 2 场，本集只有 ${plan.scenes.length} 场`);
fs.writeFileSync(path.join(outDir, "drama-plan.json"), JSON.stringify({ plan, episodes, characters }, null, 2));
console.log(`[drama07] 分镜：${plan.title} — ${plan.scenes.length} 场 / 角色 ${characters.join("、")}（剧本共 ${episodes} 集）`);

// 2) mock TTS：静音 WAV + 真实时长合同；场景卡：ffmpeg 色卡 + drawtext 场景标题。
const tts = new MockTtsProvider();
const sceneAudioMs: number[] = [];
const fontFile = [process.env.GLINT_DRAWTEXT_FONT, "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(file => file && fs.existsSync(file));
const escapeFilterPath = (value: string) => value.replace(/\\/g, "/").replace(/:/g, "\\:");
for (const [index, scene] of plan.scenes.entries()) {
  const nn = String(index + 1).padStart(2, "0");
  const voice = await tts.synthesize({ text: scene.narration, speakingRate: 1 });
  fs.writeFileSync(path.join(outDir, "assets", `scene-${nn}.wav`), Buffer.from(voice.audio));
  sceneAudioMs.push(voice.durationMs);
  const textFile = path.join(outDir, `card-${nn}.txt`);
  fs.writeFileSync(textFile, `${scene.goal}\n\n${scene.visual}`, "utf8");
  // drawtext 不换行也不自动缩字：按最长行（全角 1 / 半角 0.5）动态缩小字号防裁边。
  const cardWidth = plan.platform === "16:9" ? 1280 : plan.platform === "1:1" ? 1080 : 720;
  const longest = Math.max(...`${scene.goal}\n${scene.visual}`.split("\n").map(line => [...line].reduce((units, ch) => units + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.5), 0)), 1);
  const fontSize = Math.max(28, Math.min(56, Math.floor(cardWidth * 0.9 / longest)));
  const drawtext = fontFile
    ? `drawtext=textfile='${escapeFilterPath(textFile)}':fontfile='${escapeFilterPath(fontFile)}':fontcolor=white:fontsize=${fontSize}:line_spacing=24:x=(w-text_w)/2:y=h*0.12`
    : "null";
  await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x1b1b2f:s=${cardWidth}x${plan.platform === "16:9" ? 720 : plan.platform === "1:1" ? 1080 : 1280}`, "-frames:v", "1", "-vf", drawtext, path.join(outDir, "assets", `scene-${nn}.png`)], { timeoutMs: 60_000 });
  console.log(`[drama07] 场 ${index + 1}/${plan.scenes.length}：卡 + 旁白 WAV（mock ${voice.durationMs}ms）`);
}

// 3) 时间线工程：剪辑切点跟 mock TTS 实际时长走（三轨同切点）。
const timeline = buildDramaTimeline(plan, { fps, sceneAudioMs });
const projectFile = path.join(outDir, "nle-project.json");
fs.writeFileSync(projectFile, JSON.stringify(timeline.project, null, 2));

// 4) 整集成片：走既有 nle-render（浏览器逐帧 + ffmpeg 编码/混音）。
const mp4 = path.join(outDir, "episode.mp4");
const rendered = await renderNle({ projectFile, assetsDir: path.join(outDir, "assets"), out: mp4, encoding });
console.log(`[drama07] 渲染：${rendered.output}（${Math.round(rendered.bytes / 1024)} KB，时长 ${(rendered.durationMs / 1000).toFixed(2)}s）`);

// 5) 导出侧产物：FCPXML / EDL 时间线交换文件。
const fcpxml = exportNleProjectTimeline({ project: timeline.project, format: "fcpxml", outPath: path.join(outDir, "timeline.fcpxml"), assetPath: name => path.join(outDir, name) });
const edl = exportNleProjectTimeline({ project: timeline.project, format: "edl", outPath: path.join(outDir, "timeline.edl") });

// 6) ffprobe 断言：容器/流/分辨率/时长与时间线工程一致。
const probe = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", mp4], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
const media = JSON.parse(probe.stdout);
const videos = media.streams.filter((stream: { codec_type: string }) => stream.codec_type === "video");
const audios = media.streams.filter((stream: { codec_type: string }) => stream.codec_type === "audio");
const durationS = Number(media.format?.duration ?? NaN);
const expectedS = timeline.totalMs / 1000;
const checks = [
  { name: "视频流唯一且为 h264", pass: videos.length === 1 && videos[0]!.codec_name === "h264", actual: videos.map((stream: { codec_name: string }) => stream.codec_name) },
  { name: "音频流唯一且为 aac", pass: audios.length === 1 && audios[0]!.codec_name === "aac", actual: audios.map((stream: { codec_name: string }) => stream.codec_name) },
  { name: `分辨率 ${timeline.project.width}x${timeline.project.height}`, pass: videos[0]?.width === timeline.project.width && videos[0]?.height === timeline.project.height, actual: `${videos[0]?.width}x${videos[0]?.height}` },
  { name: `成片时长≈时间线 ${expectedS.toFixed(2)}s（±0.75s）`, pass: Math.abs(durationS - expectedS) <= 0.75, actual: durationS.toFixed(3) },
  { name: "封面帧已产出", pass: Boolean(rendered.cover), actual: rendered.cover ?? "missing" },
];
fs.writeFileSync(path.join(outDir, "ffprobe.json"), JSON.stringify({ checks, format: media.format, streams: media.streams }, null, 2));
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
  ranAt: new Date().toISOString(), chain: "screenplay→drama-plan→mock-tts→nle-project→nle-render(ffmpeg+chromium)→ffprobe",
  scenes: plan.scenes.length, episodes, characters, fps, encoding,
  sceneAudioMs, timelineTotalMs: timeline.totalMs, timelineStarts: timeline.starts,
  renderedBytes: rendered.bytes, renderedDurationMs: rendered.durationMs,
  exports: { fcpxmlClips: fcpxml.clips, fcpxmlTextClips: fcpxml.textClips, fcpxmlWarning: fcpxml.warning ?? null, edlClips: edl.clips },
  checks,
  verdict: checks.every(check => check.pass) ? "PASS" : "FAIL",
}, null, 2));
for (const check of checks) console.log(`[drama07] ${check.pass ? "PASS" : "FAIL"} — ${check.name}（实际：${JSON.stringify(check.actual)}）`);
if (!checks.every(check => check.pass)) { console.error("[drama07] ffprobe 断言未全过，见 ffprobe.json"); process.exit(1); }
console.log(`[drama07] PASS：整集成片 + ffprobe 断言全过；FCPXML ${fcpxml.clips} 剪辑点（文字片段 ${fcpxml.textClips} 条以警告保留）→ ${outDir}`);
