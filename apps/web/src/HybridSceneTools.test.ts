// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { HybridSceneTools } from "./HybridSceneTools";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
it("adds independent object animation through the existing project change callback", async () => {
  const project = SceneScriptProject.parse({ schemaVersion: 1, id: "hybrid", title: "作品", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "shot", kind: "video", src: "assets/a.mp4", narration: { text: "画面", durationMs: 3000 } }] });
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node); cleanup = () => act(() => root.unmount());
  const onChange = vi.fn(), onInspect = vi.fn(), onSelect = vi.fn();
  await act(async () => root.render(createElement(HybridSceneTools, { project, sceneId: "shot", onChange, onInspect, onSelect })));
  const click = async (text: string) => act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  await click("叠加文字动画"); expect(onChange).toHaveBeenCalledOnce(); expect(onInspect).toHaveBeenLastCalledWith("visual");
  expect(onChange.mock.calls[0]![0].scenes[0]).toMatchObject({ kind: "video", src: "assets/a.mp4", elements: [{ kind: "text", text: "在这里写标题" }] });
  await click("添加生成画面"); expect(onInspect).toHaveBeenLastCalledWith("generate"); expect(onChange).toHaveBeenCalledOnce();
  await click("添加动态图形"); expect(onChange.mock.calls[1]![0].scenes).toHaveLength(2); expect(onSelect).toHaveBeenCalledOnce();
});
