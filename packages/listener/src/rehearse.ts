import { z } from "zod";
import type { SceneScriptProject } from "@glintai/scenescript";
import type { LlmProvider } from "@glintai/llm";
import { defaultPersonas, type ListenerPersona } from "./personas";

export class ListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenerError";
  }
}

const Confusion = z.object({
  sceneId: z.string(),
  confusion: z.string().min(1),
  suggestion: z.string().optional(),
});
export type Confusion = z.infer<typeof Confusion>;

export interface RehearsalReport {
  persona: ListenerPersona;
  confusions: Confusion[];
}

const ReplySchema = z.array(Confusion);

function buildScript(project: SceneScriptProject): string {
  return project.scenes
    .map(
      (scene, index) =>
        `场景 ${index + 1}/${project.scenes.length} [id: ${scene.id}] — ${scene.narration.text}`,
    )
    .join("\n");
}

/**
 * Each persona "listens" to the narration script and raises only the
 * confusions that would genuinely make THEM get lost — each mapped to a
 * concrete scene id so a re-explain can target exactly one scene.
 */
export async function rehearse(
  project: SceneScriptProject,
  llm: LlmProvider,
  options: {
    personas?: ListenerPersona[];
    maxPerPersona?: number;
    timeoutMs?: number;
  } = {},
): Promise<RehearsalReport[]> {
  const personas = options.personas ?? defaultPersonas(project.language);
  const maxPer = options.maxPerPersona ?? 4;
  const knownIds = new Set(project.scenes.map((scene) => scene.id));
  const script = buildScript(project);

  const reports = await Promise.all(
    personas.map(async (persona): Promise<RehearsalReport> => {
      const response = await llm.chat({
        system: [
          persona.prompt,
          "",
          "你正在「听」一条讲解视频的逐场景旁白(只有旁白,没有画面)。",
          "规则:",
          "1. 只对真正会让你困惑、走神或想划走的地方提出困惑;听懂了就不要硬提。",
          `2. 最多 ${maxPer} 条,按严重程度从高到低。`,
          '3. 输出只有一个 JSON 数组,形如 [{"sceneId":"场景id","confusion":"你的真实困惑","suggestion":"对创作者的一句建议"}]。',
          "4. sceneId 必须从给出的 [id: ...] 中选;整体没问题就输出 []。",
          "5. 困惑用第一人称,像真实观众弹幕,不要写成审稿意见。",
        ].join("\n"),
        temperature: 0.6,
        timeoutMs: options.timeoutMs,
        messages: [{ role: "user", content: script }],
      });

      const start = response.text.indexOf("[");
      const end = response.text.lastIndexOf("]");
      let parsed: Confusion[] = [];
      if (start !== -1 && end > start) {
        try {
          parsed = ReplySchema.parse(JSON.parse(response.text.slice(start, end + 1)));
        } catch {
          parsed = [];
        }
      }
      return {
        persona,
        confusions: parsed
          .slice(0, maxPer)
          .map((entry) => ({
            ...entry,
            // A hallucinated scene id must never break the targeting loop.
            sceneId: knownIds.has(entry.sceneId) ? entry.sceneId : "general",
          })),
      };
    }),
  );
  return reports;
}
