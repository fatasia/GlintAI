import { VideoPlan, planToSource, type VideoPlan as Plan } from "./plan";
import { splitScreenplay } from "./drama";

/**
 * DRAMA-07 / SKILL-09 短剧链（剧本→分集→单集分镜计划）：
 * 规则解析零模型。每场景一镜头：goal=场景标题，narration=对白合并（含角色名），
 * visual=场景动作描述，kind 由有无对白决定（quote/title）。
 * 时长按中文口播语速估算（≤3.5 字/秒，钳制在 2–8 秒），是预算不是承诺——
 * 真实时长仍由 TTS 音频决定。
 */
const MIN_SCENE_SECONDS = 2, MAX_SCENE_SECONDS = 8, CHARS_PER_SECOND = 3.5;

export interface DramaEpisodePlan { plan: Plan; planSource: string; episodes: number; characters: string[] }

export function buildDramaEpisodePlan(input: { screenplay: string; episode?: number; episodeSize?: number; theme?: string; aspect?: Plan["platform"] }): DramaEpisodePlan {
  const split = splitScreenplay(input.screenplay, { episodeSize: input.episodeSize });
  const episode = split.episodes.find(entry => entry.index === (input.episode ?? 1)) ?? split.episodes[0];
  if (!episode) throw new Error("剧本没有可解析的分集场景；确认含「第X场/场景X/INT./内景」格式的场景标题。");
  const scenes = episode.scenes.map((scene, index) => {
    const spoken = scene.dialogue.map(line => `${line.character}：${line.line}`).join(" ") || scene.action;
    const seconds = Math.max(MIN_SCENE_SECONDS, Math.min(MAX_SCENE_SECONDS, Math.ceil(spoken.length / CHARS_PER_SECOND) || MIN_SCENE_SECONDS));
    const kind = scene.dialogue.length ? "quote" as const : "title" as const;
    return {
      goal: scene.heading,
      narration: spoken.slice(0, 400),
      visual: (scene.action || `${scene.interior ? "内景" : "外景"} ${scene.location} ${scene.timeOfDay}`).slice(0, 300),
      seconds,
      kind: index === 0 && !scene.dialogue.length ? ("title" as const) : kind,
    };
  });
  const plan = VideoPlan.parse({
    title: `${episode.title || "短剧"}·第${episode.index}集`,
    hook: episode.scenes[0]?.heading ?? episode.title,
    audience: "短剧观众",
    platform: input.aspect ?? "9:16",
    theme: input.theme ?? "blackboard-tech",
    totalSeconds: scenes.reduce((sum, scene) => sum + scene.seconds, 0),
    takeaway: `第${episode.index}集共 ${scenes.length} 场`,
    scenes,
  });
  return { plan, planSource: planToSource(plan), episodes: split.episodes.length, characters: episode.characters };
}
