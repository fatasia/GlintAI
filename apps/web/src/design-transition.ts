import type { DesignPage } from "./design-artifacts";
/** Per-page "entering this page" transition; bounded to the scenescript video range so delivery never clamps. */
export type DesignTransitionType = "none" | "fade" | "push" | "wipe" | "zoom";
export type DesignTransition = { type: DesignTransitionType; durationMs: number };
export const DESIGN_TRANSITION_TYPES: DesignTransitionType[] = ["none", "fade", "push", "wipe", "zoom"];
export const designTransitionLabels: Record<DesignTransitionType, string> = { none: "无", fade: "淡入淡出", push: "推入", wipe: "擦除", zoom: "缩放" };
export const DESIGN_TRANSITION_MIN_MS = 120, DESIGN_TRANSITION_MAX_MS = 1200, DESIGN_TRANSITION_DEFAULT_MS = 300;
/** Videos previously faded every page in at 300ms; documents without a transition keep that shipped default. */
export const DESIGN_VIDEO_FALLBACK: DesignTransition = { type: "fade", durationMs: DESIGN_TRANSITION_DEFAULT_MS };
export function isValidDesignTransition(value: unknown): value is DesignTransition {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    DESIGN_TRANSITION_TYPES.includes((value as DesignTransition).type) &&
    Number.isInteger((value as DesignTransition).durationMs) &&
    (value as DesignTransition).durationMs >= DESIGN_TRANSITION_MIN_MS &&
    (value as DesignTransition).durationMs <= DESIGN_TRANSITION_MAX_MS;
}
/** Page as authored: absent transition means "unset", which each delivery surface resolves per its shipped default. */
export function resolvePageTransition(page: Pick<DesignPage, "transition">): DesignTransition | undefined {
  return page.transition && isValidDesignTransition(page.transition) ? page.transition : undefined;
}
/** Presentation and offline HTML only animate an explicit transition; unset pages switch instantly. */
export function presentTransition(page: Pick<DesignPage, "transition">): DesignTransition | undefined {
  const transition = resolvePageTransition(page);
  return transition && transition.type !== "none" ? transition : undefined;
}
export type SceneTransition = { in: "fade" | "slide-left" | "wipe" | "zoom-punch"; durationMs: number; overlapMs?: number };
/**
 * Video scenes always had an entrance; unset pages keep the shipped fade, explicit
 * none removes it. Explicit transitions cross-dissolve 500ms into the previous page
 * (S-03b): the timeline clamps overlap to 200ms clear of either neighbor, and unset
 * pages keep the legacy hard-cut-with-fade so accepted exports stay byte-stable.
 */
export function sceneTransitionFor(page: Pick<DesignPage, "transition">): SceneTransition | undefined {
  const explicit = resolvePageTransition(page);
  const transition = explicit ?? DESIGN_VIDEO_FALLBACK;
  const map: Record<DesignTransitionType, SceneTransition["in"] | undefined> = { none: undefined, fade: "fade", push: "slide-left", wipe: "wipe", zoom: "zoom-punch" };
  const type = map[transition.type];
  if (!type) return undefined;
  return { in: type, durationMs: transition.durationMs, ...(explicit ? { overlapMs: 500 } : {}) };
}
const EASE = "cubic-bezier(.45,0,.25,1)";
/** Keyframes live on wrapper elements: the incoming page sits on top of the frozen outgoing page. */
export function transitionInKeyframes(type: DesignTransitionType): string {
  switch (type) {
    case "fade": return `@keyframes glint-page-fade-in{from{opacity:0}to{opacity:1}}`;
    case "push": return `@keyframes glint-page-push-in{from{transform:translateX(100%)}to{transform:translateX(0)}}`;
    case "wipe": return `@keyframes glint-page-wipe-in{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}`;
    case "zoom": return `@keyframes glint-page-zoom-in{from{opacity:0;transform:scale(1.12)}to{opacity:1;transform:scale(1)}}`;
    default: return "";
  }
}
export function transitionOutKeyframes(type: DesignTransitionType): string {
  return type === "push" ? `@keyframes glint-page-push-out{from{transform:translateX(0)}to{transform:translateX(-100%)}}` : "";
}
export function transitionInStyle(type: DesignTransitionType, durationMs: number): string {
  const names: Record<DesignTransitionType, string> = { none: "", fade: "glint-page-fade-in", push: "glint-page-push-in", wipe: "glint-page-wipe-in", zoom: "glint-page-zoom-in" };
  return names[type] ? `animation:${names[type]} ${durationMs}ms ${EASE} both` : "";
}
export function transitionOutStyle(type: DesignTransitionType, durationMs: number): string {
  return type === "push" ? `animation:glint-page-push-out ${durationMs}ms ${EASE} both` : "";
}
export const transitionSheetCss = (type: DesignTransitionType) => `${transitionInKeyframes(type)}${transitionOutKeyframes(type)}`;
/** Slide XML for native PowerPoint/WPS switches; mc fallback keeps older readers on legacy speeds. */
const PPT_SPEED = (durationMs: number) => durationMs <= 500 ? "fast" : durationMs <= 1000 ? "med" : "slow";
const pptElement: Record<DesignTransitionType, string> = { none: "", fade: "<p:fade/>", push: '<p:push dir="l"/>', wipe: '<p:wipe dir="l"/>', zoom: '<p:zoom dir="in"/>' };
export function slideTransitionXml(transition: DesignTransition | undefined): string {
  if (!transition || transition.type === "none") return "";
  const inner = pptElement[transition.type];
  const legacy = `<p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" advClick="1" spd="${PPT_SPEED(transition.durationMs)}" p14:dur="${transition.durationMs}">${inner}</p:transition>`;
  return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">${legacy}</mc:Choice><mc:Fallback><p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" advClick="1" spd="${PPT_SPEED(transition.durationMs)}">${inner}</p:transition></mc:Fallback></mc:AlternateContent>`;
}
