// @vitest-environment jsdom
import { act, createElement } from "react";
import { createHash, webcrypto } from "node:crypto";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GenCanvasBoard } from "./GenCanvasBoard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); localStorage.clear(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const node = { id: "image-1", kind: "image", prompt: "红色山峰", model: "", state: "draft", outputAsset: "", error: "", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" };
async function mount(projectId?: string) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_: string, __: unknown, fn: (lock: object) => Promise<void>) => fn({}) } });
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(GenCanvasBoard, { projectId })); });
  const click = async (label: string) => act(async () => { const button = [...div.querySelectorAll("button")].find(item => item.textContent === label); expect(button).toBeTruthy(); button!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  return { div, click, switchProject: async (projectId: string) => act(async () => { root.render(createElement(GenCanvasBoard, { projectId })); }) };
}
const ok = (value: unknown) => ({ ok: true, json: async () => value });
it("writes a durable receipt before submitting once, then records the asset", async () => {
  localStorage.setItem("glint:gen-canvas:v1", JSON.stringify({ schemaVersion: 1, nodes: [node], edges: [] }));
  let submitted: { body: Record<string, string>; receipt: unknown } | undefined;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/media/models")) return ok({ models: [{ id: "image-model", name: "图片模型" }] });
    if (url === "/api/media/submit") {
      const body = JSON.parse(init!.body as string);
      submitted = { body, receipt: JSON.parse(localStorage.getItem("glint:gen-canvas:receipt:image-1")!) };
      return ok({ taskId: "task-1" });
    }
    if (url === "/api/media/status/task-1") return ok({ isFinal: true, state: "success", assetUrl: "/api/media/assets/out.png" });
    throw new Error(url);
  }); vi.stubGlobal("fetch", fetcher);
  const h = await mount(); await act(async () => { [...h.div.querySelectorAll("strong")].find(el => el.textContent?.includes("image-1"))!.parentElement!.parentElement!.click(); });
  await h.click("生成（消耗网关额度）");
  await act(async () => { await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("glint:gen-canvas:receipt:image-1")!).isFinal).toBe(true), { timeout: 3000 }); });
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/media/submit")).toHaveLength(1);
  expect(submitted?.body.model).toBe("image-model");
  expect(submitted?.body.requestId).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(submitted?.receipt).toMatchObject({ requestId: submitted?.body.requestId });
  expect(h.div.textContent).toContain("完成");
  expect(JSON.parse(localStorage.getItem("glint:gen-canvas:receipt:image-1")!).isFinal).toBe(true);
});
it("recovers a pending receipt on reload without submitting again", async () => {
  localStorage.setItem("glint:gen-canvas:v1", JSON.stringify({ schemaVersion: 1, nodes: [{ ...node, state: "queued" }], edges: [] }));
  localStorage.setItem("glint:gen-canvas:receipt:image-1", JSON.stringify({ requestId: "request-123", nodeCreatedAt: node.createdAt }));
  const fetcher = vi.fn(async (url: string) => url.includes("/request/") ? ok({ taskId: "task-1" }) : ok({ isFinal: true, state: "success", assetUrl: "/api/media/assets/out.png" }));
  vi.stubGlobal("fetch", fetcher);
  const h = await mount(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(h.div.textContent).toContain("完成"); expect(fetcher.mock.calls.some(([url]) => url === "/api/media/submit")).toBe(false);
});
it("retains corrupted saved canvas rather than overwriting it", async () => {
  localStorage.setItem("glint:gen-canvas:v1", "not-json");
  const h = await mount();
  expect(h.div.textContent).toContain("原数据已保留");
  await h.click("＋ 文本");
  expect(localStorage.getItem("glint:gen-canvas:v1")).toBe("not-json");
});

it("sends a completed image task as a hashed reference rather than a URL in the prompt", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bytes = new Uint8Array([1, 2, 3]);
  const source = { ...node, id: "source", state: "done", outputAsset: "/api/media/assets/source-task.png" };
  const target = { ...node, id: "target" };
  localStorage.setItem("glint:gen-canvas:v1", JSON.stringify({ schemaVersion: 1, nodes: [source, target], edges: [{ from: "source", to: "target" }] }));
  localStorage.setItem("glint:gen-canvas:receipt:source", JSON.stringify({ requestId: "previous", nodeCreatedAt: source.createdAt, taskId: "source-task", isFinal: true }));
  let submitted: { canvasReference?: unknown; prompt?: string } | undefined;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/media/models")) return ok({ models: [{ id: "edit", tags: ["图生图"] }] });
    if (url === source.outputAsset) return { ...ok({}), headers: new Headers({ "content-length": "3" }), arrayBuffer: async () => bytes.buffer };
    if (url === "/api/media/submit") {
      submitted = JSON.parse(init!.body as string);
      return ok({ taskId: "target-task" });
    }
    if (url === "/api/media/status/target-task") return ok({ isFinal: true, state: "success", assetUrl: "/api/media/assets/target-task.png" });
    throw new Error(url);
  }); vi.stubGlobal("fetch", fetcher);
  const h = await mount();
  await act(async () => { [...h.div.querySelectorAll("strong")].find(el => el.textContent?.includes("target"))!.parentElement!.parentElement!.click(); });
  await h.click("生成（消耗网关额度）");
  await act(async () => { await vi.waitFor(() => expect(submitted).toBeDefined(), { timeout: 3000 }); });
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/media/submit")).toHaveLength(1);
  expect(submitted?.canvasReference).toEqual({ taskId: "source-task", sha256: createHash("sha256").update(bytes).digest("hex") });
  expect(submitted?.prompt).not.toContain(source.outputAsset);
});

it("isolates project nodes and pending receipts and reloads them on project switch",async()=>{
 const first={schemaVersion:1,nodes:[{...node,prompt:"项目甲"}],edges:[]};
 localStorage.setItem("glint:gen-canvas:v1:alpha",JSON.stringify(first));
 localStorage.setItem("glint:gen-canvas:v1",JSON.stringify({...first,nodes:[{...node,prompt:"旧全局"}]}));
 localStorage.setItem("glint:gen-canvas:receipt:image-1",JSON.stringify({requestId:"legacy-pending",nodeCreatedAt:node.createdAt}));
 const fetcher=vi.fn(async(_url:string)=>ok({models:[]}));vi.stubGlobal("fetch",fetcher);
 const h=await mount("alpha");expect(h.div.textContent).toContain("项目甲");expect(h.div.textContent).not.toContain("旧全局");
 await h.switchProject("beta");expect(h.div.textContent).not.toContain("项目甲");await h.click("＋ 文本");
 expect(JSON.parse(localStorage.getItem("glint:gen-canvas:v1:beta")!).nodes).toHaveLength(1);
 expect(JSON.parse(localStorage.getItem("glint:gen-canvas:v1:alpha")!)).toEqual(first);
 await h.switchProject("alpha");expect(h.div.textContent).toContain("项目甲");
 expect(fetcher.mock.calls.some(([url])=>String(url).includes("legacy-pending"))).toBe(false);
});

it("preserves a concurrent project canvas edit and refuses a new paid submission",async()=>{
 localStorage.setItem("glint:gen-canvas:v1:alpha",JSON.stringify({schemaVersion:1,nodes:[node],edges:[]}));
 const fetcher=vi.fn(async(_url:string)=>ok({models:[{id:"image-model"}]}));vi.stubGlobal("fetch",fetcher);
 const h=await mount("alpha");
 await act(async()=>{[...h.div.querySelectorAll("strong")].find(el=>el.textContent?.includes("image-1"))!.parentElement!.parentElement!.click();});
 const foreign=JSON.stringify({schemaVersion:1,nodes:[{...node,prompt:"另一窗口修改"}],edges:[]});localStorage.setItem("glint:gen-canvas:v1:alpha",foreign);
 await h.click("生成（消耗网关额度）");
 expect(h.div.textContent).toContain("其他窗口已更新");expect(localStorage.getItem("glint:gen-canvas:v1:alpha")).toBe(foreign);
 expect(localStorage.getItem("glint:gen-canvas:receipt:alpha:image-1")).toBeNull();
 expect(fetcher.mock.calls.some(([url])=>url==="/api/media/submit")).toBe(false);
});

it("does not overwrite another window's layout when arranging or undoing", async () => {
  const key="glint:gen-canvas:layout:v1:alpha";
  localStorage.setItem(key, JSON.stringify({"image-1":{x:17,y:23}}));
  localStorage.setItem("glint:gen-canvas:v1:alpha", JSON.stringify({schemaVersion:1,nodes:[node],edges:[]}));
  const h=await mount("alpha");
  await h.click("自动整理"); expect(localStorage.getItem(key)).toBe("{}");
  const foreign=JSON.stringify({"image-1":{x:41,y:53}}); localStorage.setItem(key,foreign);
  await h.click("撤销布局"); expect(localStorage.getItem(key)).toBe(foreign);
  await h.click("自动整理"); expect(localStorage.getItem(key)).toBe(foreign);
  expect(h.div.textContent).toContain("其他窗口已更新生成画布布局");
});
it("preserves malformed generation layout when arranging", async () => {
 const key="glint:gen-canvas:layout:v1:alpha";localStorage.setItem(key,"not-json");
 const h=await mount("alpha");await h.click("自动整理");
 expect(localStorage.getItem(key)).toBe("not-json");expect(h.div.textContent).toContain("原记录保留");
});

it("does not let a late status response replace another window's new receipt",async()=>{
 const key="glint:gen-canvas:receipt:alpha:image-1";
 localStorage.setItem("glint:gen-canvas:v1:alpha",JSON.stringify({schemaVersion:1,nodes:[{...node,state:"queued"}],edges:[]}));
 localStorage.setItem(key,JSON.stringify({requestId:"old-request",nodeCreatedAt:node.createdAt,taskId:"old-task"}));
 let finish!:(value:unknown)=>void;
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes('/status/')?new Promise(resolve=>{finish=resolve;}):ok({models:[]})));
 const h=await mount("alpha");
 const replacement=JSON.stringify({requestId:"new-request",nodeCreatedAt:node.createdAt,taskId:"new-task"});localStorage.setItem(key,replacement);
 await act(async()=>{finish(ok({isFinal:true,state:"success",assetUrl:"/api/media/assets/old-task.png"}));await new Promise(resolve=>setTimeout(resolve,0));});
 expect(localStorage.getItem(key)).toBe(replacement);
 expect(h.div.textContent).toContain("其他窗口已更新任务回执");
 expect(JSON.parse(localStorage.getItem("glint:gen-canvas:v1:alpha")!).nodes[0].state).toBe("queued");
});
it("does not regress a completed receipt when a late poll reports running",async()=>{
 const key="glint:gen-canvas:receipt:alpha:image-1";
 localStorage.setItem("glint:gen-canvas:v1:alpha",JSON.stringify({schemaVersion:1,nodes:[{...node,state:"queued"}],edges:[]}));
 const initial={requestId:"request-1",nodeCreatedAt:node.createdAt,taskId:"task-1"};localStorage.setItem(key,JSON.stringify(initial));
 let finish!:(value:unknown)=>void;
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes('/status/')?new Promise(resolve=>{finish=resolve;}):ok({models:[]})));
 const h=await mount("alpha");
 const completed=JSON.stringify({...initial,isFinal:true});localStorage.setItem(key,completed);
 await act(async()=>{finish(ok({isFinal:false,state:"running"}));await new Promise(resolve=>setTimeout(resolve,0));});
 expect(localStorage.getItem(key)).toBe(completed);expect(h.div.textContent).toContain("未使用迟到的进行中状态");
 expect(JSON.parse(localStorage.getItem("glint:gen-canvas:v1:alpha")!).nodes[0].state).toBe("queued");
});
