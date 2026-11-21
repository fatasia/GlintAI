// Portions derived from OpenMotion (nexu-io/openmotion), Apache-2.0. Modifications: adapted to Glint SceneScript and zh-CN error messages.

import { z } from "zod";
import type { Scene, SceneScriptProject } from "@glintai/scenescript";
import { buildTimeline } from "@glintai/scenescript";
import { ComposerError } from "./errors";

/**
 * Motion brief (OpenMotion Motion.md 形制)：人类可读的改编合同——
 * `## Keep` / `## Replace` / `## Timing` / `## Review` 四节加一个
 * ```motion-demo JSON 代码块承载 params/presets。Markdown 仍是创作面，
 * zod 只固定机器可读的形状；渲染输出确定性 markdown，可写盘、可 diff。
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const BriefKind = z.enum(["page", "prototype", "slides", "video"]);
const DemoParam = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: z.enum(["text", "color", "number"]),
  value: z.string().max(2000),
  maxLength: z.number().int().positive().optional(),
});
const DemoPreset = z.object({
  label: z.string().min(1).max(200),
  values: z.record(z.string().max(2000)),
});

export const MotionBrief = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  kind: BriefKind.default("video"),
  source: z.object({ url: z.string().min(1).optional(), note: z.string().min(1).optional() }).optional(),
  keep: z.array(z.string().min(1).max(2000)).max(60),
  replace: z.array(z.object({
    target: z.string().min(1).max(2000),
    with: z.string().max(2000),
    hardLimits: z.array(z.string().min(1).max(500)).max(10).optional(),
  })).max(60),
  timing: z.array(z.object({
    shot: z.string().min(1).max(200),
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().positive(),
    transition: z.string().max(60).optional(),
  })).max(200),
  materials: z.array(z.string().min(1).max(2000)).max(40).optional(),
  review: z.object({ compareAt: z.array(z.string().min(1).max(500)).max(40), notes: z.string().max(2000).optional() }),
  brand: z.object({
    accent: z.string().regex(HEX, "accent 必须是 #RRGGBB 颜色"),
    bg: z.string().regex(HEX, "bg 必须是 #RRGGBB 颜色"),
    text: z.string().regex(HEX, "text 必须是 #RRGGBB 颜色"),
    displayFont: z.string().min(1).max(120).optional(),
  }).optional(),
  params: z.array(DemoParam).max(40),
  presets: z.array(DemoPreset).max(20),
});
export type MotionBrief = z.infer<typeof MotionBrief>;

/** Cross-field remix rules live on the render surface: the brief text is the validation contract. */
function validateRemixRules(brief: MotionBrief): void {
  const keys = new Set<string>();
  for (const param of brief.params) {
    if (keys.has(param.key)) fail(`参数 key 重复：${param.key}`);
    keys.add(param.key);
    if (param.type === "color" && !HEX.test(param.value)) fail(`color 参数 ${param.key} 的值必须是 #RRGGBB`);
    if (param.maxLength && param.value.length > param.maxLength) fail(`参数 ${param.key} 超过 maxLength ${param.maxLength}`);
  }
  for (const preset of brief.presets) {
    for (const key of Object.keys(preset.values)) {
      if (!keys.has(key)) fail(`预设「${preset.label}」引用了未定义的参数 ${key}`);
    }
  }
}

/** Seconds rendered like the OpenMotion catalog timing tables: 1000ms → "1.00s", 125ms → "0.125s". */
function fmtSeconds(ms: number): string {
  const text = (ms / 1000).toFixed(3).replace(/0+$/, "");
  const dot = text.indexOf(".");
  const int = dot < 0 ? text : text.slice(0, dot);
  const frac = dot < 0 ? "" : text.slice(dot + 1);
  return `${int}.${frac.padEnd(2, "0")}s`;
}

function fail(message: string): never {
  throw new ComposerError(`Motion 简报解析失败：${message}`);
}

function splitLines(body: string | string[]): string[] {
  return (Array.isArray(body) ? body : body.split(/\r?\n/)).map(line => line.trim()).filter(Boolean);
}

/** Index of the next `##` heading or ``` fence after `from` (sections never own the demo block). */
function nextHeading(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line) || line.startsWith("```")) return i;
  }
  return lines.length;
}

/** Body lines of a required `## heading` section (zh-CN error when missing). */
function sectionBody(lines: string[], heading: RegExp, label: string): string[] {
  const start = lines.findIndex(line => heading.test(line));
  if (start < 0) fail(`缺少 ## ${label} 小节`);
  return splitLines(lines.slice(start + 1, nextHeading(lines, start)));
}

const TIME_CELL = /^(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?\s*[–—~]\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?$/;

function cellMs(value: string, unit?: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return -1;
  return unit === "ms" || unit === "毫秒" ? Math.round(n) : Math.round(n * 1000);
}

/** Catalog table row `| 0.00–1.00s | 镜头 | 转场? |` → timing entry; null when not a time row. */
function parseTimeRow(line: string) {
  const cells = line.split("|").map(cell => cell.trim());
  const time = TIME_CELL.exec(cells[0] ?? "");
  if (!time || time[1] === undefined || time[3] === undefined) return null;
  const startMs = cellMs(time[1], time[2]);
  const endMs = cellMs(time[3], time[4] ?? time[2]);
  if (startMs < 0 || endMs <= startMs) fail(`Timing 行「${cells[0]}」的时间区间不合法`);
  const shot = cells[1];
  if (!shot) fail("Timing 行缺少镜头名");
  const transition = cells[2];
  return { shot, startMs, durationMs: endMs - startMs, ...(transition ? { transition } : {}) };
}

/** Prose beats like the portal profile: `0–0.45 s: card entrance. 0.45–2.5 s: portal reveal.` */
const PROSE_TIMING = /(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?\s*[–—~]\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?\s*[:：]?\s*([^.;。;]*?)(?=[.;。;]|$)/g;

function parseTiming(lines: string[]) {
  const rows: MotionBrief["timing"] = [];
  for (const raw of lines) {
    if (raw.includes("|")) {
      const line = raw.replace(/^\||\|$/g, "").trim();
      if (/^(时间|time)\s*\|/i.test(line) || /^[\s|–—-]+$/.test(line)) continue;
      const entry = parseTimeRow(line);
      if (entry) rows.push(entry);
      continue;
    }
    // Prose form (OpenMotion portal profile): each range sentence becomes one row.
    PROSE_TIMING.lastIndex = 0;
    for (let match = PROSE_TIMING.exec(raw); match; match = PROSE_TIMING.exec(raw)) {
      const [, start, startUnit, end, endUnit, shot = ""] = match;
      if (start === undefined || end === undefined) continue;
      const startMs = cellMs(start, startUnit);
      const endMs = cellMs(end, endUnit ?? startUnit);
      if (startMs < 0 || endMs <= startMs) fail(`Timing 行「${raw}」的时间区间不合法`);
      const label = shot.replace(/^[:：\s]+/, "").trim();
      rows.push({ shot: label || `镜头 ${rows.length + 1}`, startMs, durationMs: endMs - startMs });
    }
  }
  return rows;
}

/**
 * `target → with`（渲染形制）；兼容 OpenMotion portal 的散文形制
 * `target: with`。行尾括号可带硬限制：`(限制: a; b)` 拆多条，裸括号整体一条。
 */
function parseReplaceLine(line: string, ordinal: number): MotionBrief["replace"][number] {
  let rest = line;
  const hardLimits: string[] = [];
  const limitMatch = /\((?:限制|limits?)\s*:\s*([^)]+)\)\s*[.。]?\s*$/i.exec(rest);
  if (limitMatch && limitMatch[1] !== undefined) {
    // One parenthesis = one hard limit; limits containing ；stay intact so briefs round-trip.
    rest = rest.slice(0, limitMatch.index).trim();
    const trimmed = limitMatch[1].trim();
    if (trimmed) hardLimits.push(trimmed);
  } else {
    const bare = /\(([^)]+)\)\s*[.。]?\s*$/.exec(rest);
    if (bare && bare[1] !== undefined && bare.index > 0) {
      rest = rest.slice(0, bare.index).trim();
      hardLimits.push(bare[1].trim());
    }
  }
  const arrow = rest.indexOf("→");
  const colon = rest.search(/[:：]/);
  if (arrow > 0) {
    return { target: rest.slice(0, arrow).trim(), with: rest.slice(arrow + 1).trim(), ...(hardLimits.length ? { hardLimits } : {}) };
  }
  if (colon > 0) {
    return { target: rest.slice(0, colon).trim(), with: rest.slice(colon + 1).trim(), ...(hardLimits.length ? { hardLimits } : {}) };
  }
  fail(`第 ${ordinal + 1} 条 Replace 需要「目标 → 替换」或「目标: 替换」形制`);
}

function parseDemoBlock(block: string): { id: string; params: z.infer<typeof DemoParam>[]; presets: z.infer<typeof DemoPreset>[] } {
  let json: unknown;
  try { json = JSON.parse(block); } catch (error) { fail(`motion-demo 代码块不是合法 JSON：${(error as Error).message}`); }
  const result = z.object({
    id: z.string().min(1),
    params: z.array(DemoParam).default([]),
    presets: z.array(DemoPreset).default([]),
  }).safeParse(json);
  if (!result.success) fail("motion-demo 代码块缺少 id，或 params/presets 形制不合法");
  return result.data;
}

/**
 * Parses an OpenMotion-style Motion.md brief: `# title`, optional
 * `Source:`/`Note:`/`Kind:` header lines, the four required sections, optional
 * `## Materials and sound` / `## Brand` sections, and one ```motion-demo JSON
 * block (params/presets). Malformed input throws ComposerError in zh-CN.
 */
export function parseMotionBrief(text: string): MotionBrief {
  const lines = text.split(/\r?\n/).map(line => line.trimEnd());
  const h1 = lines.findIndex(line => /^#\s+\S/.test(line));
  if (h1 < 0) fail("缺少一级标题（# 简报名）");
  const title = (lines[h1] ?? "").slice(2).trim();

  const demo = /```motion-demo\s*([\s\S]*?)```/.exec(text);
  if (!demo || demo[1] === undefined) fail("缺少 motion-demo 代码块（params/presets 载体）");
  const demoData = parseDemoBlock(demo[1]);

  let kind: MotionBrief["kind"] = "video";
  const source: MotionBrief["source"] = {};
  for (const line of splitLines(lines.slice(h1 + 1, nextHeading(lines, h1)))) {
    const kv = /^(Source|Note|Kind)\s*:\s*(.+)$/i.exec(line);
    if (!kv || kv[2] === undefined) continue;
    const value = kv[2].trim();
    if (/^kind/i.test(kv[1] ?? "")) {
      const parsed = BriefKind.safeParse(value);
      kind = parsed.success ? parsed.data : fail(`Kind 取值不合法：${value}（page/prototype/slides/video）`);
    } else if (/^source/i.test(kv[1] ?? "") && /^https?:\/\//.test(value)) source.url = value;
    else source.note = value;
  }

  const keep = sectionBody(lines, /^##\s+keep\s*$/i, "Keep");
  const replace = sectionBody(lines, /^##\s+replace\s*$/i, "Replace").map((line, index) => parseReplaceLine(line.replace(/^-\s*/, ""), index));
  const timing = parseTiming(sectionBody(lines, /^##\s+timing\s*$/i, "Timing"));
  const reviewLines = sectionBody(lines, /^##\s+review\s*$/i, "Review");
  const compareAt = reviewLines.filter(line => /^-/.test(line)).map(line => line.replace(/^-\s*/, ""));
  const notes = reviewLines.filter(line => !/^-/.test(line)).map(line => line.replace(/^备注\s*[:：]\s*/, "")).join("；");
  const materials = lines.some(line => /^##\s+materials(\s+and\s+sound)?\s*$/i.test(line))
    ? sectionBody(lines, /^##\s+materials(\s+and\s+sound)?\s*$/i, "Materials") : undefined;
  const brandSection = lines.findIndex(line => /^##\s+brand(\s+kit)?\s*$/i.test(line));
  let brand: MotionBrief["brand"];
  if (brandSection >= 0) {
    const value = (key: string) => sectionBody(lines, /^##\s+brand(\s+kit)?\s*$/i, "Brand")
      .find(entry => new RegExp(`^${key}\\s*:`, "i").test(entry))
      ?.replace(new RegExp(`^${key}\\s*:\\s*`, "i"), "").trim();
    const accent = value("accent"), bg = value("bg"), text = value("text");
    if (!accent || !bg || !text) fail("Brand 小节需要 accent、bg、text 三行（#RRGGBB）");
    const displayFont = value("displayFont");
    brand = { accent, bg, text, ...(displayFont ? { displayFont } : {}) };
  }

  const candidate = {
    id: demoData.id,
    title,
    kind,
    ...(Object.keys(source).length ? { source } : {}),
    keep,
    replace,
    timing,
    ...(materials?.length ? { materials } : {}),
    review: { compareAt, ...(notes ? { notes } : {}) },
    ...(brand ? { brand } : {}),
    params: demoData.params,
    presets: demoData.presets,
  };
  const parsed = MotionBrief.safeParse(candidate);
  if (!parsed.success) fail(parsed.error.issues.map(issue => `${issue.path.join(".") || "(根)"}: ${issue.message}`).join("；"));
  validateRemixRules(parsed.data);
  return parsed.data;
}

/** Deterministic markdown render (OpenMotion Motion.md shape): writable, diff-able. */
export function renderMotionBrief(brief: MotionBrief): string {
  const range = (startMs: number, durationMs: number) => `${fmtSeconds(startMs)}–${fmtSeconds(startMs + durationMs)}`;
  const out: string[] = [`# ${brief.title}`];
  if (brief.source?.url) out.push(`Source: ${brief.source.url}`);
  if (brief.source?.note) out.push(`Note: ${brief.source.note}`);
  out.push(`Kind: ${brief.kind}`, "", "## Keep", ...brief.keep, "");
  out.push("## Replace", ...brief.replace.map(item =>
    `- ${item.target} → ${item.with}${item.hardLimits?.length ? ` (限制: ${item.hardLimits.join("；")})` : ""}`), "");
  out.push("## Timing", "| 时间 | 段落 | 转场 |", "|---|---|---|",
    ...brief.timing.map(item => `| ${range(item.startMs, item.durationMs)} | ${item.shot} | ${item.transition ?? ""} |`), "");
  if (brief.materials?.length) out.push("## Materials and sound", ...brief.materials, "");
  out.push("## Review", ...brief.review.compareAt.map(item => `- ${item}`),
    ...(brief.review.notes ? [`备注: ${brief.review.notes}`] : []), "");
  if (brief.brand) {
    out.push("## Brand", `accent: ${brief.brand.accent}`, `bg: ${brief.brand.bg}`, `text: ${brief.brand.text}`);
    if (brief.brand.displayFont) out.push(`displayFont: ${brief.brand.displayFont}`);
    out.push("");
  }
  const demo = {
    id: brief.id, title: brief.title, status: "authored",
    params: brief.params.map(({ key, label, type, value, maxLength }) => ({ key, label, type, value, ...(maxLength ? { maxLength } : {}) })),
    presets: brief.presets,
  };
  out.push("```motion-demo", JSON.stringify(demo, null, 2), "```", "");
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}

function shotLabel(scene: Scene): string {
  const labeled = scene as { title?: string; heading?: string; term?: string };
  const compact = (labeled.title ?? labeled.heading ?? labeled.term ?? scene.narration.text).replace(/\s+/g, " ").trim();
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact;
}

/** Scene text objects → Replace prompts; `with` stays blank for the author to fill. */
function replacePrompts(project: SceneScriptProject): MotionBrief["replace"] {
  const prompts: MotionBrief["replace"] = [];
  for (const scene of project.scenes) {
    for (const element of scene.elements ?? []) {
      if (element.kind === "text") prompts.push({ target: element.text, with: "" });
    }
    const asTitle = scene as { title?: string; items?: string[] };
    if (asTitle.title) prompts.push({ target: asTitle.title, with: "" });
    for (const item of asTitle.items ?? []) prompts.push({ target: item, with: "" });
  }
  return prompts.slice(0, 60);
}

/**
 * Drafts a Motion brief from an existing SceneScript project: the timeline
 * becomes the Timing table (cross-dissolve overlaps included via
 * buildTimeline), scene text objects become Replace prompts. params/presets
 * stay empty — remix inputs are authored, not inferred from the source.
 */
export function briefFromSceneScript(project: SceneScriptProject): MotionBrief {
  const timeline = buildTimeline(project);
  const timing = timeline.entries.map(({ scene, startMs, durationMs }) => {
    const entrance = scene.transition;
    return {
      shot: shotLabel(scene),
      startMs,
      durationMs,
      // Bare fades are the default look; only notable entrances land in the brief.
      ...(entrance && (entrance.in !== "fade" || entrance.durationMs || entrance.overlapMs) ? { transition: entrance.in } : {}),
    };
  });
  const first = timeline.entries[0];
  const materials = [
    ...project.scenes.filter(scene => scene.kind === "video" || scene.kind === "image")
      .map(scene => `素材片段：${(scene as { src?: string }).src ?? scene.id}`),
    ...(project.music ? [`背景音乐：${project.music.src}`] : []),
    ...(project.assets ?? []).map(asset => `身份素材（${asset.kind}）：${asset.name}`),
  ].slice(0, 40);
  return MotionBrief.parse({
    id: project.id,
    title: project.title,
    kind: "video",
    keep: [`${project.scenes.length} 个镜头的顺序、时长与旁白节奏`, `画幅 ${project.aspect}${project.fps ? ` · ${project.fps} fps` : ""}`],
    replace: replacePrompts(project),
    timing,
    ...(materials.length ? { materials } : {}),
    review: {
      compareAt: [
        `0.00s–${fmtSeconds(first?.durationMs ?? 0)}：首镜入场是否对齐`,
        `${fmtSeconds(timeline.totalMs)}：末镜留读与收尾`,
      ],
    },
    params: [],
    presets: [],
  });
}
