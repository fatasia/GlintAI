import { expect, it } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { adoptLibraryVisual } from "./media-adoption";
import { addMotionScene, addAnimatedLabel } from "./hybrid-scene-model";

const project = () => SceneScriptProject.parse({ schemaVersion: 1, id: "hybrid", title: "混合", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "video", kind: "video", src: "assets/a.mp4", narration: { text: "画面", durationMs: 4000 } }] });
it("combines video, editable labels and a motion-graphics shot without flattening pixels", () => {
  const input = project(), labelled = addAnimatedLabel(input, "video", "label-1", "新品"), mixed = addMotionScene(labelled, "motion-1", "数据说明");
  expect(input.scenes[0]!.elements).toBeUndefined(); expect(mixed.scenes.map(scene => scene.kind)).toEqual(["video", "title"]);
  expect(mixed.scenes[0]!.elements?.[0]).toMatchObject({ id: "label-1", kind: "text", text: "新品" });
  expect(mixed.scenes[0]!.tracks?.[0]).toMatchObject({ elementId: "label-1", property: "opacity", keyframes: [{ atMs: 0, value: 0 }, { atMs: 400, value: 1 }] });
});
it("replacing generated footage keeps the text and animation independently editable", () => {
  const labelled = addAnimatedLabel(project(), "video", "label-1", "价格 ¥39");
  const replaced = adoptLibraryVisual(labelled, "video", "b.mp4", "replace");
  expect(replaced.scenes[0]!.elements).toEqual(labelled.scenes[0]!.elements); expect(replaced.scenes[0]!.tracks).toEqual(labelled.scenes[0]!.tracks);
  expect(replaced.scenes[0]).toMatchObject({ id: "video", src: "assets/b.mp4" });
});
it("refuses edits to a locked or frozen project and duplicate identities", () => {
  const frozen = { ...project(), frozen: true }; expect(() => addMotionScene(frozen, "motion-1", "标题")).toThrow();
  const locked = project(); locked.scenes[0]!.locked = true; expect(() => addAnimatedLabel(locked, "video", "label-1", "标题")).toThrow();
  expect(() => addMotionScene(project(), "video", "标题")).toThrow();
});
