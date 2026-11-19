import { z } from "zod";
import { resolveTheme } from "@glintai/design-tokens";
import type { SceneElement } from "@glintai/scenescript";
import type { PlanScene } from "./plan";

/**
 * CREATE-08 visual planner: derive the concrete visual layer (layout, graphic
 * relation, camera motion) for each planned scene. Rule-based and deterministic
 * — same plan in, same plan out — so the wizard can show and edit it before any
 * model call. The LLM still owns kind and copy; this module only decides how a
 * shot is staged on screen.
 */

export const VisualLayout = z.enum(["full", "split-left", "split-right", "grid-2", "grid-3", "center-stack"]);
export const VisualRelation = z.enum(["none", "compare", "flow", "hierarchy", "timeline", "cause-effect"]);
export const VisualMotion = z.enum(["static", "zoom-in", "zoom-out", "pan-left", "reveal"]);

export type VisualLayout = z.infer<typeof VisualLayout>;
export type VisualRelation = z.infer<typeof VisualRelation>;
export type VisualMotion = z.infer<typeof VisualMotion>;

export const VisualPlanScene = z.object({
  /** Position in the plan (0-based). */
  sceneIndex: z.number().int().min(0),
  layout: VisualLayout,
  relation: VisualRelation,
  motion: VisualMotion,
  /** One-line Chinese rationale shown next to the scene in the wizard. */
  reason: z.string().min(1).max(120),
});
export type VisualPlanScene = z.infer<typeof VisualPlanScene>;

const RELATION_HINTS: Array<[VisualRelation, RegExp]> = [
  ["compare", /对比|相比|而(?!言)|差异|不同|vs\.?|优势|劣势/i],
  ["flow", /流程|步骤|然后|接着|首先|其次|最后|阶段|第一步/i],
  ["cause-effect", /因为|导致|所以|因此|原因|结果|影响/i],
  ["timeline", /\d{4}年|先后|历史|时间线|演进|发展历程/i],
];

/** Bullet counts drive grid-2 vs grid-3; count enumeration marks, separators and line breaks. */
function countPoints(text: string): number {
  const marks = text.match(/(?:^|\s)[①②③④⑤1-9][.、）)]|\s[•·]\s|；|;/g)?.length ?? 0;
  const separators = text.split(/[，,。]|(?:^|\s)和(?:\s|$)/).filter(part => part.trim().length > 1).length;
  return Math.max(marks, separators);
}

const LAYOUT_REASON: Record<VisualLayout, string> = {
  full: "全屏主体",
  "split-left": "对比关系→左分屏",
  "split-right": "主视觉右置、文字左栏",
  "grid-2": "两栏要点",
  "grid-3": "多要点三栏",
  "center-stack": "居中堆叠强调",
};
const RELATION_REASON: Record<VisualRelation, string> = {
  none: "无图形关系",
  compare: "对比关系",
  flow: "流程关系",
  hierarchy: "层级/从属关系",
  timeline: "时间线关系",
  "cause-effect": "因果关系",
};
const MOTION_REASON: Record<VisualMotion, string> = {
  static: "静止持稳",
  "zoom-in": "推进强调",
  "zoom-out": "拉远收束",
  "pan-left": "长镜头缓移",
  reveal: "逐层显现",
};

function relationFor(kind: PlanScene["kind"], text: string): VisualRelation {
  if (kind === "comparison") return "compare";
  if (kind === "diagram") return "flow";
  if (kind === "chart" || kind === "definition") return "hierarchy";
  const hint = RELATION_HINTS.find(([, pattern]) => pattern.test(text));
  return hint?.[0] ?? (kind === "bullets" ? "hierarchy" : "none");
}

function layoutFor(kind: PlanScene["kind"], relation: VisualRelation, text: string, index: number): VisualLayout {
  if (relation === "compare") return index % 2 === 0 ? "split-left" : "split-right";
  if (relation === "flow" || relation === "cause-effect") return countPoints(text) >= 3 ? "grid-3" : "grid-2";
  if (kind === "chart") return "split-right";
  if (kind === "image") return /全屏|特写|大图/.test(text) ? "full" : "split-right";
  if (kind === "title" || kind === "quote") return "center-stack";
  return countPoints(text) >= 3 ? "grid-3" : "grid-2";
}

function motionFor(kind: PlanScene["kind"], index: number, total: number, seconds: number): VisualMotion {
  if (kind === "quote") return "static";
  if (index === 0) return "zoom-in";
  if (index === total - 1) return "zoom-out";
  if (seconds >= 8) return "pan-left";
  return "reveal";
}

/** Plan the visual layer for every scene; user-edited fields win over the derivation. */
export function planVisuals(scenes: ReadonlyArray<Pick<PlanScene, "kind" | "visual" | "seconds" | "narration" | "layout" | "relation" | "motion">>): VisualPlanScene[] {
  return scenes.map((scene, index) => {
    const text = `${scene.visual} ${scene.narration}`;
    const relation = scene.relation ?? relationFor(scene.kind, text);
    const layout = scene.layout ?? layoutFor(scene.kind, relation, text, index);
    const motion = scene.motion ?? motionFor(scene.kind, index, scenes.length, scene.seconds);
    const bits = [LAYOUT_REASON[layout], RELATION_REASON[relation], MOTION_REASON[motion]];
    const extra = scene.kind === "bullets" && relation === "hierarchy" && countPoints(text) >= 3 ? "（要点较多）" : "";
    return { sceneIndex: index, layout, relation, motion, reason: `${bits.join("，")}${extra}` };
  });
}

/** Compact human summary for tooltips and the craft review. */
export function describeVisualPlan(plan: readonly VisualPlanScene[]): string {
  const counts = plan.reduce<Map<VisualRelation, number>>((map, scene) => map.set(scene.relation, (map.get(scene.relation) ?? 0) + 1), new Map());
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([relation, count]) => `${RELATION_REASON[relation]}×${count}`);
  return parts.length ? parts.join("、") : "无规划场景";
}

/**
 * Compose-pipeline wiring (CREATE-08): translate the planned motion into the
 * SceneScript whole-scene camera move. "static" maps to undefined — that is the
 * schema default and keeps generated projects minimal.
 */
export function cameraForMotion(motion: VisualMotion): { type: "push" | "pull" | "pan-left" | "drift"; intensity?: number } | undefined {
  switch (motion) {
    case "zoom-in": return { type: "push", intensity: 0.5 };
    case "zoom-out": return { type: "pull", intensity: 0.5 };
    case "pan-left": return { type: "pan-left", intensity: 0.5 };
    case "reveal": return { type: "drift", intensity: 0.35 };
    case "static": return undefined;
  }
}

/**
 * CREATE-08: translate the planned layout/relation into concrete SceneScript
 * elements, so the derived staging reaches BOTH renderers (Remotion overlay and
 * the SVG backend both draw scene.elements through evaluateElements). Anchors
 * stay structural: hairline dividers for split/grid layouts and one baseline
 * under directed relations — never full-bleed plates, which would cover the
 * scene content drawn underneath the overlay.
 */
export function layoutElements(layout: VisualLayout, relation: VisualRelation, theme: string): SceneElement[] {
  let border = "#3f3f46";
  let accent = "#7c8cff";
  try {
    const tokens = resolveTheme(theme);
    border = tokens.colors.border;
    accent = tokens.colors.accent;
  } catch { /* Unknown or inline theme string keeps the neutral anchors. */ }
  const dividers: Array<Pick<SceneElement & { kind: "rect" }, "x" | "w">> = [];
  if (layout === "split-left" || layout === "split-right" || layout === "grid-2") dividers.push({ x: 0.5, w: 0.004 });
  if (layout === "grid-3") dividers.push({ x: 1 / 3, w: 0.004 }, { x: 2 / 3, w: 0.004 });
  const elements: SceneElement[] = dividers.map((divider, index) => ({
    id: `layout-anchor-${index + 1}`,
    kind: "rect",
    x: divider.x,
    y: 0.5,
    w: divider.w,
    h: 0.84,
    fill: border,
  }));
  // Directed relations get a baseline to read as progression (flow / timeline /
  // cause-effect). compare relies on the layout divider as its boundary.
  if (relation === "flow" || relation === "timeline" || relation === "cause-effect") {
    elements.push({ id: "relation-baseline", kind: "rect", x: 0.5, y: 0.905, w: 0.72, h: 0.004, fill: accent });
  }
  if (relation === "compare" && !elements.length) {
    elements.push({ id: "relation-baseline", kind: "rect", x: 0.5, y: 0.5, w: 0.004, h: 0.84, fill: border });
  }
  return elements;
}
