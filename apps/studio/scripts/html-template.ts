import fs from "node:fs";
import path from "node:path";
import { parseProject, sceneDurationMs, type HtmlScene } from "@glintai/scenescript";
import { readArg } from "./glint-runtime";

type Poster = { template: "poster-v1"; headline: string; subtitle: string; accent: string; background: string; durationMs: number };
type Countdown = { template: "countdown-v1"; seconds: number; label: string; accent: string; background: string };
type Progress = { template: "progress-v1"; percent: number; label: string; accent: string; background: string; fillMs: number };
type TemplateParams = Poster | Countdown | Progress;
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const hex = (value: string | undefined, fallback: string) => value ?? fallback;
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/** Fixed authored templates: only escaped text, validated colors and finite timings enter the document. */
const templates = {
  "poster-v1": {
    defaults: { template: "poster-v1", headline: "你的标题", subtitle: "一句话说明", accent: "#f0654d", background: "#17141f", durationMs: 900 } as Poster,
    render(params: Poster): string {
      const marker = encodeURIComponent(JSON.stringify(params));
      return `<!--glint-template:${marker}--><div id="stage" style="box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;padding:9%;background:${params.background};color:#f8f5ef;font-family:sans-serif;overflow:hidden"><div id="bar" style="width:20%;height:1.3%;min-height:6px;background:${params.accent};margin-bottom:5%;transform-origin:left center"></div><div id="headline" style="font-size:clamp(24px,7vw,110px);font-weight:800;line-height:1.1;overflow-wrap:anywhere">${xml(params.headline)}</div><div id="subtitle" style="font-size:clamp(14px,2.7vw,42px);line-height:1.4;margin-top:4%;overflow-wrap:anywhere;color:#e2d9d4">${xml(params.subtitle)}</div></div><script>window.__glintTimeline=function(gsap){var t=gsap.timeline({paused:true});t.fromTo('#bar',{scaleX:0},{scaleX:1,duration:${params.durationMs / 1000},ease:'power2.out'},0);t.fromTo('#headline',{y:45,opacity:0},{y:0,opacity:1,duration:${params.durationMs / 1000},ease:'power2.out'},0);t.fromTo('#subtitle',{y:20,opacity:0},{y:0,opacity:1,duration:${params.durationMs / 1000},ease:'power2.out'},0.15);return t;};</script>`;
    },
    validate(params: Poster): void {
      if (params.template !== "poster-v1" || typeof params.headline !== "string" || !params.headline.trim() || params.headline.length > 120 || typeof params.subtitle !== "string" || params.subtitle.length > 180) throw new Error("标题需 1–120 字，副标题最多 180 字。");
      if (!isColor(params.accent) || !isColor(params.background)) throw new Error("颜色必须为 #RRGGBB。");
      if (!Number.isInteger(params.durationMs) || params.durationMs < 100 || params.durationMs > 5000) throw new Error("入场时长必须为 100–5000 毫秒。");
    },
    narration: (params: Poster) => params.headline,
    sceneDuration: (params: Poster) => Math.max(3000, params.durationMs + 150),
    editDuration: (params: Poster) => params.durationMs,
  },
  "countdown-v1": {
    defaults: { template: "countdown-v1", seconds: 5, label: "", accent: "#f0654d", background: "#121017" } as Countdown,
    render(params: Countdown): string {
      // 初始数字(seconds)直接内联可见:GSAP 对 position 0 的 set 在 seek(0) 不应用。
      const cells = Array.from({ length: params.seconds + 1 }, (_, index) => `<span style="grid-area:1/1;font-size:clamp(48px,22vw,320px);font-weight:800;font-variant-numeric:tabular-nums;color:${index === 0 ? params.accent : "#f8f5ef"};opacity:${index === params.seconds ? 1 : 0}">${index}</span>`).join("");
      const label = params.label ? `<div style="font-size:clamp(14px,3vw,44px);letter-spacing:.2em;color:#e2d9d4;margin-bottom:6%">${xml(params.label)}</div>` : "";
      // 确定性切换:t.set 绝对置状态——到点显示当前数字并隐藏上一个;
      // To 动画只增不隐,seek 到后段会让所有数字层叠。
      const steps = Array.from({ length: params.seconds + 1 }, (_, index) => {
        const at = params.seconds - index;
        const hide = index < params.seconds ? `t.set('#count span:nth-child(${index + 2})',{autoAlpha:0},${at});` : "";
        return `t.set('#count span:nth-child(${index + 1})',{autoAlpha:1},${at});${hide}`;
      }).join("");
      const fade = `t.fromTo('#count',{scale:1.06},{scale:1,duration:${Math.max(0.3, params.seconds * 0.12)},ease:'power1.out'},0);t.to('#count',{opacity:0.35,duration:0.2},${params.seconds});`;
      const marker = encodeURIComponent(JSON.stringify(params));
      return `<!--glint-template:${marker}--><div id="stage" style="box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${params.background};font-family:sans-serif;overflow:hidden">${label}<div id="count" style="display:grid;place-items:center">${cells}</div></div><script>window.__glintTimeline=function(gsap){var t=gsap.timeline({paused:true});${steps}${fade}return t;};</script>`;
    },
    validate(params: Countdown): void {
      if (params.template !== "countdown-v1" || !Number.isInteger(params.seconds) || params.seconds < 3 || params.seconds > 60) throw new Error("倒计时需 3–60 秒的整数。");
      if (typeof params.label !== "string" || params.label.length > 60) throw new Error("标签最多 60 字。");
      if (!isColor(params.accent) || !isColor(params.background)) throw new Error("颜色必须为 #RRGGBB。");
    },
    narration: (params: Countdown) => params.label || "倒计时",
    sceneDuration: (params: Countdown) => (params.seconds + 1) * 1000,
    editDuration: (params: Countdown) => params.seconds * 1000 + 200,
  },
  "progress-v1": {
    defaults: { template: "progress-v1", percent: 72, label: "", accent: "#f0654d", background: "#121017", fillMs: 3000 } as Progress,
    render(params: Progress): string {
      // 百分比计数用逐值 span + t.set 绝对置状态(与 countdown 同族):原生渲染在
      // seek 时抑制 onUpdate 回调,回调驱动的文本不会应用;条宽用 fromTo 属性补间,
      // ease none 保证条宽百分比与数字一致。初始 0% 内联可见(GSAP position-0 set 在 seek(0) 不应用)。
      const cells = Array.from({ length: params.percent + 1 }, (_, v) => `<span style="grid-area:1/1;font-size:clamp(48px,18vw,260px);font-weight:800;font-variant-numeric:tabular-nums;color:#f8f5ef;line-height:1;opacity:${v === 0 ? 1 : 0}">${v}%</span>`).join("");
      const steps = Array.from({ length: params.percent + 1 }, (_, v) => {
        const at = params.fillMs * v / params.percent / 1000;
        const hide = v > 0 ? `t.set('#pct span:nth-child(${v})',{autoAlpha:0},${at});` : "";
        return `t.set('#pct span:nth-child(${v + 1})',{autoAlpha:1},${at});${hide}`;
      }).join("");
      const label = params.label ? `<div style="font-size:clamp(14px,3vw,44px);letter-spacing:.2em;color:#e2d9d4;margin-bottom:5%">${xml(params.label)}</div>` : "";
      const marker = encodeURIComponent(JSON.stringify(params));
      const fill = params.fillMs / 1000;
      return `<!--glint-template:${marker}--><div id="stage" style="box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${params.background};font-family:sans-serif;overflow:hidden;padding:9%">${label}<div id="pct" style="display:grid;place-items:center">${cells}</div><div id="track" style="width:84%;height:2.6%;min-height:10px;margin-top:6%;background:rgba(255,255,255,.14);border-radius:999px;overflow:hidden"><div id="fill" style="width:100%;height:100%;background:${params.accent};transform:scaleX(0);transform-origin:left center;border-radius:inherit"></div></div></div><script>window.__glintTimeline=function(gsap){var t=gsap.timeline({paused:true});t.fromTo('#fill',{scaleX:0},{scaleX:${params.percent / 100},duration:${fill},ease:'none'},0);${steps}return t;};</script>`;
    },
    validate(params: Progress): void {
      if (params.template !== "progress-v1" || !Number.isInteger(params.percent) || params.percent < 1 || params.percent > 100) throw new Error("进度需 1–100 的整数百分比。");
      if (typeof params.label !== "string" || params.label.length > 60) throw new Error("标签最多 60 字。");
      if (!isColor(params.accent) || !isColor(params.background)) throw new Error("颜色必须为 #RRGGBB。");
      if (!Number.isInteger(params.fillMs) || params.fillMs < 500 || params.fillMs > 10000) throw new Error("填充时长必须为 500–10000 毫秒。");
    },
    narration: (params: Progress) => params.label || "进度展示",
    sceneDuration: (params: Progress) => Math.max(3000, params.fillMs + 400),
    editDuration: (params: Progress) => params.fillMs,
  },
} as const;

type TemplateId = keyof typeof templates;
const isTemplateId = (value: unknown): value is TemplateId => typeof value === "string" && Object.hasOwn(templates, value);
const commonArgs = new Set(["project", "scene", "out", "template", "accent", "background"]);
const templateArgs: Record<TemplateId, readonly string[]> = {
  "poster-v1": ["headline", "subtitle", "duration-ms"],
  "countdown-v1": ["seconds", "label"],
  "progress-v1": ["percent", "fill-ms", "label"],
};

function validateArgs(args: string[], templateId: TemplateId): void {
  const seen = new Set<string>();
  for (const arg of args) {
    if (arg === "--append") {
      if (seen.has("append")) throw new Error("参数 --append 不可重复。");
      seen.add("append");
      continue;
    }
    const match = /^--([a-z-]+)=/.exec(arg);
    if (!match) throw new Error(`无效参数：${arg}；请使用 --参数=值。`);
    const key = match[1]!;
    if (!commonArgs.has(key) && !templateArgs[templateId].includes(key)) throw new Error(`模板 ${templateId} 不支持参数 --${key}。`);
    if (seen.has(key)) throw new Error(`参数 --${key} 不可重复。`);
    seen.add(key);
  }
}

export function readTemplate(scene: HtmlScene): TemplateParams {
  const match = /^<!--glint-template:([^>]{1,5000})-->/.exec(scene.html);
  if (!match || scene.animation !== "gsap") throw new Error("该镜头不是 Glint 可编辑模板；原 HTML 不会被覆盖。");
  let params: TemplateParams;
  try { params = JSON.parse(decodeURIComponent(match[1]!)) as TemplateParams; } catch { throw new Error("模板参数损坏；原 HTML 不会被覆盖。"); }
  if (!params || typeof params !== "object" || !isTemplateId(params.template)) throw new Error("未知模板类型；原 HTML 不会被覆盖。");
  const template = templates[params.template];
  template.validate(params as never);
  if (template.render(params as never) !== scene.html) throw new Error("模板 HTML 已手动修改；为保留修改，请新建镜头而不是覆盖。");
  return params;
}

/** Explicitly add a new template or update a verified template into a new file. */
export function runHtmlTemplate(args: string[]): void {
  const file = readArg(args, "project"), id = readArg(args, "scene"), outArg = readArg(args, "out"), append = args.includes("--append");
  const templateArg = readArg(args, "template");
  if (!file || !id) throw new Error("html-template requires --project=<project.json> --scene=<id>");
  if (templateArg !== undefined && !isTemplateId(templateArg)) throw new Error("可选模板：poster-v1、countdown-v1、progress-v1。");
  const projectFile = fs.realpathSync(file), parent = path.dirname(projectFile);
  const project = parseProject(JSON.parse(fs.readFileSync(projectFile, "utf8")));
  const existing = project.scenes.find(scene => scene.id === id);
  const editing = append || ["headline", "subtitle", "accent", "background", "duration-ms", "seconds", "label", "percent", "fill-ms"].some(key => readArg(args, key) !== undefined);
  if (editing && existing?.locked) throw new Error("Scene is locked");
  const templateId: TemplateId = (append ? templateArg as TemplateId | undefined : undefined) ?? "poster-v1";
  const selected = append ? templateId : existing?.kind === "html" ? readTemplate(existing).template : templateId;
  if (!append && templateArg !== undefined && templateArg !== selected) throw new Error("模板类型不符：该镜头是另一模板，参数不可互换；请新建镜头。");
  validateArgs(args, selected);
  if (!editing) {
    if (outArg) throw new Error("No changes requested; omit --out to inspect");
    if (!existing || existing.kind !== "html") throw new Error("Select a Glint template scene, or pass --append to create one");
    console.log(JSON.stringify({ sceneId: id, parameters: readTemplate(existing), templates: Object.keys(templates), note: "本地可信模板；Web 不接受 HTML 场景。" }, null, 2)); return;
  }
  if (!outArg) throw new Error("Pass --out=<new project.json> beside the original");
  if (append && existing) throw new Error("Scene id already exists");
  if (!append && (!existing || existing.kind !== "html")) throw new Error("Select a Glint template scene");
  if (existing?.locked) throw new Error("Scene is locked");
  const previous = append ? templates[templateId].defaults : readTemplate(existing as HtmlScene);
  const scene = templates[previous.template as TemplateId];
  const number = (key: string, fallback: number) => { const arg = readArg(args, key); return arg === undefined ? fallback : arg.trim() ? Number(arg) : NaN; };
  let params: TemplateParams;
  if (previous.template === "countdown-v1") {
    const prior = previous as Countdown;
    params = { template: "countdown-v1", seconds: number("seconds", prior.seconds), label: readArg(args, "label") ?? prior.label, accent: hex(readArg(args, "accent"), prior.accent), background: hex(readArg(args, "background"), prior.background) };
  } else if (previous.template === "progress-v1") {
    const prior = previous as Progress;
    params = { template: "progress-v1", percent: number("percent", prior.percent), label: readArg(args, "label") ?? prior.label, accent: hex(readArg(args, "accent"), prior.accent), background: hex(readArg(args, "background"), prior.background), fillMs: number("fill-ms", prior.fillMs) };
  } else {
    const prior = previous as Poster;
    const duration = readArg(args, "duration-ms");
    params = { template: "poster-v1", headline: readArg(args, "headline") ?? prior.headline, subtitle: readArg(args, "subtitle") ?? prior.subtitle, accent: hex(readArg(args, "accent"), prior.accent), background: hex(readArg(args, "background"), prior.background), durationMs: duration === undefined ? prior.durationMs : Number(duration) };
  }
  scene.validate(params as never);
  const html = scene.render(params as never);
  if (append) project.scenes.push({ id, kind: "html", html, animation: "gsap", narration: { text: scene.narration(params as never), durationMs: scene.sceneDuration(params as never) } });
  else {
    if (scene.editDuration(params as never) + 150 > sceneDurationMs(existing!)) throw new Error("入场时间超出该镜头长度；请缩短入场或先调整镜长。");
    (existing as HtmlScene).html = html;
  }
  const output = path.resolve(outArg);
  if (fs.realpathSync(path.dirname(output)) !== parent) throw new Error("Output must be beside the input project so relative assets remain valid");
  fs.writeFileSync(output, JSON.stringify(parseProject(project), null, 2) + "\n", { flag: "wx" });
  console.log(`[glint] HTML 模板已写入新工程：${output}`);
}
