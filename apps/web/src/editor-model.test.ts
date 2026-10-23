import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { canDeleteScene, canMoveScene, changeNarration, duplicateScene, moveScene, parseEditorProject, reorderScenes } from "./editor-model";
const project = () => parseEditorProject({ schemaVersion: 1, id: "edit", title: "Title", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "a", kind: "title", title: "A", narration: { text: "Old", durationMs: 9999, segments: [{ text: "Old" }] } },
  { id: "b", kind: "bullets", items: ["B"], narration: { text: "New" } },
] });
it("invalidates audio duration/word timings on narration changes without mutating history", () => {
  const original = project(), updated = changeNarration(original, 0, "Changed");
  expect(updated.scenes[0]?.narration).toEqual({ text: "Changed" });
  expect(original.scenes[0]?.narration.durationMs).toBe(9999);
});
it("moves scenes immutably and ignores out-of-range movement", () => {
  const original = project();
  expect(moveScene(original, 0, 1).scenes.map(scene => scene.id)).toEqual(["b", "a"]);
  expect(original.scenes[0]?.id).toBe("a");
  expect(moveScene(original, 0, -1)).toEqual(original);
});
it("preserves the selected speaker and speed when editing narration", () => {
  const original = project(); original.scenes[0]!.narration.voice = "speaker-a"; original.scenes[0]!.narration.speakingRate = 1.1;
  expect(changeNarration(original, 0, "New words").scenes[0]!.narration).toEqual({ text: "New words", voice: "speaker-a", speakingRate: 1.1 });
});
it("rejects imported script or external media projects", () => {
  const original = project();
  expect(() => parseEditorProject({ ...original, scenes: [{ id: "x", kind: "html", html: "<script>bad()</script>", narration: { text: "x" } }] })).toThrow(/素材库/);
  expect(() => parseEditorProject({ ...original, scenes: Array.from({ length: 31 }, (_, index) => ({ ...original.scenes[0], id: `s-${index}` })) })).toThrow(/30/);
});
it("respects locked positions in both move and delete capability checks", () => {
  const original = project(); original.scenes[1]!.locked = true;
  expect(canMoveScene(original, 0, 1)).toBe(false);
  expect(moveScene(original, 0, 1)).toBe(original);
  expect(canDeleteScene(original, "a")).toBe(false);
  expect(canDeleteScene(original, "b")).toBe(false);
  expect(canMoveScene(original, -1, 1)).toBe(false);
});
it("rejects whitespace-only narration instead of crashing the timeline", () => {
  const original = project();
  expect(changeNarration(original, 0, "   ")).toBe(original);
  original.scenes[0]!.narration.text = "   ";
  expect(() => parseEditorProject(original)).toThrow(/非空旁白/);
});describe("scene duplicate and drag reorder", () => {
  it("duplicates right after the source with a new id and independent content", () => {
    const project = parseProject({ schemaVersion: 1, id: "dup", title: "Dup", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "one", kind: "title", title: "One", narration: { text: "一", durationMs: 1000 }, effects: [{ id: "e", kind: "grayscale", value: 1 }] },
      { id: "two", kind: "title", title: "Two", narration: { text: "二", durationMs: 1000 } },
    ] });
    const next = duplicateScene(project, 0, "copy-one");
    expect(next.scenes.map(scene => scene.id)).toEqual(["one", "copy-one", "two"]);
    expect(next.scenes[1]).toMatchObject({ title: "One", narration: { text: "一" } });
    next.scenes[1]!.narration.text = "改副本";
    expect(next.scenes[0]!.narration.text).toBe("一");
    expect(next.scenes[1]!.effects).toHaveLength(1);
    expect(() => duplicateScene({ ...project, scenes: [{ ...project.scenes[0]!, locked: true }] }, 0, "x")).toThrow(/解锁/);
  });
  it("moves scenes by drag and refuses locked layouts", () => {
    const project = parseProject({ schemaVersion: 1, id: "order", title: "Order", aspect: "16:9", knowledgeSources: [], scenes: ["a", "b", "c"].map(id => ({ id, kind: "title", title: id, narration: { text: id, durationMs: 1000 } })) });
    expect(reorderScenes(project, 0, 2).scenes.map(scene => scene.id)).toEqual(["b", "c", "a"]);
    expect(reorderScenes(project, 2, 0).scenes.map(scene => scene.id)).toEqual(["c", "a", "b"]);
    const locked = { ...project, scenes: project.scenes.map((scene: typeof project.scenes[number], index: number) => index === 1 ? { ...scene, locked: true } : scene) };
    expect(() => reorderScenes(locked, 0, 2)).toThrow(/锁定/);
    expect(reorderScenes(project, 0, 0)).toBe(project);
  });
});