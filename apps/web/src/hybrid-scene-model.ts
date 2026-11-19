import { parseProject, sceneDurationMs, type SceneScriptProject } from "@glintai/scenescript";
import { t } from "./ui/i18n";

export function addMotionScene(project: SceneScriptProject, id: string, title: string): SceneScriptProject {
  if (project.frozen || project.scenes.length >= 30) throw new Error(t("hybrid.cannotAdd"));
  return parseProject({ ...project, scenes: [...project.scenes, { id, kind: "title", title, narration: { text: title, durationMs: 3000 } }] });
}

export function addAnimatedLabel(project: SceneScriptProject, sceneId: string, id: string, text: string): SceneScriptProject {
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene || scene.locked || project.frozen || (scene.elements?.length ?? 0) >= 20 || (scene.tracks?.length ?? 0) >= 40) throw new Error(t("hybrid.cannotLabel"));
  return parseProject({ ...project, scenes: project.scenes.map(item => item.id !== sceneId ? item : { ...item,
    elements: [...(item.elements ?? []), { id, kind: "text", text, x: 0.5, y: 0.75, fontSize: 56, align: "center" }],
    tracks: [...(item.tracks ?? []), { id: `fade-${id}`, elementId: id, property: "opacity", keyframes: [{ atMs: 0, value: 0 }, { atMs: Math.min(400, sceneDurationMs(item)), value: 1 }] }],
  }) });
}
