// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MediaWorkshop } from "./MediaWorkshop";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
async function mount() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  cleanup = () => { act(() => root.unmount()); div.remove(); };
  await act(async () => { root.render(createElement(MediaWorkshop)); await new Promise(resolve => setTimeout(resolve, 0)); });
  return div;
}
it("recovers a lost media receipt with GET only and shows the saved asset", async () => {
  localStorage.setItem("glint.media-task", JSON.stringify({ requestId: "request-lost" }));
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.includes("/request/") ? { taskId: "task-123" } : url.includes("/status/") ? { taskId: "task-123", state: "success", isFinal: true, assetUrl: "/api/media/assets/task-123.png" } : { models: [] }));
  vi.stubGlobal("fetch", fetch);
  const div = await mount();
  expect(fetch.mock.calls.some(([url]) => url === "/api/media/request/request-lost")).toBe(true);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(div.querySelector("img")?.getAttribute("src")).toBe("/api/media/assets/task-123.png");
  expect(JSON.parse(localStorage.getItem("glint.media-task")!).taskId).toBe("task-123");
});

it("shows recent assets and the non-destructive version chain", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/media/library") return Response.json({ assets: [{ name: "a.png", url: "/api/media/assets/a.png", bytes: 10 }, { name: "b.png", url: "/api/media/assets/b.png", bytes: 12 }] });
    if (url === "/api/media/versions") return Response.json({ versions: [{ file: "a.png", parent: "b.png", model: "doubao", prompt: "换背景", url: "/api/media/assets/a.png" }] });
    if (url.includes("/api/media/models")) return Response.json({ models: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch);
  const div = await mount();
  expect(div.textContent).toContain("a.png");
  expect(div.textContent).toContain("编辑版本链");
  expect(div.textContent).toContain("换背景");
  expect(div.textContent).toContain("doubao");
});

it("fills the prompt from a shared image-edit preset", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/api/media/models") ? { models: [] } : url === "/api/media/library" ? { assets: [] } : url === "/api/media/versions" ? { versions: [] } : {})));
  const div = await mount();
  const preset = [...div.querySelectorAll("button")].find(button => button.textContent === "remove-bg")!;
  await act(async () => { preset.click(); });
  const prompt = div.querySelector<HTMLTextAreaElement>('textarea[aria-label="素材描述"]')!;
  expect(prompt.value).toContain("去除背景");
});

it("shows recent image assets from the library", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/media/library") return Response.json({ assets: [{ name: "a.png", url: "/api/media/assets/a.png", bytes: 10 }, { name: "b.mp4", url: "/api/media/assets/b.mp4", bytes: 12 }] });
    if (url === "/api/media/versions") return Response.json({ versions: [] });
    return Response.json({ models: [] });
  }));
  const div = await mount();
  expect(div.querySelector('img[alt="a.png"]')).toBeTruthy();
  expect(div.querySelector('img[alt="b.mp4"]')).toBeNull();
});

it("limits generation to images when the gateway uses OpenAI Images", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/media/models")) return Response.json({ protocol: "openai-images", models: [{ id: "gpt-image-2", name: "gpt-image-2" }] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/media/versions") return Response.json({ versions: [] });
    return Response.json({});
  }));
  const div = await mount();
  const type = div.querySelector<HTMLSelectElement>('select[aria-label="素材类型"]')!;
  expect(type.disabled).toBe(true);
  expect(div.textContent).toContain("只支持图片");
  expect(type.querySelector('option[value="video"]')!.hasAttribute("disabled")).toBe(true);
  expect(div.querySelector('select[aria-label="媒体模型"]')!.textContent).toContain("gpt-image-2");
});
