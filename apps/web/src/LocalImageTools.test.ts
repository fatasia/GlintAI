// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocalImageTools } from "./LocalImageTools";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

it("rejects an invalid AI response and permits retrying the same input", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method) return { ok: true, json: async () => ({ configured: true }) };
    attempts++;
    return { ok: true, blob: async () => new Blob(["fixture"], { type: attempts === 1 ? "text/html" : "image/png" }) };
  }));
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 20, height: 10, close: vi.fn() })));
  vi.stubGlobal("btoa", () => "Zml4dHVyZQ==");
  URL.createObjectURL = vi.fn(() => "blob:result"); URL.revokeObjectURL = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(LocalImageTools)); await wait(); });
  const input = div.querySelector<HTMLInputElement>('input[aria-label="选择本地图片"]')!;
  const file = new File(["fixture"], "source.webp", { type: "image/webp" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("fixture").buffer });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  const mode = div.querySelector<HTMLSelectElement>('select[aria-label="本地图片处理方式"]')!;
  await act(async () => { mode.value = "ai"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { div.querySelector("button")!.click(); await wait(); });
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("PNG");
  expect(div.querySelector("a[download]")).toBeNull();
  await act(async () => { div.querySelector("button")!.click(); await wait(); });
  expect(attempts).toBe(2);
  expect(div.querySelector<HTMLAnchorElement>("a[download]")?.download).toBe("source-cutout.png");
  expect(div.textContent).toContain("输出尺寸 20 × 10");
});

it("rejects a PNG whose decoded size differs from the source", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method
    ? { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) }
    : { ok: true, json: async () => ({ configured: true }) }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValueOnce({ width: 20, height: 10, close: vi.fn() }).mockResolvedValueOnce({ width: 2, height: 1, close: vi.fn() }));
  vi.stubGlobal("btoa", () => "eA=="); URL.createObjectURL = vi.fn(() => "blob:result"); URL.revokeObjectURL = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(LocalImageTools)); await wait(); });
  const file = new File(["x"], "source.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1]).buffer });
  const input = div.querySelector<HTMLInputElement>('input[aria-label="选择本地图片"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  const mode = div.querySelector<HTMLSelectElement>('select[aria-label="本地图片处理方式"]')!;
  await act(async () => { mode.value = "ai"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { div.querySelector("button")!.click(); await wait(); });
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("尺寸");
  expect(div.querySelector("a[download]")).toBeNull();
});
