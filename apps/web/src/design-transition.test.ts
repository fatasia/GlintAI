import { describe, expect, it } from "vitest";
import { DESIGN_TRANSITION_MAX_MS, DESIGN_TRANSITION_MIN_MS, isValidDesignTransition, presentTransition, sceneTransitionFor, slideTransitionXml, transitionSheetCss } from "./design-transition";
import { validateDesignDocuments, type DesignPage } from "./design-artifacts";

const state = (pages: object[]) => ({ version: 1, projectId: "p", activeId: "d", documents: [{ id: "d", title: "稿", kind: "slides", activePageId: "a", updatedAt: 0, pages }] });
const page = (extra: Partial<DesignPage> = {}): DesignPage => ({ id: "a", title: "页", html: "<p>内容</p>", ...extra });

describe("transition validation", () => {
  it("accepts documents without transition fields (backward compatible)", () => {
    expect(() => validateDesignDocuments(state([page()]), "p")).not.toThrow();
    expect(() => validateDesignDocuments(state([page({ transition: undefined, stepReveal: undefined })]), "p")).not.toThrow();
  });
  it("accepts valid transition and stepReveal values", () => {
    expect(() => validateDesignDocuments(state([page({ transition: { type: "fade", durationMs: 500 }, stepReveal: true })]), "p")).not.toThrow();
    for (const type of ["none", "fade", "push", "wipe", "zoom"] as const)
      expect(isValidDesignTransition({ type, durationMs: 300 })).toBe(true);
  });
  it("rejects unknown types and out-of-range durations", () => {
    expect(isValidDesignTransition({ type: "dissolve", durationMs: 300 } as never)).toBe(false);
    expect(isValidDesignTransition({ type: "fade", durationMs: DESIGN_TRANSITION_MIN_MS - 1 })).toBe(false);
    expect(isValidDesignTransition({ type: "fade", durationMs: DESIGN_TRANSITION_MAX_MS + 1 })).toBe(false);
    expect(isValidDesignTransition({ type: "fade", durationMs: 300.5 })).toBe(false);
    expect(() => validateDesignDocuments(state([page({ transition: { type: "dissolve", durationMs: 300 } as never })]), "p")).toThrow(/无法识别|设计文档/);
    expect(() => validateDesignDocuments(state([page({ transition: { type: "fade", durationMs: 50 } })]), "p")).toThrow();
    expect(() => validateDesignDocuments(state([page({ stepReveal: "yes" as never })]), "p")).toThrow();
  });
});

describe("delivery mapping", () => {
  it("presentation: absent or none means no transition; explicit types play", () => {
    expect(presentTransition(page())).toBeUndefined();
    expect(presentTransition(page({ transition: { type: "none", durationMs: 300 } }))).toBeUndefined();
    expect(presentTransition(page({ transition: { type: "wipe", durationMs: 800 } }))).toEqual({ type: "wipe", durationMs: 800 });
  });
  it("video: absent keeps the shipped fade default; none removes; types map to scenescript", () => {
    expect(sceneTransitionFor(page())).toEqual({ in: "fade", durationMs: 300 });
    expect(sceneTransitionFor(page({ transition: { type: "none", durationMs: 300 } }))).toBeUndefined();
    expect(sceneTransitionFor(page({ transition: { type: "push", durationMs: 600 } }))).toEqual({ in: "slide-left", durationMs: 600 });
    expect(sceneTransitionFor(page({ transition: { type: "zoom", durationMs: 400 } }))).toEqual({ in: "zoom-punch", durationMs: 400 });
    expect(sceneTransitionFor(page({ transition: { type: "wipe", durationMs: 1200 } }))).toEqual({ in: "wipe", durationMs: 1200 });
  });
});

describe("pptx slide transition xml", () => {
  it("is empty without an explicit transition", () => {
    expect(slideTransitionXml(undefined)).toBe("");
    expect(slideTransitionXml({ type: "none", durationMs: 300 })).toBe("");
  });
  it("writes mc:AlternateContent with p14 duration and a legacy fallback", () => {
    const xml = slideTransitionXml({ type: "fade", durationMs: 800 });
    expect(xml).toContain('<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">');
    expect(xml).toContain('p14:dur="800"');
    expect(xml).toContain('<p:fade/>');
    expect(xml).toContain('<mc:Fallback>');
    expect(xml).toContain('spd="med"');
  });
  it("maps element per type and speed per duration", () => {
    expect(slideTransitionXml({ type: "push", durationMs: 300 })).toContain('<p:push dir="l"/>');
    expect(slideTransitionXml({ type: "wipe", durationMs: 1200 })).toContain('<p:wipe dir="l"/>');
    expect(slideTransitionXml({ type: "zoom", durationMs: 600 })).toContain('<p:zoom dir="in"/>');
    expect(slideTransitionXml({ type: "fade", durationMs: 1200 })).toContain('spd="slow"');
    expect(slideTransitionXml({ type: "fade", durationMs: 200 })).toContain('spd="fast"');
  });
});

describe("editor keyframe sheet", () => {
  it("defines the in/out keyframes the player animates with, empty for none", () => {
    expect(transitionSheetCss("none")).toBe("");
    expect(transitionSheetCss("fade")).toContain("@keyframes glint-page-fade-in{from{opacity:0}to{opacity:1}}");
    expect(transitionSheetCss("push")).toContain("@keyframes glint-page-push-in");
    expect(transitionSheetCss("push")).toContain("@keyframes glint-page-push-out{from{transform:translateX(0)}to{transform:translateX(-100%)}}");
    expect(transitionSheetCss("wipe")).toContain("@keyframes glint-page-wipe-in{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}");
    expect(transitionSheetCss("zoom")).toContain("@keyframes glint-page-zoom-in");
    expect(transitionSheetCss("fade")).not.toContain("push");
  });
});
