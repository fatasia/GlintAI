import { buildTimeline, editTimeline, parseProject, type SceneScriptProject } from "@glintai/scenescript";

export function parseEditorProject(value: unknown): SceneScriptProject {
  const project = parseProject(value);
  if (project.scenes.some(scene => !scene.narration.text.trim())) throw new Error("每个分镜需要非空旁白。");
  if (project.scenes.length > 30 || JSON.stringify(project).length > 100_000 || project.music || project.scenes.some(scene => ["html", "three"].includes(scene.kind) || scene.narration.audioRef || (scene.kind === "image" || scene.kind === "video") && !(scene.kind === "image" ? /^assets\/[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/ : /^assets\/[a-zA-Z0-9_-]{1,100}\.mp4$/).test(scene.src))) throw new Error("编辑器支持最多 30 个结构化镜头或素材库图片／视频；脚本、外部路径和外部配音请通过 CLI 制作。");
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

export function canMoveScene(project: SceneScriptProject, index: number, delta: number): boolean {
  const destination = index + delta;
  if (!Number.isInteger(index) || !Number.isInteger(delta) || index < 0 || index >= project.scenes.length || destination < 0 || destination >= project.scenes.length) return false;
  if (project.scenes.slice(Math.min(index, destination), Math.max(index, destination) + 1).some(scene => scene.locked)) return false;
  const scenes = [...project.scenes];
  [scenes[index], scenes[destination]] = [scenes[destination]!, scenes[index]!];
  const oldStarts = new Map(buildTimeline(project).entries.map(entry => [entry.scene.id, entry.startMs]));
  return buildTimeline({ ...project, scenes }).entries.every(entry => !entry.scene.locked || oldStarts.get(entry.scene.id) === entry.startMs);
}

export function moveScene(project: SceneScriptProject, index: number, delta: number): SceneScriptProject {
  if (!canMoveScene(project, index, delta)) return project;
  const next = structuredClone(project), destination = index + delta;
  [next.scenes[index], next.scenes[destination]] = [next.scenes[destination]!, next.scenes[index]!];
  return next;
}

export function canDeleteScene(project: SceneScriptProject, sceneId: string): boolean {
  try { editTimeline(project, { type: "ripple-delete", sceneId }); return true; } catch { return false; }
}

export function downloadText(name: string, text: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Duplicate one scene right after itself. Locked sources are refused, not silently unlocked. */
export function duplicateScene(project: SceneScriptProject, index: number, id: string): SceneScriptProject {
  const source = project.scenes[index];
  if (!source) throw new Error("目标镜头不存在。");
  if (source.locked) throw new Error("当前镜头已锁定，请先解锁再复制。");
  if (project.scenes.length >= 30) throw new Error("最多 30 个镜头，请先整理再复制。");
  const copy = structuredClone(source) as SceneScriptProject["scenes"][number];
  copy.id = id;
  const scenes = [...project.scenes];
  scenes.splice(index + 1, 0, copy);
  return parseProject({ ...project, scenes });
}

/** Reorder by drag; refuses when any locked scene's start time would change. */
export function reorderScenes(project: SceneScriptProject, from: number, to: number): SceneScriptProject {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return project;
  if (from < 0 || to < 0 || from >= project.scenes.length || to >= project.scenes.length) throw new Error("排序位置无效。");
  const scenes = [...project.scenes];
  const [moved] = scenes.splice(from, 1);
  scenes.splice(to, 0, moved!);
  const next = parseProject({ ...project, scenes });
  const before = new Map(buildTimeline(project).entries.map(entry => [entry.scene.id, entry.startMs]));
  const movedStart = buildTimeline(next).entries.find(entry => entry.scene.id === moved!.id)?.startMs;
  for (const entry of buildTimeline(next).entries) {
    if (!entry.scene.locked) continue;
    if (before.get(entry.scene.id) !== entry.startMs) throw new Error("排序会移动已锁定镜头，请先解锁。");
  }
  if (moved!.locked && movedStart !== before.get(moved!.id)) throw new Error("排序会移动已锁定镜头，请先解锁。");
  return next;
}