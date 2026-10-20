import type { ComposerOptions } from "./heuristic";
export type TemplateId = "explainer" | "listicle" | "versus" | "paper" | "howto" | "timeline" | "faq" | "mythfact" | "case-study" | "problem-solution" | "code-walkthrough" | "recap";
export interface SceneTemplate { id: TemplateId; label: string; description: string; requires: string; requiredKind?: string; bodyKinds?: string[] }
/** Browser-safe catalog, shared by the CLI, server and Web UI. */
export const TEMPLATES: SceneTemplate[] = [
  { id: "explainer", label: "概念讲解", description: "概念定义与资料中的要点、引语。", requires: "至少一段正文或列表" },
  { id: "listicle", label: "要点盘点", description: "按小节整理编号要点。", requires: "至少一个要点", requiredKind: "bullets", bodyKinds: ["bullets"] },
  { id: "versus", label: "对比评测", description: "两组资料并排比较，其余小节作补充。", requires: "至少两个有内容的小节", requiredKind: "comparison" },
  { id: "paper", label: "论文/报告解读", description: "按原文识别问题、方法、结果，附研究流程。", requires: "明确的方法与结果小节", requiredKind: "diagram" },
  { id: "howto", label: "操作教程", description: "步骤总览，再逐步讲解操作。", requires: "至少两个步骤或小节", requiredKind: "diagram" },
  { id: "timeline", label: "时间线", description: "保留原文的日期、阶段顺序与事件。", requires: "至少两个带日期或阶段标签的小节", requiredKind: "diagram" },
  { id: "faq", label: "问答讲解", description: "问题作标题，原文内容作回答。", requires: "至少一个问题小节", requiredKind: "definition", bodyKinds: ["definition"] },
  { id: "mythfact", label: "误区辨析", description: "将原文的误区和事实明确对照。", requires: "明确的误区与事实小节", requiredKind: "comparison" },
  { id: "case-study", label: "案例复盘", description: "背景、行动和结果串成案例路径。", requires: "至少两个背景/行动/结果小节", requiredKind: "diagram" },
  { id: "problem-solution", label: "问题与方案", description: "问题和解决方案对照，再解释执行路径。", requires: "明确的问题与方案小节", requiredKind: "comparison" },
  { id: "code-walkthrough", label: "代码走读", description: "保留代码片段并说明各段结构。", requires: "至少一个代码块", requiredKind: "code" },
  { id: "recap", label: "速览总结", description: "将跨小节要点压成一张回顾卡。", requires: "至少一段正文或列表", requiredKind: "bullets", bodyKinds: ["bullets"] },
];
export const THEME_IDS = ["glint-dark", "glint-light", "cream-editorial", "mint-clean", "bold-poster"] as const;
export function isTemplateId(value: string | undefined): value is TemplateId { return TEMPLATES.some((t) => t.id === value); }
export function templateById(id: string | undefined): SceneTemplate | undefined { return TEMPLATES.find((t) => t.id === id); }
export type { ComposerOptions };
