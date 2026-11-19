import { LOOK_PRESETS, makeLookPreset, parseNleProject, type NleClip, type NleProject } from "@glintai/scenescript";

export type CatalogKind = "filter" | "transition";
export type TransitionEdge = "in" | "out";
export interface NleCatalogItem { id: string; name: string; description: string }
export const FILTER_CATALOG: readonly NleCatalogItem[] = [
  { id: "original", name: "原色", description: "清空片段滤镜，保留变换、蒙版和转场。" },
  ...LOOK_PRESETS.map(item => ({ id: item.id, name: item.label, description: item.summary })),
];
export const TRANSITION_CATALOG: readonly NleCatalogItem[] = [
  { id: "none", name: "无转场", description: "恢复直接切换，不改变片段起止时间。" },
  { id: "fade", name: "淡入淡出", description: "透明度渐变，适合平稳衔接。" },
  { id: "slide", name: "滑入滑出", description: "画面沿水平方向移入或移出。" },
  { id: "zoom", name: "缩放", description: "缩放与透明度共同变化，强调画面进入。" },
  { id: "wipe", name: "擦除", description: "逐步揭示或收起画面。" },
];
export interface CatalogChoice {
  kind: CatalogKind;
  presetId: string;
  strength: number;
  edge: TransitionEdge;
  durationMs: number;
}
export interface CatalogTarget { trackId: string; clipId: string }

export function catalogBlockReason(project: NleProject, target: CatalogTarget | null, kind: CatalogKind): string | null {
  const track = project.tracks.find(item => item.id === target?.trackId);
  const clip = track?.clips.find(item => item.id === target?.clipId);
  if (!clip || !track) return "先在时间线选择一个画面或文字片段。";
  if (track.locked) return "轨道已锁定，请解锁后再应用。";
  if (clip.kind === "audio") return "音频片段不支持画面滤镜和转场，请选择画面或文字片段。";
  if (kind === "filter" && clip.effects?.some(effect => effect.keyframes?.length)) return "片段含动画效果。为保留关键帧，请先在工程中确认如何处理原有效果。";
  return null;
}

function patchFor(choice: CatalogChoice, clip: NleClip): Partial<NleClip> {
  if (choice.kind === "filter") {
    if (!FILTER_CATALOG.some(item => item.id === choice.presetId)) throw new Error("未找到滤镜，请重新选择。");
    return { effects: choice.presetId === "original" ? [] : makeLookPreset(choice.presetId, choice.strength / 100, `look-${clip.id.slice(0, 24)}`) };
  }
  if (!TRANSITION_CATALOG.some(item => item.id === choice.presetId)) throw new Error("未找到转场，请重新选择。");
  const transition = choice.presetId === "none" ? undefined : {
    type: choice.presetId as NonNullable<NleClip["transitionIn"]>["type"], durationMs: choice.durationMs,
  };
  return choice.edge === "in" ? { transitionIn: transition } : { transitionOut: transition };
}

export function applyCatalogChoice(project: NleProject, target: CatalogTarget, choice: CatalogChoice): NleProject {
  const reason = catalogBlockReason(project, target, choice.kind);
  if (reason) throw new Error(reason);
  return parseNleProject({ ...project, tracks: project.tracks.map(track => track.id !== target.trackId ? track : {
    ...track, clips: track.clips.map(clip => clip.id !== target.clipId ? clip : { ...clip, ...patchFor(choice, clip) }),
  }) });
}

export function catalogPreviewProject(project: NleProject, target: CatalogTarget, choice: CatalogChoice): NleProject | null {
  const track = project.tracks.find(item => item.id === target.trackId);
  const clip = track?.clips.find(item => item.id === target.clipId);
  if (!track || !clip || clip.kind === "audio") return null;
  // Preview is isolated from the timeline and never changes the editor's session document.
  return parseNleProject({ ...project, tracks: [{ ...track, muted: false, locked: false, clips: [{
    ...clip, ...patchFor(choice, clip), startMs: 0, transitionIn: undefined, transitionOut: undefined,
    ...(choice.kind === "transition" ? patchFor(choice, clip) : {}),
  }] }] });
}
