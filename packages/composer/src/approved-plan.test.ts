import { expect, it, vi } from "vitest";
import { MockLlmProvider } from "@glintai/llm";
import { buildTimeline, evaluateElements, parseProject } from "@glintai/scenescript";
import { resolveTheme } from "@glintai/design-tokens";
import { composeWithLlm } from "./llm";
import { cameraForMotion, layoutElements } from "./visual-plan";
import { VideoPlan } from "./plan";
const plan = VideoPlan.parse({ title: "产品发布", hook: "先看产品", audience: "设计师", platform: "9:16", theme: "bold-poster", totalSeconds: 6, takeaway: "体验产品", scenes: [
  { goal: "卖点", narration: "只保留确认的旁白。", visual: "三个文字块依次出现", seconds: 2.5, kind: "bullets" },
  { goal: "落版", narration: "现在开始。", visual: "产品名称居中", seconds: 3.5, kind: "title" },
] });
const reply = { schemaVersion: 1, id: "draft", title: "错误标题", aspect: "16:9", scenes: [
  { id: "benefits", kind: "bullets", items: ["可编辑"], narration: { text: "模型改写了旁白", durationMs: 9999 }, transition: { in: "fade", overlapMs: 500 } },
  { id: "close", kind: "title", title: "产品", narration: { text: "模型结尾" } },
] };
it("preserves approved kinds, exact narration, timing, visual intent and aspect through serialization", async () => {
  const handler = vi.fn((_request: { system?: string }) => JSON.stringify(reply));
  const project = await composeWithLlm("ignored", new MockLlmProvider(handler), { projectId: "plan-test" }, { approvedPlan: plan });
  expect(project.id).toBe("plan-test"); expect(project.title).toBe(plan.title); expect(project.aspect).toBe("9:16");
  expect(project.scenes.map(scene => scene.kind)).toEqual(["bullets", "title"]);
  expect(project.scenes[0]!.narration).toMatchObject({ text: plan.scenes[0]!.narration, durationMs: 2500 });
  expect(project.scenes[0]!.notes).toContain(plan.scenes[0]!.visual);
  expect(buildTimeline(parseProject(JSON.parse(JSON.stringify(project)))).totalMs).toBe(6000);
  // CREATE-08: the planned camera move lands on the generated scenes.
  expect(project.scenes[0]).toMatchObject({ camera: { type: "push", intensity: 0.5 } });
  expect(project.scenes[1]).toMatchObject({ camera: { type: "pull", intensity: 0.5 } });
  // CREATE-08: the derived layout lands as editable scene elements. Scene 1 is
  // bullets → grid-2 (one divider); the closing title is center-stack (none).
  expect(project.scenes[0]!.elements).toEqual([
    { id: "layout-anchor-1", kind: "rect", x: 0.5, y: 0.5, w: 0.004, h: 0.84, fill: resolveTheme("bold-poster").colors.border },
  ]);
  expect(project.scenes[1]!.elements).toBeUndefined();
  // Render contract: both backends sample the same element layer.
  const sampled = evaluateElements({ elements: project.scenes[0]!.elements, tracks: undefined }, 0);
  expect(sampled.map(state => state.x)).toEqual([0.5]);
  expect(handler.mock.calls[0]![0].system).toContain("Approved storyboard overrides");
});
it("repairs dropped scenes instead of silently accepting a truncated film", async () => {
  const handler = vi.fn().mockReturnValueOnce(JSON.stringify({ ...reply, scenes: reply.scenes.slice(0, 1) })).mockReturnValue(JSON.stringify(reply));
  await composeWithLlm("ignored", new MockLlmProvider(handler), {}, { approvedPlan: plan });
  expect(handler).toHaveBeenCalledTimes(2);
});
it("rejects kind substitution after the bounded repair attempt", async () => {
  const handler = vi.fn(() => JSON.stringify({ ...reply, scenes: [reply.scenes[1], reply.scenes[0]] }));
  await expect(composeWithLlm("ignored", new MockLlmProvider(handler), {}, { approvedPlan: plan })).rejects.toThrow(/approved kind/);
  expect(handler).toHaveBeenCalledTimes(2);
});
it("rejects missing image material and invalid timing before calling a model", async () => {
  const handler = vi.fn();
  await expect(composeWithLlm("ignored", new MockLlmProvider(handler), {}, { approvedPlan: { ...plan, scenes: [{ ...plan.scenes[0]!, kind: "image" }] } })).rejects.toThrow(/真实素材/);
  await expect(composeWithLlm("ignored", new MockLlmProvider(handler), {}, { approvedPlan: { ...plan, scenes: [{ ...plan.scenes[0]!, seconds: 0 }] } })).rejects.toThrow();
  expect(handler).not.toHaveBeenCalled();
});

it("maps planned motions to whole-scene camera moves", () => {
  expect(cameraForMotion("zoom-in")).toEqual({ type: "push", intensity: 0.5 });
  expect(cameraForMotion("zoom-out")).toEqual({ type: "pull", intensity: 0.5 });
  expect(cameraForMotion("pan-left")).toEqual({ type: "pan-left", intensity: 0.5 });
  expect(cameraForMotion("reveal")).toEqual({ type: "drift", intensity: 0.35 });
  expect(cameraForMotion("static")).toBeUndefined();
});

it("lands planned layout and relation as renderer-visible elements", async () => {
  // CREATE-08: layout/relation reach the render structure, not just badges.
  const gridded = VideoPlan.parse({ ...plan, theme: "mint-clean", scenes: [
    { ...plan.scenes[0]!, layout: "grid-3", relation: "flow" },
    plan.scenes[1]!,
  ] });
  const project = await composeWithLlm("ignored", new MockLlmProvider(() => JSON.stringify(reply)), { projectId: "layout-test" }, { approvedPlan: gridded });
  const tokens = resolveTheme("mint-clean");
  const elements = project.scenes[0]!.elements ?? [];
  expect(elements).toEqual([
    { id: "layout-anchor-1", kind: "rect", x: 1 / 3, y: 0.5, w: 0.004, h: 0.84, fill: tokens.colors.border },
    { id: "layout-anchor-2", kind: "rect", x: 2 / 3, y: 0.5, w: 0.004, h: 0.84, fill: tokens.colors.border },
    { id: "relation-baseline", kind: "rect", x: 0.5, y: 0.905, w: 0.72, h: 0.004, fill: tokens.colors.accent },
  ]);
  // The user's explicit fields win over the derivation and reach the render.
  expect(project.scenes[1]!.elements).toBeUndefined();
  const staged = evaluateElements({ elements, tracks: undefined }, 1200);
  expect(staged.map(state => state.x)).toEqual([1 / 3, 2 / 3, 0.5]);
  // Unknown theme strings degrade to neutral anchors instead of failing compose.
  expect(layoutElements("grid-2", "none", "not-a-theme")).toEqual([
    { id: "layout-anchor-1", kind: "rect", x: 0.5, y: 0.5, w: 0.004, h: 0.84, fill: "#3f3f46" },
  ]);
  // compare keeps a divider even on a full-layout shot.
  expect(layoutElements("full", "compare", "glint-dark")).toHaveLength(1);
});
