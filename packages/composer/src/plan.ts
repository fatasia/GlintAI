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
  /** What the viewer should do / feel afterwards. */
  takeaway: z.string().min(1).max(200),
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
  "5. 只输出 JSON，不要解释。",
].join("\n");

/** Parse the model reply; accepts fenced ```json blocks. Tolerates no prose. */
export function parsePlanReply(text: string): VideoPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{"), end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 计划；请重试或换一个描述。");
  return VideoPlan.parse(JSON.parse(fenced.slice(start, end + 1)));
}

/** Turn an approved plan into the markdown the offline composer already eats. */
export function planToSource(plan: VideoPlan): string {
  const lines = [`# ${plan.title}`, "", `> ${plan.hook}`, ""];
  for (const scene of plan.scenes) {
    lines.push(`## ${scene.goal}`);
    lines.push(scene.narration);
    if (scene.visual) lines.push(``, `画面：${scene.visual}`);
    lines.push("");
  }
  return lines.join("\n");
}
