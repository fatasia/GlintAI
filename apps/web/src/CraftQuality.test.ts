// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { CraftQuality } from "./CraftQuality";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
const project = parseProject({
  schemaVersion: 1, id: "quality", title: "Quality", aspect: "16:9", knowledgeSources: [],
  scenes: [
    { id: "open", kind: "title", title: "开场", narration: { text: "先用一个问题开场。" } },
    { id: "end", kind: "title", title: "结束", narration: { text: "最后停在一张字卡上。" } },
  ],
});
async function mount(onSelectScene = vi.fn()) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(CraftQuality, { project, onSelectScene })));
  return { div, onSelectScene };
}
it("surfaces storyboard issues and jumps to the affected scene", async () => {
  const { div, onSelectScene } = await mount();
  expect(div.textContent).toContain("建议调整");
  expect(div.textContent).toContain("结尾落在字卡上");
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent?.includes("结尾落在字卡上"))!.click());
  expect(onSelectScene).toHaveBeenCalledWith("end");
});
it("reports a clean structure without inventing issues", async () => {
  const clean = parseProject({ ...project, scenes: [
    { id: "a", kind: "title", title: "开场", narration: { text: "这是第一镜的具体内容。" } },
    { id: "b", kind: "bullets", title: "要点", items: ["第一点", "第二点"], narration: { text: "第二镜解释两个关键要点。" } },
  ] });
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(CraftQuality, { project: clean, onSelectScene: () => {} })));
  expect(div.textContent).toContain("结构可用");
  expect(div.textContent).toContain("没有结构问题");
});
