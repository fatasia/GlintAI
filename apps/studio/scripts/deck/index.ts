import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseProject, buildTimeline, sceneDurationMs, type SceneScriptProject } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { renderSceneSvg } from "../native-svg";
import { resolveMediaPath } from "../native-process";
import { xml } from "../native-svg/text";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildSync } from "esbuild";
import { deckCss } from "./styles";

export const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export async function exportDeck(options: { project: SceneScriptProject; projectDir: string; outDir: string; variant?: string }) {
  const project = parseProject(options.project), outDir = path.resolve(options.outDir);
  if (fs.existsSync(outDir)) throw new Error(`Deck output already exists; choose a new directory: ${outDir}`);
  const theme = resolveTheme(project.theme), c = theme.colors;
  // Validate all media before creating a partially usable export.
  const audio = project.scenes.map(scene => scene.narration.audioRef ? resolveMediaPath(options.projectDir, scene.narration.audioRef) : undefined);
  const timeline = buildTimeline(project);
  const variant = options.variant ?? "A";
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(variant)) throw new Error("Invalid deck variant");
  const scenes = project.scenes.map((scene, i) => ({
    id: scene.id,
    startMs: timeline.entries[i]!.startMs,
    durationMs: timeline.entries[i]!.durationMs,
    overlapMs: i > 0 ? timeline.entries[i - 1]!.startMs + timeline.entries[i - 1]!.durationMs - timeline.entries[i]!.startMs : 0,
    scene,
    previousScene: project.scenes[i - 1],
    label: "heading" in scene ? scene.heading || scene.id : "title" in scene ? scene.title : scene.id,
    image: `scenes/${scene.id}.svg`,
    audio: audio[i] ? `audio/${scene.id}${path.extname(audio[i]!)}` : undefined,
    narration: scene.narration,
    notes: scene.notes,
    quiz: scene.quiz,
  }));
  const svgs = project.scenes.map((scene, i) => renderSceneSvg(project, scene, Math.round(sceneDurationMs(scene) / 1000 * (project.fps ?? 30)) - 1, { plate: true, previousScene: project.scenes[i - 1] }));
  const digest = createHash("sha256").update(JSON.stringify(project)).digest("hex").slice(0, 20);
  fs.mkdirSync(path.join(outDir, "scenes"), { recursive: true }); fs.mkdirSync(path.join(outDir, "audio"));
  scenes.forEach((scene, i) => {
    fs.writeFileSync(path.join(outDir, scene.image), svgs[i]!);
    if (audio[i]) fs.copyFileSync(audio[i]!, path.join(outDir, scene.audio!));
  });
  const nativeEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native-svg", "index.ts").replace(/\\/g, "/");
  const browserBundle = buildSync({ stdin: { contents: `import {renderSceneSvg} from ${JSON.stringify(nativeEntry)}; window.__glintRender = renderSceneSvg;`, resolveDir: options.projectDir }, bundle: true, write: false, platform: "browser", format: "iife", target: "es2020", minify: true }).outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
  const runtimeSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime.ts"), "utf8");
  const runtimeScript = ts.transpileModule(runtimeSource.replace("export function deckRuntime", "function deckRuntime"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText + "\ndeckRuntime();";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(project.title)}</title><style>:root{--bg:${c.bg};--surface:${c.surface};--ink:${c.text};--muted:${c.textMuted};--line:${c.border};--accent:${c.accent};--font:${theme.fonts.body}}${deckCss}</style></head><body><header><strong>${xml(project.title)}</strong><button id="presenter-toggle" aria-expanded="false">演讲者视图</button><button id="presenter-window">独立演讲窗口</button><button id="fullscreen">全屏</button></header><main><div class="stage" style="aspect-ratio:${project.aspect.replace(":", "/")}"><img id="scene-previous" alt="上一镜叠化画面" hidden><img id="scene-image" alt="演示画面"></div><div class="progress"><div id="progress"></div></div><footer><button id="previous">上一页</button><span id="count"></span><button id="next">下一页</button><select id="outline" aria-label="跳转到页面"></select><button id="play">播放演示</button><label><input id="continuous" type="checkbox" checked> 连续播放</label></footer><div class="playhead"><input id="seek" type="range" min="0" max="1000" value="0" aria-label="本页播放进度"><span id="time"></span></div><p id="status" role="status" aria-live="polite"></p><div id="caption"></div><section id="quiz" hidden><h2 id="question"></h2><div id="answers" class="answers"></div><p id="result" role="status"></p><button id="relisten">重新听这一页</button><button id="reset">清空答题记录</button></section><section id="learning"><span id="learning-summary"></span><button id="export-learning">导出学习记录</button><p class="muted">记录仅存本地。答题率反映选择题表现，不等同于真实理解。</p></section><section id="presenter" hidden><div><h2>演讲备注</h2><p id="clock">00:00</p><p id="notes"></p></div><div><h2 id="next-label">下一页</h2><img id="next-image" alt="下一页预览"></div></section><p id="help">← → 翻页 · Home / End 首尾页 · Esc 关闭演讲者视图。演示动画与视频共用逐帧画面合同；旁白需提供本地音频。</p><audio id="voice" preload="metadata"></audio><audio id="voice-tail" preload="metadata"></audio></main><script id="deck-data" type="application/json">${safeJson({ digest, scenes, project, variant, totalMs: timeline.totalMs })}</script><script>${browserBundle}</script><script>${runtimeScript}</script></body></html>`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  fs.writeFileSync(path.join(outDir, "project.json"), JSON.stringify(project, null, 2));
  return { indexPath: path.join(outDir, "index.html"), sceneCount: scenes.length };
}
