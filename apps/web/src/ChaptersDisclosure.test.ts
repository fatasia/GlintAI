// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChaptersDisclosure } from "./ChaptersDisclosure";
import { parseEditorProject } from "./editor-model";
import { CHAPTERS_KEY } from "./ChaptersStore";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
beforeEach(() => { vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } }); });
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("does not mount or read the manager until opened, and preserves a rename draft while closed", async () => {
  const project = parseEditorProject({ schemaVersion: 1, id: "one", title: "第一章", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "s", kind: "title", title: "镜头", narration: { text: "旁白" } }] });
  const context = { mode: "source" as const, text: "资料", template: "explainer", theme: "glint-dark", evidence: "资料" };
  const reads = vi.spyOn(Storage.prototype, "getItem"), node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node); dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(ChaptersDisclosure, { project, context, onOpen: () => true })));
  expect(node.querySelector(".chapters-body")).toBeNull(); expect(reads).not.toHaveBeenCalled();
  const details = node.querySelector<HTMLDetailsElement>('[aria-label="章节管理"]')!;
  await act(async () => { details.open = true; await new Promise(resolve => setTimeout(resolve, 0)); });
  // Wait for the actual lazy module, rather than assuming it loads within 100 ms.
  await act(async () => { await import("./ChaptersPanel"); });
  expect(reads.mock.calls.some(([key]) => key === CHAPTERS_KEY)).toBe(true);
  const button = (label: string) => [...node.querySelectorAll("button")].find(item => item.textContent === label)!;
  await act(async () => button("将当前工程加入章节").click()); await act(async () => button("重命名").click());
  const input = node.querySelector<HTMLInputElement>('[aria-label="章节新名称"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "未提交的新名称"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const body = node.querySelector(".chapters-body");
  await act(async () => { details.open = false; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(node.querySelector(".chapters-body")).toBe(body);
  await act(async () => { details.open = true; await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(node.querySelector<HTMLInputElement>('[aria-label="章节新名称"]')!.value).toBe("未提交的新名称"); expect(details.querySelector(".chapters-count")!.textContent).toBe("1 章");
});
