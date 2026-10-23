import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import { stylePackAesthetic, THEME_NAMES, type ThemeName } from "@glintai/design-tokens";
import type { LintIssue } from "@glintai/composer";

/** Rhythm lives in the style pack, so lint it instead of leaving the metadata decorative. */
export function styleRhythmIssues(project: SceneScriptProject): LintIssue[] {
  const theme = project.theme;
  if (typeof theme !== "string" || !(THEME_NAMES as readonly string[]).includes(theme)) return [];
  const { shotMs } = stylePackAesthetic(theme as ThemeName).pacing;
  return buildTimeline(project).entries.flatMap(entry =>
    entry.durationMs < shotMs[0] * 0.75 || entry.durationMs > shotMs[1] * 1.25
      ? [{ rule: "style-rhythm", level: "warn" as const, sceneId: entry.scene.id,
          message: `${theme} 的节奏是 ${shotMs[0]}–${shotMs[1]}ms/镜，本镜 ${entry.durationMs}ms；调整旁白长度或用精细剪辑改时长。` }]
      : []);
}
