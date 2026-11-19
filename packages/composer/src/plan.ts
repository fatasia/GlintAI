import { z } from "zod";

/**
 * Creative brief → shootable plan. The LLM returns this JSON; every field is
 * validated before it reaches the UI, and the plan itself is plain data the
 * user edits before any scene is composed.
 */

export const PlanScene = z.object({
  /** What this shot must accomplish in one sentence. */
  goal: z.string().min(1).max(200),
  /** Voice-over / on-screen narration, ready to shoot. */
  narration: z.string().min(1).max(400),
  /** What the viewer sees, concrete enough to film or generate. */
  visual: z.string().min(1).max(300),
  /** Seconds; the wizard clamps to 1..120. */
  seconds: z.number().min(1).max(120),
  /** Suggested SceneScript scene kind for the composer. */
  kind: z.enum(["title", "bullets", "definition", "comparison", "quote", "chart", "diagram", "image"]).default("bullets"),
  /** CREATE-08 planned visual layer; omitted values fall back to the derived planner. */
  layout: z.enum(["full", "split-left", "split-right", "grid-2", "grid-3", "center-stack"]).optional(),
  relation: z.enum(["none", "compare", "flow", "hierarchy", "timeline", "cause-effect"]).optional(),
  motion: z.enum(["static", "zoom-in", "zoom-out", "pan-left", "reveal"]).optional(),
});
export type PlanScene = z.infer<typeof PlanScene>;

export const VideoPlan = z.object({
  title: z.string().min(1).max(120),
  /** One-line promise to the viewer; the hook of the first shot. */
  hook: z.string().min(1).max(200),
  audience: z.string().min(1).max(200),
  platform: z.enum(["16:9", "9:16", "1:1"]),
  /** Suggested look from the installed style packs. */
  theme: z.string().min(1).max(40),
  /** Estimated total seconds across scenes. */
  totalSeconds: z.number().min(1).max(600),
  /** Optional total production budget in CNY; advisory planning constraint only. */
  budgetCny: z.number().finite().min(0).max(1_000_000_000).optional(),
  /** What the viewer should do / feel afterwards. */
  takeaway: z.string().min(1).max(200),
  /** Language tag of the narration (TEAM-05 variants); absent for the source plan. */
  language: z.string().regex(/^[a-zA-Z-]{2,10}$/).optional(),
  scenes: z.array(PlanScene).min(1).max(30),
});
export type VideoPlan = z.infer<typeof VideoPlan>;

export const PLAN_SYSTEM = [
  "你是短视频策划与编剧。根据用户的目标、受众、平台和素材要点，产出一条可直接拍摄的视频计划。",
  "要求：",
  "1. scenes 3-8 个；第一个场景必须是 3 秒内能抓住人的 hook。",
  "2. narration 是口播原稿，口语化、一句一个信息点；不编造数据。",
  "3. visual 描述具体画面（主体、动作、文字），能拍摄也能生成。",
  "4. theme 从这些风格里选一个：glint-dark、glint-light、cream-editorial、mint-clean、bold-poster、hand-note、retro-news、blackboard-tech、whiteboard、blueprint。",
  "5. 只输出 JSON，不要解释。包含 title、hook、audience、platform、theme、totalSeconds、takeaway、scenes。若输入提供 budgetCny，原样保留该字段并据此控制制作复杂度；不编造精确报价。每个镜头包含 goal、narration、visual、seconds、kind。",
  "6. kind 从 title、bullets、definition、comparison、quote、chart、diagram 选择；没有真实图片素材时不要规划 image。totalSeconds 必须等于各镜头 seconds 之和。",
  "7. kind 必须跟随内容结构，不许默认 bullets：有对立/取舍用 comparison，有步骤/流程用 diagram，有明确数字对比用 chart，解释一个概念用 definition，只有并列要点才用 bullets。scenes 超过 3 个时，至少使用两种不同的非 title 类型。",
  "8. platform 字段只能输出 \"16:9\"、\"9:16\"、\"1:1\" 三个值之一，不要附加任何文字。",
].join("\n");

/** Models sometimes decorate enums ("16:9 短视频平台"); recover the value instead of wasting the paid call. */
function normalizeEnumishPlan(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const plan = value as Record<string, unknown>;
  if (typeof plan.platform === "string" && !["16:9", "9:16", "1:1"].includes(plan.platform)) {
    const text = plan.platform;
    plan.platform = text.includes("9:16") ? "9:16" : text.includes("1:1") ? "1:1" : text.includes("16:9") ? "16:9" : text;
  }
  return plan;
}

/** Parse the model reply; accepts fenced ```json blocks. Tolerates no prose. */
export function parsePlanReply(text: string): VideoPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{"), end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 计划；请重试或换一个描述。");
  return VideoPlan.parse(normalizeEnumishPlan(JSON.parse(fenced.slice(start, end + 1))));
}

/** Turn an approved plan into the markdown the offline composer already eats. */
export function planToSource(plan: VideoPlan): string {
  const lines = [`# ${plan.title}`, "", `> ${plan.hook}`, "", `受众：${plan.audience}`, `画幅：${plan.platform}`, ...(plan.budgetCny === undefined ? [] : [`制作预算参考：${plan.budgetCny}元（估算约束，不是报价）`]), ""];
  for (const scene of plan.scenes) {
    lines.push(`## ${scene.goal}`);
    lines.push(scene.narration);
    if (scene.visual) lines.push(``, `画面：${scene.visual}`);
    lines.push("");
  }
  return lines.join("\n");
}
