// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HomeHero } from "./HomeHero";
import type { SavedProject } from "./project-history";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(projects: SavedProject[] = [], disabled = false) {
  await import("./ProjectComposer");
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ configured: false }))));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  Element.prototype.scrollIntoView = vi.fn();
  const onOpen = vi.fn(), onOpenReference = vi.fn(), onOpenPlan = vi.fn(), onOpenTemplates = vi.fn(), onOpenProject = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(HomeHero, { projects, onOpen, onOpenReference, onOpenPlan, onOpenTemplates, onOpenProject, disabled })));
  const click = async (label: string) => act(async () => {
    [...div.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label)!.click();
  });
  return { div, click, onOpen, onOpenReference, onOpenPlan, onOpenTemplates, onOpenProject };
}
it("loads a real preset without submitting and preserves the draft across modes", async () => {
  const view = await mount();
  await view.click("使用产品发布起点");
  const area = view.div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
  expect(area.value).toContain("竖屏发布视频");
  expect(view.div.textContent).toContain("已载入「产品发布」");
  await view.click("GIF 导出");
  expect(area.closest('[hidden]')).not.toBeNull();
  await view.click("视频创作");
  expect(view.div.querySelector('[aria-label="快速成片资料"]')).toBe(area);
  expect(area.value).toContain("竖屏发布视频");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/make")).toBe(false);
});
it("asks before replacing a nonempty draft and respects cancellation", async () => {
  const view = await mount();
  await view.click("使用产品发布起点");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await view.click("使用操作教程起点");
  expect(confirm).toHaveBeenCalledOnce();
  expect(view.div.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain("竖屏发布视频");
});
it("opens saved projects and searches them without deleting data", async () => {
  const project: SavedProject = { id: "a", name: "咖啡新品", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "9:16", updatedAt: 1 };
  const view = await mount([project]);
  await act(async () => view.div.querySelector<HTMLButtonElement>(".home-project")!.click());
  expect(view.onOpen).toHaveBeenCalledWith(project);
  await act(async () => {
    const input = view.div.querySelector<HTMLInputElement>('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "不存在");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(view.div.textContent).toContain("没有匹配的作品");
  await view.click("清空搜索");
  expect(view.div.textContent).toContain("咖啡新品");
});
it("opens the four secondary entries without generating or clearing the draft", async () => {
  const view = await mount();
  await view.click("使用产品发布起点");
  const area = view.div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
  const draft = area.value;
  await view.click("先看方案"); await view.click("浏览模板"); await view.click("从参考片开始"); await view.click("打开工程");
  expect(view.onOpenPlan).toHaveBeenCalledOnce(); expect(view.onOpenTemplates).toHaveBeenCalledOnce();
  expect(view.onOpenReference).toHaveBeenCalledOnce(); expect(view.onOpenProject).toHaveBeenCalledOnce();
  expect(area.value).toBe(draft);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/make")).toBe(false);
  expect(view.div.querySelector('[aria-label="创作流程"]')).toBeNull();
  expect(view.div.querySelectorAll(".home-starter-cover img")).toHaveLength(4);
  expect(view.div.querySelector('[aria-label="创作起点"]')!.compareDocumentPosition(view.div.querySelector('[aria-label="最近作品"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("disables starter and reference actions while the parent is busy", async () => {
  const view = await mount([], true);
  await view.click("使用产品发布起点");
  await view.click("从参考片开始");
  expect(view.onOpenReference).not.toHaveBeenCalled();
  expect(view.div.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
});

it("offers two equal starting points and switches without losing the motion draft or submitting media", async () => {
  const view = await mount();
  expect(view.div.querySelectorAll('[aria-label="视频创作起点"] [aria-pressed="true"]')).toHaveLength(0);
  await view.click("使用知识讲解起点");
  const area = view.div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!, draft = area.value;
  const choose = async (text: string) => act(async () => {
    const choice = [...view.div.querySelectorAll<HTMLButtonElement>('[aria-label="视频创作起点"] button')].find(item => item.textContent?.startsWith(text))!;
    choice.click(); await new Promise(resolve => setTimeout(resolve, 0));
  });
  await choose("影像创作"); expect(area.closest('[hidden]')).not.toBeNull();
  await choose("动态图形"); expect(area.value).toBe(draft); expect(area.closest('[hidden]')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
