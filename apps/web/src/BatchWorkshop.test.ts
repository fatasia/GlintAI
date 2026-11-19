// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BatchWorkshop, composeRowProject } from "./BatchWorkshop";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let unmount = () => {};
afterEach(() => { unmount(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as Response;
const button = (node: HTMLElement, label: string) => [...node.querySelectorAll("button")].find(item => item.textContent?.includes(label))!;
async function click(element: HTMLElement) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }
async function setup(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  const node = document.createElement("div"); document.body.appendChild(node);
  const root = createRoot(node); unmount = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(BatchWorkshop)); await Promise.resolve(); await Promise.resolve(); });
  return node;
}
async function setTable(node: HTMLElement, value: string) {
  const input = node.querySelector<HTMLTextAreaElement>('[aria-label="商品表格"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("项目只引用真实输入素材，不凭空构造路径", () => {
  expect(() => composeRowProject({ id: "one", name: "样例", sellingPoints: ["卖点"], assets: [], assetPrompt: "" })).toThrow();
  const project = composeRowProject({ id: "one", name: "样例", sellingPoints: ["卖点"], assets: ["clip.mp4", "photo.png"], assetPrompt: "" });
  expect(project.scenes.map(scene => "src" in scene ? scene.src : "")).toEqual(["assets/clip.mp4", "assets/photo.png", "assets/clip.mp4"]);
});

it("校验真实素材、允许编辑工程并提交服务端 MP4 渲染", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (url === "/api/media/library") return response({ assets: [{ name: "clip.mp4" }, { name: "photo.png" }] });
    if (url === "/api/make" && init?.method === "POST") return response({ jobId: "idea-test-1" });
    if (url === "/api/make/idea-test-1") return response({ id: "idea-test-1", status: "done", log: [] });
    throw new Error(`unexpected ${url}`);
  });
  const node = await setup(fetcher as typeof fetch);
  await setTable(node, "id,商品名,卖点,素材\none,咖啡,醇香,clip.mp4|photo.png\ntwo,茶,清香,missing.png");
  await click(button(node, "校验并创建工程"));
  expect(node.textContent).toContain("素材不存在：missing.png");
  expect(node.querySelectorAll('[aria-label="工程清单"] section')).toHaveLength(1);
  const editor = node.querySelector<HTMLTextAreaElement>('[aria-label="工程 one"]')!;
  const documentValue = JSON.parse(editor.value); documentValue.title = "已编辑";
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, JSON.stringify(documentValue)); editor.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(button(node, "渲染待处理"));
  const post = fetcher.mock.calls.find(([url]) => url === "/api/make")!;
  const body = JSON.parse(post[1]!.body as string);
  expect(body.project.title).toBe("已编辑"); expect(body.tts).toBe("mock"); expect(body.requestId).toBeTruthy();
  expect(localStorage.getItem("glint.batch-workshop.v1")).toContain(body.requestId);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(node.textContent).toContain("视频已完成");
  expect(node.querySelector('a[download]')?.getAttribute("href")).toBe("/api/video/idea-test-1?download=1");
});

it("提交结果不明时保留请求 ID、禁止重提并可查询恢复", async () => {
  let lookup = false;
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (url === "/api/media/library") return response({ assets: [{ name: "clip.mp4" }] });
    if (url === "/api/make") throw new Error("network lost");
    if (String(url).startsWith("/api/make/request/")) { lookup = true; return response({ id: "idea-restored", status: "done", log: [] }); }
    throw new Error("unexpected");
  });
  const node = await setup(fetcher as typeof fetch);
  await setTable(node, "id,商品名,卖点,素材\none,咖啡,醇香,clip.mp4");
  await click(button(node, "校验并创建工程"));
  await click(button(node, "渲染待处理"));
  expect(node.textContent).toContain("状态待确认");
  expect(button(node, "渲染待处理").disabled).toBe(true);
  await click(button(node, "恢复任务查询"));
  expect(lookup).toBe(true); expect(node.textContent).toContain("视频已完成");
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/make")).toHaveLength(1);
});

it("付费配音必须针对当前工程确认；修改工程后确认失效", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (url === "/api/media/library") return response({ assets: [{ name: "clip.mp4" }] });
    if (url === "/api/health") return response({ voices: ["mock", "gateway"] });
    throw new Error("unexpected");
  });
  const node = await setup(fetcher as typeof fetch);
  await setTable(node, "id,商品名,卖点,素材\none,咖啡,醇香,clip.mp4");
  await click(button(node, "校验并创建工程"));
  const picker = node.querySelector<HTMLSelectElement>('[aria-label="批量配音"]')!;
  await act(async () => { picker.value = "gateway"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  await click(button(node, "渲染待处理"));
  expect(node.textContent).toContain("请先确认本批次费用");
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/make")).toHaveLength(0);
  const checkbox = node.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await click(checkbox); expect(checkbox.checked).toBe(true);
  const editor = node.querySelector<HTMLTextAreaElement>('[aria-label="工程 one"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, editor.value + " "); editor.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(checkbox.checked).toBe(false);
});
