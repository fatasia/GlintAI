// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerProjectList } from "./ContainerProjectList";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const row = (id: string) => ({ projectId: id, title: `标题 ${id}`, revision: 4, sceneCount: 2, timelineCount: 1, firstDocumentId: "object-scene" });
async function mount() {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host), onOpen = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(ContainerProjectList, { onOpen })); await tick(); });
  return { host, onOpen };
}
async function click(host: HTMLElement, label: string) {
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click(); await tick(); });
}
it("only opens explicitly and pages forward/back without polling or storing projects", async () => {
  const network = vi.fn(async (url: string) => Response.json(url.includes("cursor=") ? { projects: [row("work-b")], nextCursor: null } : { projects: [row("work-a")], nextCursor: "work-a" }));
  vi.stubGlobal("fetch", network); const { host, onOpen } = await mount();
  expect(onOpen).not.toHaveBeenCalled(); expect(host.textContent).toContain("分镜文档 2 · 剪辑文档 1 · r4");
  await click(host, "打开作品"); expect(onOpen).toHaveBeenCalledWith("work-a", "object-scene");
  await click(host, "下一页"); expect(host.textContent).toContain("标题 work-b"); expect(host.textContent).not.toContain("标题 work-a");
  await click(host, "上一页"); expect(host.textContent).toContain("标题 work-a"); expect(network).toHaveBeenCalledTimes(3);
  expect(localStorage.length).toBe(0);
});
it("reports errors, retries manually and describes only readable emptiness", async () => {
  const network = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 500 })).mockResolvedValueOnce(Response.json({ projects: [], nextCursor: null }));
  vi.stubGlobal("fetch", network); const { host } = await mount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("读取失败"); expect(network).toHaveBeenCalledTimes(1);
  await click(host, "重试列表"); expect(host.textContent).toContain("暂无可读取的作品"); expect(network).toHaveBeenCalledTimes(2);
});
it("aborts on unmount and ignores late data without auto-opening", async () => {
  let release!: (response: Response) => void;
  const network = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", network); const { host, onOpen } = await mount();
  expect(host.textContent).toContain("正在读取作品列表"); const signal = network.mock.calls[0]![1]!.signal!;
  dispose(); dispose = () => {}; expect(signal.aborted).toBe(true);
  await act(async () => { release(Response.json({ projects: [row("work-a")], nextCursor: null })); await tick(); });
  expect(host.textContent).toBe(""); expect(onOpen).not.toHaveBeenCalled(); expect(network).toHaveBeenCalledTimes(1);
});
