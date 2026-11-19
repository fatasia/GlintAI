import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";

export type ReviewSeverity = "block" | "warn" | "note";
export type ReviewFinding = { id: string; severity: ReviewSeverity; sceneId?: string; title: string; detail: string; action: string };
export type ReviewReport = { score: number; verdict: string; findings: ReviewFinding[]; stats: { scenes: number; seconds: number; textOnly: number; longestRun: number; movingScenes: number } };

const WEIGHT: Record<ReviewSeverity, number> = { block: 24, warn: 9, note: 3 };
const TEXTUAL = new Set(["title", "bullets", "definition", "quote"]);
const visualDevices = (scene: SceneScriptProject["scenes"][number]) =>
  (scene.elements?.length ?? 0) > 0 || ["image", "video", "chart", "diagram", "code", "comparison"].includes(scene.kind) || Boolean(scene.camera && scene.camera.type !== "static");

/**
 * A deterministic read of the cut, not a taste score: it flags the shapes that
 * reliably read as "slides" — text-only shots, equal pacing, no camera, runs of
 * the same layout — and says what to change. Numbers are thresholds, not opinions.
 */
export function reviewProject(project: SceneScriptProject): ReviewReport {
  const timeline = buildTimeline(project);
  const scenes = project.scenes;
  const findings: ReviewFinding[] = [];
  const durations = scenes.map((_, index) => timeline.entries[index]?.durationMs ?? 0);
  const textOnly = scenes.filter(scene => TEXTUAL.has(scene.kind) && !visualDevices(scene)).length;
  const movingScenes = scenes.filter(scene => scene.camera && scene.camera.type !== "static").length;

  let longestRun = 0, run = 0, runKind = "";
  for (const scene of scenes) {
    if (scene.kind === runKind) run += 1;
    else { runKind = scene.kind; run = 1; }
    longestRun = Math.max(longestRun, run);
  }

  if (scenes.length >= 3 && textOnly / scenes.length >= 0.5) {
    findings.push({ id: "text-only", severity: textOnly / scenes.length >= 0.7 ? "block" : "warn", title: `${textOnly} / ${scenes.length} 镜只有文字`,
      detail: "纯字卡连成片时，观众看到的是翻页而不是镜头。",
      action: "挑 1–2 个关键镜换成图片、图表或带元素的版式，其余保留字卡做节奏对比。" });
  }
  if (longestRun >= 3) {
    const scene = scenes[scenes.findIndex((item, index) => scenes.slice(index, index + longestRun).every(entry => entry.kind === item.kind))];
    findings.push({ id: "monotone-run", severity: "warn", sceneId: scene?.id, title: `连续 ${longestRun} 镜同一种版式`,
      detail: "相邻同类型镜头超过三镜，切点会失去存在感。",
      action: "中间插一镜不同类型（图表 / 引用 / 图片），或改运镜把节奏拉开。" });
  }
  if (durations.length >= 3) {
    const min = Math.min(...durations), max = Math.max(...durations);
    if (max > 0 && (max - min) / max < 0.08) {
      findings.push({ id: "flat-pacing", severity: "warn", title: "每镜几乎等长",
        detail: `最短 ${(min / 1000).toFixed(1)}s，最长 ${(max / 1000).toFixed(1)}s，节奏像 PPT。`,
        action: "让主张镜短、解释镜长；把 2–3 镜的时长差拉到 1.5 倍以上。" });
    }
  }
  if (movingScenes === 0 && scenes.length >= 3) {
    findings.push({ id: "no-motion", severity: "note", title: "全片没有运镜",
      detail: "所有镜头都是静止画面，动感只能靠切换。",
      action: "给 2–3 镜加推进或平移，强度 0.3–0.5 就够。" });
  }
  const first = scenes[0];
  if (first && first.kind === "title" && !first.subtitle && !visualDevices(first)) {
    findings.push({ id: "plain-opening", severity: "note", sceneId: first.id, title: "开场只有一行标题",
      detail: "第一印象决定了观众要不要继续看。",
      action: "补一句副标题、一个数字或一个主体画面。" });
  }
  const last = scenes.at(-1);
  if (last && last.kind === "title" && scenes.length > 2) {
    findings.push({ id: "card-ending", severity: "note", sceneId: last.id, title: "结尾落在字卡上",
      detail: "这是翻页式演示最常见的收尾方式。",
      action: "让结尾落在一个动作、一个结果或一个产品特写上。" });
  }
  if (project.aspect !== "9:16" && scenes.some(scene => scene.narration.text.length > 90)) {
    const scene = scenes.find(item => item.narration.text.length > 90);
    findings.push({ id: "portrait-readability", severity: "note", sceneId: scene?.id, title: "有镜头旁白超过 90 字",
      detail: "同一段文案在竖屏上会挤成三屏，字幕读不完。",
      action: "拆成两镜，或压到 60 字以内再出竖版。" });
  }
  const charts = scenes.filter(scene => scene.kind === "chart");
  if (charts.length > 0 && project.knowledgeSources.length === 0) {
    findings.push({ id: "numbers-without-source", severity: "warn", sceneId: charts[0]!.id, title: "图表没有来源",
      detail: "有数字但没有绑定资料来源，发布后无法核对。",
      action: "补一份来源，或把数值改成示意并明确标注。" });
  }
  if (timeline.totalMs < 6000 && scenes.length > 1) {
    findings.push({ id: "too-short", severity: "note", title: "总时长不足 6 秒",
      detail: "镜头还没建立就被切走。",
      action: "至少留 8–12 秒，或减少镜头数。" });
  }

  const score = Math.max(0, Math.min(100, 100 - findings.reduce((sum, finding) => sum + WEIGHT[finding.severity], 0)));
  const verdict = score >= 85 ? "可以给人看" : score >= 65 ? "能用，但还差一口气" : "先改再发";
  return { score, verdict, findings, stats: { scenes: scenes.length, seconds: Number((timeline.totalMs / 1000).toFixed(1)), textOnly, longestRun, movingScenes } };
}
