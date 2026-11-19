// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSettings } from "./ModelSettings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const llm = {
  reasoningEffort: "",
  baseUrl: "https://service.test/v1",
  model: "model-a",
  protocol: "auto",
  configured: true,
};
const media = {
  baseUrl: "https://media.test",
  protocol: "openai-images",
  configured: true,
  keyHint: "…5678",
};
const defaults = (url: string) =>
  Response.json(
    url === "/api/settings/model-registry"
      ? { models: [], builtins: [], digest: "a".repeat(64) }
      : url === "/api/settings/media"
        ? media
        : llm,
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function render(
  fetch: ReturnType<typeof vi.fn> = vi.fn(async (url: string) => defaults(url)),
  strict = false,
) {
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("glintDesktop", undefined);
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  cleanup = () => {
    act(() => root.unmount());
    div.remove();
  };
  await act(async () =>
    root.render(
      strict
        ? createElement(StrictMode, null, createElement(ModelSettings))
        : createElement(ModelSettings),
    ),
  );
  return div;
}
function button(div: Element, label: string) { const result = [...div.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); expect(result, label).toBeTruthy(); return result!; }
async function click(div: Element, label: string) { await act(async () => button(div, label).click()); }
function input(div: Element, label: string) { return div.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; }
async function change(div: Element, label: string, value: string) {
  const control = input(div, label), prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
function activePanel(div: Element) { return [...div.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find(panel => !panel.hidden)!; }

it("loads public connection settings without restoring a browser-stored secret", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem"), write = vi.spyOn(Storage.prototype, "setItem");
  const div = await render();
  expect(div.querySelectorAll('[role="tab"]')).toHaveLength(4);
  expect(div.querySelector('button[aria-expanded]')).toBeNull();
  expect(activePanel(div).textContent).toContain("在桌面版使用本地智能体");
  await click(div, "API 模型");
  expect(input(div, "模型服务地址").value).toBe(llm.baseUrl); expect(input(div, "模型 API 密钥").value).toBe("");
  expect(activePanel(div).textContent).toContain("自动适配");
  await click(div, "媒体服务");
  expect(input(div, "媒体网关地址").value).toBe(media.baseUrl); expect(input(div, "网关协议").value).toBe("openai-images");
  expect(activePanel(div).textContent).toContain("…5678"); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it("supports arrow, Home and End tab keys with roving focus while preserving drafts", async () => {
  const div = await render(), tabs = [...div.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const key = async (index: number, value: string) => act(async () => tabs[index]!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
  await key(0, "ArrowRight"); expect(document.activeElement).toBe(tabs[1]); expect(tabs[1]!.tabIndex).toBe(0); expect(tabs[0]!.tabIndex).toBe(-1);
  expect(activePanel(div).getAttribute("aria-labelledby")).toBe(tabs[1]!.id);
  await change(div, "模型名称", "draft-model");
  await key(1, "End");
  expect(document.activeElement).toBe(tabs[3]);
  expect(activePanel(div).getAttribute("aria-labelledby")).toBe(tabs[3]!.id);
  await key(3, "ArrowRight");
  expect(document.activeElement).toBe(tabs[0]);
  await key(0, "ArrowLeft");
  expect(document.activeElement).toBe(tabs[3]);
  await key(3, "Home");
  expect(document.activeElement).toBe(tabs[0]);
  await key(2, "ArrowRight");
  expect(document.activeElement).toBe(tabs[3]);
  await click(div, "API 模型");
  expect(input(div, "模型名称").value).toBe("draft-model");
});

it("saves model settings with the original endpoint and clears only the submitted secret", async () => {
  const post = deferred<Response>();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method === "POST" ? post.promise : defaults(url));
  const div = await render(fetch); await click(div, "API 模型"); await change(div, "模型 API 密钥", "secret-model-key");
  await act(async () => { button(div, "保存配置").click(); button(div, "保存配置").click(); });
  expect(activePanel(div).textContent).toContain("保存配置…"); expect(button(div, "保存中…").disabled).toBe(true);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  const [url, init] = fetch.mock.calls.at(-1)!; expect(url).toBe("/api/settings/llm");
  expect(JSON.parse(String(init?.body))).toEqual({ ...llm, configured: undefined, apiKey: "secret-model-key" });
  await act(async () => post.resolve(Response.json({ storage: "saved", configured: true })));
  expect(activePanel(div).textContent).toContain("已保存到本机数据目录"); expect(input(div, "模型 API 密钥").value).toBe("");
});

it("reports model save errors, preserves the draft and succeeds through retry", async () => {
  let failed = true;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method !== "POST" ? defaults(url)
    : failed ? Response.json({ error: "密钥无效，请更新密钥" }, { status: 401 }) : Response.json({ storage: "process-memory" }));
  const div = await render(fetch); await click(div, "API 模型"); await change(div, "模型 API 密钥", "try-again"); await click(div, "保存配置");
  expect(activePanel(div).querySelector('[role="alert"]')?.textContent).toContain("密钥无效"); expect(input(div, "模型 API 密钥").value).toBe("try-again");
  failed = false; await change(div, "模型 API 密钥", "corrected-key"); await click(activePanel(div), "重试");
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body)).apiKey).toBe("corrected-key");
  expect(activePanel(div).textContent).toContain("已保存到当前服务进程"); expect(activePanel(div).querySelector('[role="alert"]')).toBeNull();
});

it("fetches model lists including an empty directory and explicitly tests saved configuration", async () => {
  let empty = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method !== "POST" ? defaults(url)
    : url.endsWith("/models") ? Response.json({ models: empty ? [] : [{ id: "model-b" }, { id: "model-c" }], baseUrl: "https://service.test/v1" })
      : Response.json({ protocol: "responses", elapsedMs: 123 }));
  const div = await render(fetch); await click(div, "API 模型"); await click(div, "获取模型列表");
  expect(activePanel(div).textContent).toContain("获取 2 个模型"); expect(div.querySelectorAll("datalist option")).toHaveLength(2);
  empty = true; await click(div, "获取模型列表"); expect(activePanel(div).textContent).toContain("可手动填写模型名称");
  await click(div, "测试已保存配置（一次模型调用）"); expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/settings/llm/test");
  expect(activePanel(div).textContent).toContain("连接通过 · responses · 123 ms");
});

it("saves media independently while a model save is pending and retries media errors", async () => {
  const modelSave = deferred<Response>(); let mediaFailed = true;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return defaults(url);
    if (url === "/api/settings/llm") return modelSave.promise;
    return mediaFailed ? Response.json({ error: "媒体服务暂不可用" }, { status: 503 }) : Response.json({ configured: true, keyHint: "…9876" });
  });
  const div = await render(fetch); await click(div, "API 模型"); await click(div, "保存配置"); await click(div, "媒体服务");
  await change(div, "媒体网关密钥", "media-secret"); expect(button(div, "保存媒体网关").disabled).toBe(false); await click(div, "保存媒体网关");
  expect(activePanel(div).querySelector('[role="alert"]')?.textContent).toContain("媒体服务暂不可用"); expect(input(div, "媒体网关密钥").value).toBe("media-secret");
  mediaFailed = false; await change(div, "媒体网关密钥", "corrected-media-secret"); await click(activePanel(div), "重试");
  expect(activePanel(div).textContent).toContain("媒体网关已保存"); expect(activePanel(div).textContent).toContain("…9876"); expect(input(div, "媒体网关密钥").value).toBe("");
  const mediaCall = fetch.mock.calls.filter(([url, init]) => url === "/api/settings/media" && init?.method === "POST").at(-1)!;
  expect(JSON.parse(String(mediaCall[1]?.body))).toEqual({ baseUrl: media.baseUrl, protocol: "openai-images", apiKey: "corrected-media-secret" });
  await act(async () => modelSave.resolve(Response.json({ storage: "saved" })));
  await click(div, "API 模型"); expect(activePanel(div).textContent).toContain("已保存到本机数据目录");
});

it("clears stale model/media credentials when the service address changes", async () => {
  const div = await render(); await click(div, "API 模型"); await change(div, "模型 API 密钥", "old-model-key"); await change(div, "模型服务地址", "https://new.test/v1");
  expect(input(div, "模型 API 密钥").value).toBe("");
  await click(div, "媒体服务"); await change(div, "媒体网关密钥", "old-media-key"); await change(div, "媒体网关地址", "https://new-media.test");
  expect(input(div, "媒体网关密钥").value).toBe(""); expect(activePanel(div).textContent).not.toContain("…5678");
});

it("handles read failures independently, rejects malformed data and recovers through retry", async () => {
  let llmFailed = true;
  const fetch = vi.fn(async (url: string) => url === "/api/settings/media" ? defaults(url) : llmFailed ? Response.json({ error: "配置读取被拒绝" }, { status: 403 }) : defaults(url));
  const div = await render(fetch); await click(div, "API 模型");
  expect(activePanel(div).querySelector('[role="alert"]')?.textContent).toContain("配置读取被拒绝");
  await click(div, "媒体服务"); expect(input(div, "媒体网关地址").value).toBe(media.baseUrl);
  llmFailed = false; await click(div, "API 模型"); await click(activePanel(div), "重试"); expect(input(div, "模型服务地址").value).toBe(llm.baseUrl);
  fetch.mockImplementation(async () => Response.json([])); await click(div, "获取模型列表"); expect(activePanel(div).querySelector('[role="alert"]')?.textContent).toContain("无效配置");
});

it("times out requests with retry feedback and aborts outstanding reads on unmount", async () => {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => { const signal = init.signal!; signals.push(signal); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }));
  vi.useFakeTimers(); const div = await render(fetch); await click(div, "API 模型");
  expect(activePanel(div).textContent).toContain("读取模型配置…");
  await act(async () => vi.advanceTimersByTimeAsync(45_000)); expect(activePanel(div).querySelector('[role="alert"]')?.textContent).toContain("请求超时");
  expect(signals.every(signal => signal.aborted)).toBe(true);
  await click(activePanel(div), "重试"); cleanup(); cleanup = () => {}; expect(signals.every(signal => signal.aborted)).toBe(true);
});

it("keeps initial reads working in StrictMode without stale response overwrite", async () => {
  const fetch = vi.fn(async (url: string) => defaults(url));
  const div = await render(fetch, true); await click(div, "API 模型"); expect(input(div, "模型名称").value).toBe("model-a");
  await click(div, "媒体服务"); expect(input(div, "媒体网关地址").value).toBe(media.baseUrl);
});
