import { expect, it } from "vitest";
import { changeNarration, moveScene, parseEditorProject } from "./editor-model";
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
it("rejects imported script or external media projects", () => {
  const original = project();
  expect(() => parseEditorProject({ ...original, scenes: [{ id: "x", kind: "html", html: "<script>bad()</script>", narration: { text: "x" } }] })).toThrow(/文字场景/);
  expect(() => parseEditorProject({ ...original, scenes: Array.from({ length: 31 }, (_, index) => ({ ...original.scenes[0], id: `s-${index}` })) })).toThrow(/30/);
});
it("rejects whitespace-only narration instead of crashing the timeline", () => {
  const original = project();
  expect(changeNarration(original, 0, "   ")).toBe(original);
  original.scenes[0]!.narration.text = "   ";
  expect(() => parseEditorProject(original)).toThrow(/非空旁白/);
});
