// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ComfyWorkflowPanel } from "./ComfyWorkflowPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const graph = JSON.stringify({ "6": { class_type: "CLIPTextEncode", inputs: { text: "forest" } } });
const task = { taskId: "comfy-one", type: "image", state: "success", isFinal: true, outputs: [{ index: 0, name: "first.png" }, { index: 1, name: "second.png" }] };
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function button(root: HTMLElement, text: string) { const value = [...root.querySelectorAll('button')].find(item => item.textContent === text); if (!value) throw new Error(`Missing button ${text}`); return value; }
async function click(element: HTMLElement) { await act(async () => { element.click(); await pause(); }); }
async function fill(root: HTMLElement, label: string, value: string) {
  const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value); field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function mount(fetcher: (url: string, init?: RequestInit) => Promise<unknown> = async url => response(url.endsWith("config") ? { configured: true } : task)) {
  const fetch = vi.fn(fetcher); vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), refresh = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(ComfyWorkflowPanel, { refreshLibrary: refresh })); await pause(); });
  return { host, fetch, refresh };
}
async function prepare(host: HTMLElement) { await fill(host, "API 格式工作流", graph); await click(host.querySelector('input[type="checkbox"]')!); }

it("requires configured service and explicit confirmation, maps scalars and only imports the selected output", async () => {
  const { host, fetch, refresh } = await mount(async (url, init) => {
    if (url.endsWith("config")) return response({ configured: true });
    if (url.endsWith("submit")) { expect(JSON.parse(String(init?.body))).toMatchObject({ workflow: JSON.parse(graph), inputs: [{ nodeId: "6", input: "text", value: "forest" }], type: "video", confirmed: true }); return response({ taskId: task.taskId }); }
    if (url.includes("/import/")) { expect(JSON.parse(String(init?.body))).toEqual({ outputIndex: 1 }); return response({ assetName: "result.mp4", assetUrl: "/api/media/assets/result.mp4", type: "video", sha256: "a".repeat(64) }); }
    return response(task);
  });
  await fill(host, "API 格式工作流", graph); expect(button(host, "执行工作流").disabled).toBe(true);
  await fill(host, "标量输入映射", '[{"nodeId":"6","input":"text","value":"forest"}]'); await fill(host, "输出类型", "video");
  await click(host.querySelector('input[type="checkbox"]')!); await click(button(host, "执行工作流"));
  expect(button(host, "执行工作流").disabled).toBe(true); expect(refresh).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem("glint.comfyui-task")!)).toEqual({ requestId: expect.any(String), taskId: task.taskId });
  expect(localStorage.getItem("glint.comfyui-task")).not.toContain("forest");
  expect(button(host, "导入素材库").disabled).toBe(true); await fill(host, "工作流输出", "1"); await click(button(host, "导入素材库"));
  expect(refresh).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("已导入素材库：result.mp4");
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("submit"))).toHaveLength(1);
});

it("preserves an uncertain request identity and draft; recovery queries never resubmit", async () => {
  const { host, fetch } = await mount(async url => {
    if (url.endsWith("config")) return response({ configured: true });
    if (url.endsWith("submit")) throw new Error("connection lost");
    if (url.includes("/request/")) return response({ taskId: task.taskId });
    return response(task);
  });
  await prepare(host); await click(button(host, "执行工作流"));
  const saved = JSON.parse(localStorage.getItem("glint.comfyui-task")!); expect(saved).toEqual({ requestId: expect.any(String) });
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="API 格式工作流"]')!.value).toBe(graph);
  expect(button(host, "执行工作流").disabled).toBe(true); expect(host.textContent).toContain("connection lost");
  await click(button(host, "查询回执与进度"));
  expect(fetch.mock.calls.some(([url]) => url === `/api/media/request/${saved.requestId}`)).toBe(true);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("submit"))).toHaveLength(1);
});

it("recovers only stored IDs after remount and does not treat unknown state as safe to resubmit", async () => {
  localStorage.setItem("glint.comfyui-task", JSON.stringify({ requestId: "request-one", taskId: task.taskId, workflow: "not restored" }));
  const { host, fetch } = await mount(async url => response(url.endsWith("config") ? { configured: true } : { ...task, state: "unknown", isFinal: false, outputs: [] }));
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(""); expect(fetch).toHaveBeenCalledTimes(1);
  await click(button(host, "查询回执与进度"));
  expect(host.textContent).toContain("状态未知"); expect(button(host, "执行工作流").disabled).toBe(true);
  expect(host.textContent).not.toContain("新建工作流任务"); expect(localStorage.getItem("glint.comfyui-task")).not.toContain("workflow");
});

it("recovers a known task ID and reports queue cancellation as a request rather than completion", async () => {
  const { host, fetch } = await mount(async url => response(url.endsWith("config") ? { configured: true } : url.includes("/cancel/") ? { taskId: task.taskId, outcome: "delete-requested" } : { ...task, state: "running", isFinal: false, outputs: [] }));
  await fill(host, "已有任务编号", task.taskId); await click(button(host, "恢复任务查询"));
  await click(button(host, "请求移出队列"));
  expect(host.textContent).toContain("不代表运行中的任务已停止"); expect(host.textContent).toContain("运行中");
  expect(button(host, "执行工作流").disabled).toBe(true); expect(fetch.mock.calls.some(([url]) => url.endsWith("submit"))).toBe(false);
});

it("keeps submission disabled when the service is not configured", async () => {
  const { host, fetch } = await mount(async () => response({ configured: false })); await prepare(host);
  expect(button(host, "执行工作流").disabled).toBe(true); expect(host.textContent).toContain("本地工作流服务尚未启用"); expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not dispatch when saving recovery identity fails", async () => {
  const { host, fetch } = await mount(); await prepare(host);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await click(button(host, "执行工作流")); expect(host.textContent).toContain("无法保存恢复编号"); expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects non-scalar mappings before creating a request journal", async () => {
  const { host, fetch } = await mount(); await prepare(host); await fill(host, "标量输入映射", '[{"nodeId":"6","input":"text","value":{}}]');
  await click(host.querySelector('input[type="checkbox"]')!); await click(button(host, "执行工作流"));
  expect(host.textContent).toContain("输入映射须为数组"); expect(localStorage.getItem("glint.comfyui-task")).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});

it("ignores a late submit response after unmount, keeping the original recovery ID", async () => {
  let finish!: (value: unknown) => void;
  const { host, refresh } = await mount(async url => url.endsWith("config") ? response({ configured: true }) : new Promise(resolve => { finish = resolve; }));
  await prepare(host); await click(button(host, "执行工作流")); const saved = localStorage.getItem("glint.comfyui-task");
  dispose(); dispose = () => {}; await act(async () => { finish(response({ taskId: task.taskId })); await pause(); });
  expect(localStorage.getItem("glint.comfyui-task")).toBe(saved); expect(refresh).not.toHaveBeenCalled();
});

it("loads an API JSON file without persisting its contents and resets confirmation on edits", async () => {
  const { host } = await mount(); const file = new File([graph], "workflow.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => graph });
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await pause(); });
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(graph);
  expect(localStorage.getItem("glint.comfyui-task")).toBeNull();
  await click(host.querySelector('input[type="checkbox"]')!); await fill(host, "输出类型", "audio");
  expect(button(host, "执行工作流").disabled).toBe(true);
});

it("rejects an import response pointing outside the existing asset library", async () => {
  localStorage.setItem("glint.comfyui-task", JSON.stringify({ taskId: task.taskId }));
  const { host, refresh } = await mount(async url => response(url.endsWith("config") ? { configured: true } : url.includes("/import/") ? { assetName: "file.png", assetUrl: "https://example.invalid/file.png", type: "image", sha256: "a".repeat(64) } : task));
  await click(button(host, "查询回执与进度")); await fill(host, "工作流输出", "0"); await click(button(host, "导入素材库"));
  expect(refresh).not.toHaveBeenCalled(); expect(host.textContent).toContain("任务回执格式不正确"); expect(host.querySelector('a[href]')).toBeNull();
});

it("restores a valid long task ID from the journal without truncating the 64-character request ID", async () => {
  const requestId = "r".repeat(64), taskId = `comfy-${requestId}`;
  localStorage.setItem("glint.comfyui-task", JSON.stringify({ requestId, taskId }));
  const { host, fetch } = await mount(async url => response(url.endsWith("config") ? { configured: true } : { ...task, taskId }));
  await click(button(host, "查询回执与进度"));
  expect(fetch.mock.calls.some(([url]) => url === `/api/media/comfyui/status/${taskId}`)).toBe(true);
  expect(JSON.parse(localStorage.getItem("glint.comfyui-task")!)).toEqual({ requestId, taskId });
  expect(host.textContent).toContain(taskId);
});

it("allows manual recovery up to the media task ID limit but rejects an oversized ID", async () => {
  const taskId = "t".repeat(100);
  const { host, fetch } = await mount(async url => response(url.endsWith("config") ? { configured: true } : { ...task, taskId }));
  await fill(host, "已有任务编号", "t".repeat(101)); expect(button(host, "恢复任务查询").disabled).toBe(true);
  await fill(host, "已有任务编号", taskId); expect(button(host, "恢复任务查询").disabled).toBe(false);
  await click(button(host, "恢复任务查询"));
  expect(fetch.mock.calls.some(([url]) => url === `/api/media/comfyui/status/${taskId}`)).toBe(true);
  expect(JSON.parse(localStorage.getItem("glint.comfyui-task")!)).toEqual({ taskId });
});

it("requires explicit acknowledgement to end uncertain tracking without cancelling or resubmitting", async () => {
  localStorage.setItem("glint.comfyui-task", JSON.stringify({ requestId: "lost-request" }));
  const { host, fetch } = await mount();
  const clear = button(host, "清除追踪，准备新任务"); expect(clear.disabled).toBe(true);
  expect(host.textContent).toContain("不会停止上游任务"); expect(host.textContent).toContain("lost-request");
  await click(clear); expect(localStorage.getItem("glint.comfyui-task")).toContain("lost-request");
  const acknowledgement = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("我已记录恢复编号"))!;
  expect(acknowledgement.checked).toBe(false); await click(acknowledgement); await click(clear);
  expect(JSON.parse(localStorage.getItem("glint.comfyui-task")!)).toEqual({}); expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(button(host, "执行工作流").disabled).toBe(true); expect(host.textContent).not.toContain("lost-request");
});

it("allows acknowledged local release of an unknown task while preserving its workflow draft", async () => {
  const { host, fetch } = await mount(async url => response(url.endsWith("config") ? { configured: true } : url.endsWith("submit") ? { taskId: task.taskId } : { ...task, state: "unknown", isFinal: false, outputs: [] }));
  await prepare(host); await click(button(host, "执行工作流"));
  const acknowledgement = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("我已记录恢复编号"))!;
  const count = fetch.mock.calls.length; await click(acknowledgement); await click(button(host, "清除追踪，准备新任务"));
  expect(fetch).toHaveBeenCalledTimes(count); expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(graph);
  expect(button(host, "执行工作流").disabled).toBe(true);
});

it("shares the single configuration read and disables execution while a new connection is being saved", async () => {
  let finish!: (value: unknown) => void;
  const { host, fetch } = await mount(async (_url, init) => init?.method === "POST" ? new Promise(resolve => { finish = resolve; }) : response({ configured: true, endpoint: "http://127.0.0.1:8188", source: "saved" }));
  await prepare(host); expect(fetch).toHaveBeenCalledTimes(1); expect(button(host, "执行工作流").disabled).toBe(false);
  await click(button(host, "保存连接")); expect(button(host, "正在处理…").disabled).toBe(true);
  await act(async () => { finish(response({ configured: true, endpoint: "http://127.0.0.1:8188", source: "saved" })); await pause(); });
  expect(button(host, "执行工作流").disabled).toBe(true); expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
});

it("keeps connection changes locked until uncertain tracking is explicitly released", async () => {
  localStorage.setItem("glint.comfyui-task", JSON.stringify({ requestId: "request-one" }));
  const { host, fetch } = await mount(async () => response({ configured: true, endpoint: "http://127.0.0.1:8188", source: "saved" }));
  expect(button(host, "保存连接").disabled).toBe(true); expect(button(host, "恢复默认连接").disabled).toBe(true);
  const acknowledgement = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("我已记录恢复编号"))!;
  await click(acknowledgement); await click(button(host, "清除追踪，准备新任务"));
  expect(button(host, "保存连接").disabled).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
});

it("checks node classes without execution confirmation, task journal or submission", async () => {
  const { host, fetch } = await mount(async (url, init) => {
    if (url.endsWith("config")) return response({ configured: true });
    expect(url).toBe("/api/media/comfyui/validate"); expect(JSON.parse(String(init?.body))).toEqual({ workflow: JSON.parse(graph), inputs: [] });
    return response({ ok: true, checked: 1, available: ["CLIPTextEncode"], missing: [], submitted: false });
  });
  await fill(host, "API 格式工作流", graph); expect(button(host, "执行工作流").disabled).toBe(true);
  await click(button(host, "检查节点依赖"));
  expect(host.textContent).toContain("所需节点均已注册"); expect(host.textContent).toContain("不检查模型权重");
  expect(localStorage.getItem("glint.comfyui-task")).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
});

it("shows missing classes and discards stale checks after graph, input or connection changes", async () => {
  const { host } = await mount(async url => response(url.endsWith("config") ? { configured: true, endpoint: "http://127.0.0.1:8188", source: "saved" } : { ok: false, checked: 1, available: [], missing: ["MissingLocalNode"], submitted: false }));
  await fill(host, "API 格式工作流", graph); await click(button(host, "检查节点依赖")); expect(host.textContent).toContain("MissingLocalNode");
  await fill(host, "API 格式工作流", graph + " "); expect(host.querySelector('[aria-label="节点依赖检查结果"]')).toBeNull();
  await click(button(host, "检查节点依赖")); await fill(host, "标量输入映射", "[ ]"); expect(host.querySelector('[aria-label="节点依赖检查结果"]')).toBeNull();
  await click(button(host, "检查节点依赖")); await click(button(host, "保存连接")); expect(host.querySelector('[aria-label="节点依赖检查结果"]')).toBeNull();
});

it("keeps the draft and no journal after a dependency service error", async () => {
  const { host } = await mount(async url => url.endsWith("config") ? response({ configured: true }) : { ...response({ code: "node-check-failed", submitted: false }, false), status: 503 });
  await fill(host, "API 格式工作流", graph); await click(button(host, "检查节点依赖"));
  expect(host.textContent).toContain("节点检查服务暂不可用"); expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(graph); expect(localStorage.getItem("glint.comfyui-task")).toBeNull();
});

it.each([[422, "missing-nodes"], [503, "node-check-failed"]] as const)("releases only an explicitly non-submitted dependency rejection %s / %s", async (status, code) => {
  const { host, fetch } = await mount(async url => url.endsWith("config") ? response({ configured: true }) : { ...response({ code, submitted: false }, false), status });
  await prepare(host); await click(button(host, "执行工作流"));
  expect(JSON.parse(localStorage.getItem("glint.comfyui-task")!)).toEqual({}); expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(graph);
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false); expect(button(host, "执行工作流").disabled).toBe(true);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("submit"))).toHaveLength(1); expect(button(host, "检查节点依赖").disabled).toBe(false);
});

it("retains uncertain identity on other rejections even if they claim submitted false", async () => {
  const { host } = await mount(async url => url.endsWith("config") ? response({ configured: true }) : { ...response({ code: "another-error", submitted: false }, false), status: 422 });
  await prepare(host); await click(button(host, "执行工作流"));
  expect(JSON.parse(localStorage.getItem("glint.comfyui-task")!).requestId).toEqual(expect.any(String)); expect(button(host, "检查节点依赖").disabled).toBe(true);
});
