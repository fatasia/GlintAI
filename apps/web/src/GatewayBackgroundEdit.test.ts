// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBackgroundEdit, verifyTransparentPng } from "./GatewayBackgroundEdit";
import * as expansion from "./gateway-expand";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const json = (value: unknown, ok = true) => ({ ok, json: async () => value }) as Response;
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const model = { protocol: "skills", models: [{ id: "tt-image-2.5", tags: ["Image-to-image", "Transparent background"] }] };
const price = { channel_groups: [{ is_active: true, in_key_whitelist: true, billing_method: "按次", base_price: 0.05 }] };
const asset = { name: "source.png", url: "/api/media/assets/source.png", bytes: 3 };

async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(GatewayBackgroundEdit, { library: [asset], refreshLibrary: vi.fn(async () => {}) })); await wait(); });
  const select = div.querySelector<HTMLSelectElement>('select[aria-label="透明编辑参考图"]')!;
  await act(async () => { select.value = asset.name; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  return div;
}
function browserMocks() {
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_: string, __: unknown, fn: (lock: object) => Promise<void>) => fn({}) } });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 1, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 255]) }) } as never);
}

it("confirms paid submission once, binds source hash and verifies transparent output", async () => {
  browserMocks(); const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/media/models")) return json(model);
    if (url.startsWith("/api/media/pricing")) return json(price);
    if (url === asset.url) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url === "/api/media/submit") return json({ taskId: "job-1" });
    if (url.startsWith("/api/media/request/")) return json({ taskId: "job-1" });
    if (url === "/api/media/status/job-1") return json({ taskId: "job-1", state: "success", isFinal: true, cost: 0.05, assetUrl: "/api/media/assets/output.png" });
    if (url === "/api/media/assets/output.png") return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    throw new Error(url);
  }));
  const div = await mount();
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "生成透明背景")!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  const submissions = calls.filter(call => call.url === "/api/media/submit");
  expect(submissions).toHaveLength(1);
  const body = submissions[0]!.body as { libraryReference: { name: string; sha256: string }; params: { background: string }; requestId: string };
  expect(body.libraryReference.name).toBe("source.png"); expect(body.libraryReference.sha256).toHaveLength(64);
  expect(body.params.background).toBe("transparent"); expect(body.requestId).toMatch(/^[a-z0-9-]+$/);
  expect(div.textContent).toContain("透明像素检查通过"); expect(div.textContent).toContain("0.05 算力");
});

it("keeps an uncertain receipt and recovery only queries without resubmitting", async () => {
  browserMocks(); const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith("/api/media/models")) return json(model);
    if (url.startsWith("/api/media/pricing")) return json(price);
    if (url === asset.url) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url === "/api/media/submit") throw new Error("connection lost");
    if (url.startsWith("/api/media/request/")) return json({}, false);
    throw new Error(url);
  }));
  const div = await mount();
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "生成透明背景")!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(JSON.parse(localStorage.getItem("glint.gateway-background.v1")!).requestId).toBeTruthy();
  const recover = [...div.querySelectorAll("button")].find(button => button.textContent?.includes("恢复查询"))!;
  await act(async () => { recover.click(); await wait(); });
  expect(calls.filter(url => url === "/api/media/submit")).toHaveLength(1);
  expect(div.textContent).toContain("不要重复提交");
});

it("does not label an opaque PNG as transparent", async () => {
  browserMocks();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]) }) } as never);
  await expect(verifyTransparentPng(new Blob(["png"], { type: "image/png" }))).rejects.toThrow("未检测到透明背景");
});

it("rechecks an already completed result after a temporary read failure without submitting again", async () => {
  browserMocks(); let reads = 0, submissions = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/media/models")) return json(model);
    if (url.startsWith("/api/media/pricing")) return json(price);
    if (url === asset.url) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url === "/api/media/submit") { submissions++; return json({ taskId: "job-1" }); }
    if (url === "/api/media/status/job-1") return json({ taskId: "job-1", state: "success", isFinal: true, assetUrl: "/api/media/assets/output.png" });
    if (url === "/api/media/assets/output.png") { reads++; return reads === 1 ? { ok: false } : { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) }; }
    throw new Error(url);
  }));
  const div = await mount();
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "生成透明背景")!.click(); await new Promise(resolve => setTimeout(resolve, 50)); });
  const retry = [...div.querySelectorAll("button")].find(button => button.textContent === "重新检查已有结果（不重新生成）");
  expect(retry).toBeTruthy();
  await act(async () => { retry!.click(); await wait(); });
  expect(div.textContent).toContain("透明像素检查通过");
  expect(reads).toBe(2); expect(submissions).toBe(1);
});

it("imports a local image to the current service without submitting to the gateway", async () => {
  browserMocks(); const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith("/api/media/models")) return json(model);
    if (url.startsWith("/api/media/pricing")) return json(price);
    if (url === "/api/media/import-image") return json({ name: "source.png" });
    throw new Error(url);
  }));
  const div = await mount();
  const input = div.querySelector<HTMLInputElement>('input[aria-label="导入透明编辑图片"]')!;
  const file = new File([new Uint8Array([1, 2, 3])], "local.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await wait(); });
  expect(calls.filter(url => url === "/api/media/import-image")).toHaveLength(1);
  expect(calls).not.toContain("/api/media/submit");
  expect(div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
});

it("submits a prepared expansion reference once and checks the selected output size", async () => {
  browserMocks(); const calls: Array<{ url: string; body?: unknown }> = [];
  vi.spyOn(expansion, "makeExpansionReference").mockResolvedValue({ type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer } as Blob);
  const verify = vi.spyOn(expansion, "verifyExpansionSize").mockResolvedValue({ width: 864, height: 1536 });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: url === "/api/media/submit" ? JSON.parse(String(init?.body)) : undefined });
    if (url.startsWith("/api/media/models")) return json(model);
    if (url.startsWith("/api/media/pricing")) return json(price);
    if (url === asset.url) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url === "/api/media/import-image") return json({ name: "prepared.png" });
    if (url === "/api/media/submit") return json({ taskId: "expand-job" });
    if (url.startsWith("/api/media/request/")) return json({ taskId: "expand-job" });
    if (url === "/api/media/status/expand-job") return json({ taskId: "expand-job", state: "success", isFinal: true, cost: 0.05, assetUrl: "/api/media/assets/output.png" });
    if (url === "/api/media/assets/output.png") return { ok: true, blob: async () => new Blob(["png"], { type: "image/png" }) };
    throw new Error(url);
  }));
  const div = await mount(), mode = div.querySelector<HTMLSelectElement>('select[aria-label="网关图片处理方式"]')!;
  await act(async () => { mode.value = "expand"; mode.dispatchEvent(new Event("change", { bubbles: true })); });
  const target = div.querySelector<HTMLSelectElement>('select[aria-label="扩画目标画幅"]')!;
  await act(async () => { target.value = "864x1536"; target.dispatchEvent(new Event("change", { bubbles: true })); div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "生成扩画")!.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
  const submissions = calls.filter(call => call.url === "/api/media/submit"); expect(submissions).toHaveLength(1);
  const body = submissions[0]!.body as { libraryReference: { name: string }; params: { size: string; background: string } };
  expect(body.libraryReference.name).toBe("prepared.png"); expect(body.params).toMatchObject({ size: "864x1536", background: "opaque" });
  expect(JSON.parse(localStorage.getItem("glint.gateway-background.v1")!).targetSize).toBe("864x1536");
  expect(verify).toHaveBeenCalledWith(expect.any(Blob), "864x1536"); expect(div.textContent).toContain("输出尺寸检查通过");
});
it("releases a 503 price response body and keeps the cost unknown", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":"Configure a media gateway"}')); }, cancel }), { status: 503 });
  const network = vi.fn(async (url: string) => url.startsWith("/api/media/pricing") ? response : Response.json({ protocol: "skills", models: [] }));
  vi.stubGlobal("fetch", network);
  const div = await mount();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(div.textContent).toContain("价格未知");
  expect([...div.querySelectorAll("button")].find(button => button.textContent === "生成透明背景")!.disabled).toBe(true);
  expect(network.mock.calls.some(([url]) => url === "/api/media/submit")).toBe(false);
});
