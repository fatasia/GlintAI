import { buildTimeline, parseProject, type Scene, type SceneScriptProject } from "@glintai/scenescript";

export type LibraryVisual = { name: string; kind: "image" | "video" };
export function libraryVisual(name: string): LibraryVisual {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp|mp4)$/.test(name)) throw new Error("请选择素材库中的图片或 MP4 视频。");
  return { name, kind: name.endsWith(".mp4") ? "video" : "image" };
}

/** Adopt only on explicit user action. Structured scenes are never silently flattened. */
export function adoptLibraryVisual(project: SceneScriptProject, sceneId: string, name: string, mode: "replace" | "insert", newId?: string): SceneScriptProject {
  const input = parseProject(project), asset = libraryVisual(name);
  const index = input.scenes.findIndex(scene => scene.id === sceneId), target = input.scenes[index];
  if (!target) throw new Error("目标镜头不存在，请重新选择。");
  if (target.locked) throw new Error("目标镜头已锁定，请先解锁。");
  if (mode !== "replace" && mode !== "insert") throw new Error("未知采用方式。");
  if (mode === "replace" && target.kind !== "image" && target.kind !== "video") throw new Error("当前为结构化镜头，请添加为新镜头，避免丢失文字、图表或代码。");
  if (mode === "insert" && input.scenes.length >= 30) throw new Error("当前工作台最多 30 个镜头，请先整理镜头。");
  // Keep editorial content on replacement; never inherit stale source trims/speed/provenance.
  const replacement: Scene = mode === "replace" ? {
    id: target.id, kind: asset.kind, src: `assets/${asset.name}`, narration: structuredClone(target.narration),
    ...("caption" in target && target.caption ? { caption: target.caption } : {}),
    ...(target.elements ? { elements: structuredClone(target.elements) } : {}),
    ...(target.tracks ? { tracks: structuredClone(target.tracks) } : {}),
    ...(target.effects ? { effects: structuredClone(target.effects) } : {}),
    ...(target.transition ? { transition: structuredClone(target.transition) } : {}),
    ...(target.camera ? { camera: structuredClone(target.camera) } : {}),
    ...(target.beatPulse ? { beatPulse: structuredClone(target.beatPulse) } : {}),
    ...(target.assetRefs ? { assetRefs: structuredClone(target.assetRefs) } : {}),
    ...(target.notes ? { notes: target.notes } : {}), ...(target.quiz ? { quiz: structuredClone(target.quiz) } : {}),
    ...(target.sharedElements ? { sharedElements: structuredClone(target.sharedElements) } : {}),
  } : { id: newId ?? `media-${crypto.randomUUID()}`, kind: asset.kind, src: `assets/${asset.name}`, narration: { text: "请修改这段素材的旁白或说明。", durationMs: 3000 } };
  const scenes = [...input.scenes];
  if (mode === "replace") scenes[index] = replacement; else scenes.splice(index + 1, 0, replacement);
  const next = parseProject({ ...input, scenes });
  if (mode === "insert") {
    const positions = new Map(buildTimeline(next).entries.map(entry => [entry.scene.id, entry.startMs]));
    for (const entry of buildTimeline(input).entries) if (entry.scene.locked && positions.get(entry.scene.id) !== entry.startMs) throw new Error("添加会移动后续已锁定镜头，请先解锁。");
  }
  return next;
}
