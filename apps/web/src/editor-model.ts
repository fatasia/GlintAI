import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

export function parseEditorProject(value: unknown): SceneScriptProject {
  const project = parseProject(value);
  if (project.scenes.some(scene => !scene.narration.text.trim())) throw new Error("每个分镜需要非空旁白。");
  if (project.scenes.length > 30 || JSON.stringify(project).length > 100_000 || project.music || project.scenes.some(scene => ["html", "three"].includes(scene.kind) || scene.narration.audioRef || scene.kind === "image" && !/^assets\/[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(scene.src))) throw new Error("编辑器支持最多 30 个文字、图表或素材库图片场景；脚本和外部配音请通过 CLI 制作。");
  return project;
}

export function changeNarration(project: SceneScriptProject, index: number, text: string): SceneScriptProject {
  if (!text.trim()) return project;
  const next = structuredClone(project);
  const scene = next.scenes[index];
  if (!scene) throw new Error("Unknown scene");
  scene.narration = { text, ...(scene.narration.voice ? { voice: scene.narration.voice } : {}), ...(scene.narration.speakingRate ? { speakingRate: scene.narration.speakingRate } : {}) };
  return next;
}

export function moveScene(project: SceneScriptProject, index: number, delta: number): SceneScriptProject {
  const next = structuredClone(project);
  const destination = index + delta;
  if (destination < 0 || destination >= next.scenes.length) return next;
  [next.scenes[index], next.scenes[destination]] = [next.scenes[destination]!, next.scenes[index]!];
  return next;
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
