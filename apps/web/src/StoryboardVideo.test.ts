// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StoryboardVideo } from "./StoryboardVideo";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); });
async function mount(identity: string, disabled = false) {
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node), onSelect = vi.fn();
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StoryboardVideo, { identity, disabled, prompt: "茶馆内，老陈倒茶。", onSelect })));
  return { node, onSelect };
}
async function open(node: HTMLElement) {
  await act(async () => { node.querySelector("button")!.click(); });
  await act(async () => { await import("./MediaWorkshop"); });
}
it("prefills one shot without paid calls, and explicitly binds a library video only", async () => {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("/library") ? { assets: [{ name: "tea.mp4", url: "/api/media/assets/tea.mp4", bytes: 100 }] } : url.includes("/models") ? { models: [{ id: "video", name: "Video" }], protocol: "skills" } : { versions: [] })); vi.stubGlobal("fetch", fetch);
  const { node, onSelect } = await mount("work:shot-1"); expect(fetch).not.toHaveBeenCalled();
  await open(node);
  expect(node.querySelector<HTMLTextAreaElement>('[aria-label="素材描述"]')!.value).toBe("茶馆内，老陈倒茶。");
  expect(node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(onSelect).not.toHaveBeenCalled();
  const use = [...node.querySelectorAll("button")].find(button => button.textContent === "tea.mp4")!;
  await act(async () => use.click()); expect(onSelect).toHaveBeenCalledOnce(); expect(onSelect).toHaveBeenCalledWith("tea.mp4");
  expect(node.querySelector('[aria-label="素材工坊"]')).toBeNull();
});
it("recovers only this shot's receipt with GET and leaves unrelated receipts untouched", async () => {
  localStorage.setItem("glint.media-task", JSON.stringify({ taskId: "home-job" }));
  localStorage.setItem("glint.storyboard-task.v1:work:shot-1", JSON.stringify({ taskId: "shot-job" }));
  localStorage.setItem("glint.storyboard-task.v1:work:shot-2", JSON.stringify({ taskId: "other-job" }));
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.includes("/status/") ? { taskId: "shot-job", isFinal: true, state: "success", assetUrl: "/api/media/assets/shot.mp4" } : url.includes("/models") ? { models: [] } : { assets: [], versions: [] })); vi.stubGlobal("fetch", fetch);
  const { node, onSelect } = await mount("work:shot-1"); await open(node);
  expect(fetch.mock.calls.filter(([url]) => url.includes("/status/")).map(([url]) => url)).toEqual(["/api/media/status/shot-job"]);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(JSON.parse(localStorage.getItem("glint.media-task")!).taskId).toBe("home-job");
  expect(JSON.parse(localStorage.getItem("glint.storyboard-task.v1:work:shot-2")!).taskId).toBe("other-job");
  expect(onSelect).not.toHaveBeenCalled();
});
it("does not open a generator for a frozen or read-only draft", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { node, onSelect } = await mount("work:locked", true); await open(node);
  expect(node.querySelector("button")!.disabled).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(onSelect).not.toHaveBeenCalled();
});

it("submits once after cost confirmation, persists its own receipt and binds only on request", async () => {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/media/submit") return Response.json({ taskId: "generated-shot" });
    if (url.includes("/status/")) return Response.json({ taskId: "generated-shot", isFinal: true, state: "success", assetUrl: "/api/media/assets/generated-shot.mp4" });
    return Response.json(url.includes("/models") ? { models: [{ id: "video-model", name: "Video" }], protocol: "skills" } : { assets: [], versions: [] });
  }); vi.stubGlobal("fetch", fetch);
  const { node, onSelect } = await mount("work:paid-shot"); await open(node);
  const submit = [...node.querySelectorAll("button")].find(button => button.textContent === "生成素材")!;
  expect(submit.disabled).toBe(true);
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST"); expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]![1]!.body))).toMatchObject({ type: "video", model: "video-model", prompt: "茶馆内，老陈倒茶。" });
  expect(JSON.parse(localStorage.getItem("glint.storyboard-task.v1:work:paid-shot")!).taskId).toBe("generated-shot");
  expect(localStorage.getItem("glint.media-task")).toBeNull(); expect(onSelect).not.toHaveBeenCalled();
  await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === "绑定到这个镜头")!.click());
  expect(onSelect).toHaveBeenCalledOnce(); expect(onSelect).toHaveBeenCalledWith("generated-shot.mp4");
});
