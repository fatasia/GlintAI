// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocalUpscale } from "./LocalUpscale";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

it("allows an explicitly configured local AI process and displays the verified result", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (!init?.method) return { ok: true, json: async () => ({ configured: true }) };
    expect(JSON.parse(String(init.body)).base64).toBe(btoa("fixture"));
    return { ok: true, blob: async () => new Blob(["result"], { type: "image/png" }) };
  }));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 200, close: vi.fn() })));
  URL.createObjectURL = vi.fn(() => "blob:result"); URL.revokeObjectURL = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(LocalUpscale)); await wait(); });
  const input = div.querySelector<HTMLInputElement>('input[aria-label="选择 AI 超分图片"]')!;
  const file = new File(["fixture"], "source.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("fixture").buffer });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { div.querySelector("button")!.click(); await wait(); });
  expect(div.textContent).toContain("输出尺寸 400 × 200");
  expect(calls).toEqual(["GET /api/local-upscale", "POST /api/local-upscale"]);
  expect(div.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe("source-ai-4x.png");
});

it("shows the actionable WebP metadata error and allows another attempt", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method
    ? { ok: false, json: async () => ({ error: "WebP 含方向相关元数据或动画，无法安全处理；请先按正确方向另存为 PNG 后重试。" }) }
    : { ok: true, json: async () => ({ configured: true }) }));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(LocalUpscale)); await wait(); });
  const input = div.querySelector<HTMLInputElement>('input[aria-label="选择 AI 超分图片"]')!;
  const file = new File(["fixture"], "source.webp", { type: "image/webp" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("fixture").buffer });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { div.querySelector("button")!.click(); await wait(); });
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("另存为 PNG");
  expect(div.querySelector("button")?.disabled).toBe(false);
});

it("does not submit when the optional local engine is absent", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ configured: false }) })); vi.stubGlobal("fetch", fetcher);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(LocalUpscale)); await wait(); });
  expect(div.textContent).toContain("未配置运行程序和模型");
  expect(div.querySelector("button")?.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
