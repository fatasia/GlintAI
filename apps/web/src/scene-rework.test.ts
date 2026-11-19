import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { sceneReworkContext, sceneReworkPrompt } from "./scene-rework";

const fixture = () => parseProject({ schemaVersion: 1, id: "story", title: "故事", aspect: "16:9", knowledgeSources: [], assets: [
  { id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝色外套", refs: ["assets/hero.png"] },
  { id: "other", kind: "location", name: "教室", version: "v1", description: "长桌" },
], scenes: [
  { id: "one", kind: "title", title: "开场", narration: { text: "第一句" }, assetRefs: [{ assetId: "hero", version: "v1" }] },
  { id: "two", kind: "title", title: "另一镜", narration: { text: "第二句" } },
] });
it("invalidates only target scene, aspect, or referenced identities", () => {
  const project = fixture(), snapshot = sceneReworkContext(project, "one");
  const otherScene = structuredClone(project); otherScene.scenes[1]!.narration.text = "新内容";
  expect(sceneReworkContext(otherScene, "one").basis).toBe(snapshot.basis);
  const otherAsset = structuredClone(project); otherAsset.assets![1]!.description = "新教室";
  expect(sceneReworkContext(otherAsset, "one").basis).toBe(snapshot.basis);
  const hero = structuredClone(project); hero.assets![0]!.description = "红色外套";
  expect(sceneReworkContext(hero, "one").basis).not.toBe(snapshot.basis);
  expect(sceneReworkContext({ ...project, aspect: "9:16" }, "one").basis).not.toBe(snapshot.basis);
});
it("adds only descriptive text and refuses oversized input", () => {
  const context = sceneReworkContext(fixture(), "one");
  expect(sceneReworkPrompt("走进房间", context)).toContain("蓝色外套");
  expect(sceneReworkPrompt("走进房间", context)).not.toContain("assets/hero.png");
  expect(() => sceneReworkPrompt("a".repeat(4000), context)).toThrow(/4000/);
});
