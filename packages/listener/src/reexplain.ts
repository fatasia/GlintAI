import { Scene, type SceneScriptProject } from "@glintai/scenescript";
import type { LlmProvider } from "@glintai/llm";
import { ListenerError } from "./rehearse";

/**
 * One-click re-explain: rewrite exactly one scene in response to a real
 * confusion (or a direct instruction). The scene keeps its id and kind, so
 * the timeline, audio prep and render pipeline are untouched.
 */
export async function reexplain(
  project: SceneScriptProject,
  llm: LlmProvider,
  options: {
    sceneId: string;
    /** Who is confused; free text. Falls back to a generic sharpening pass. */
    confusion?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SceneScriptProject> {
  const index = project.scenes.findIndex((scene) => scene.id === options.sceneId);
  if (index === -1) {
    throw new ListenerError(
      `No scene with id "${options.sceneId}". Known ids: ${project.scenes.map((scene) => scene.id).join(", ")}`,
    );
  }
  const target = project.scenes[index]!;
  const neighbours = project.scenes
    .filter((scene) => scene.id !== target.id)
    .map((scene) => `[${scene.id}] (${scene.kind}) ${scene.narration.text}`)
    .join("\n");

  const response = await llm.chat({
    system: [
      "你是 Glint 的重讲导演。只重写指定的一个场景,让它对提出的困惑更好讲。",
      "规则:",
      "1. 输出只有一个 JSON 对象,就是重写后的完整场景,结构必须与输入场景一致(相同 kind、相同 id)。",
      "2. 保持与全片相同的语言;旁白长度与原场景相近(±30%)。",
      "3. 换类比、放慢节奏、补一步推导都可以,但不得引入资料之外的新事实。",
      "4. 场景结构字段(items/steps/left/right 等)允许微调,kind 不得改变。",
    ].join("\n"),
    temperature: 0.5,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    messages: [
      {
        role: "user",
        content: [
          `全片标题:${project.title}`,
          `其余场景(仅作上下文,不要输出):\n${neighbours}`,
          `待重写场景:\n${JSON.stringify(target, null, 2)}`,
          options.confusion
            ? `听众的困惑:${options.confusion}`
            : "任务:把这一场景讲得更通俗、更有画面感。",
        ].join("\n\n"),
      },
    ],
  });

  const start = response.text.indexOf("{");
  const end = response.text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ListenerError(
      `Model did not return a JSON scene. Reply excerpt: ${response.text.slice(0, 200)}`,
    );
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(response.text.slice(start, end + 1));
  } catch (error) {
    throw new ListenerError(
      `Model returned malformed JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const result = Scene.safeParse(candidate);
  if (!result.success) {
    throw new ListenerError(
      `Rewritten scene failed validation: ${result.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`,
    );
  }
  if (result.data.id !== target.id || result.data.kind !== target.kind) {
    throw new ListenerError(
      `Model changed scene identity (id/kind must stay "${target.id}"/"${target.kind}").`,
    );
  }
  const scenes = [...project.scenes];
  // Generated narration must never keep timing/audio from the previous take.
  delete result.data.narration.audioRef;
  delete result.data.narration.durationMs;
  delete result.data.narration.segments;
  if (target.narration.voice && !result.data.narration.voice) result.data.narration.voice = target.narration.voice;
  if (target.narration.speakingRate && !result.data.narration.speakingRate) result.data.narration.speakingRate = target.narration.speakingRate;
  options.signal?.throwIfAborted();
  scenes[index] = result.data;
  return { ...project, scenes };
}
