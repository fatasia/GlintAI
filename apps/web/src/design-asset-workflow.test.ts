// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignEditor, type DesignEditorProps } from "./DesignEditor";
import { createProjectDesignDocuments, saveProjectDesignDocuments, type ProjectDesignDocuments } from "./design-artifacts";
import { DESIGN_ASSET_BYTES, DESIGN_LIBRARY_BYTES, projectAssetsKey, readProjectAssets } from "./design-assets";
import { DESIGN_BRIDGE } from "./design-editor-bridge";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const asset = { name: "cup.png", url: "/api/media/assets/cup.png", bytes: 3 };
const oldImage = "data:image/png;base64,T0xE", newImage = "data:image/png;base64,AQID";
const html = `<main><h1 data-design-id="title">标题</h1><p data-design-id="description">说明</p><img data-design-id="picture" src="${oldImage}" alt="原图" style="width:120px;height:80px"></main>`;
let sequence = 0, dispose = () => {};
let readers: ControlledFileReader[];

// 仅控制浏览器文件 I/O 的完成时机，素材校验和 DesignEditor 均使用真实实现。
class ControlledFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(_blob: Blob) { readers.push(this); }
  succeed() { this.result = newImage; this.onload?.(); }
  fail() { this.onerror?.(); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const libraryResponse = () => Response.json({ assets: [asset] });
const imageResponse = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-length": "3" } });
beforeEach(() => {
  readers = []; localStorage.clear();
  vi.stubGlobal("FileReader", ControlledFileReader);
});
afterEach(() => { dispose(); dispose = () => {}; document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  const projectId = `asset-workflow-${++sequence}`, seed = createProjectDesignDocuments(projectId);
  seed.documents = seed.documents.slice(0, 2).map(doc => ({ ...doc, pages: [
    { ...doc.pages[0]!, html },
    { ...doc.pages[0]!, id: `${doc.id}-second`, title: "第二页", html: '<main><h1 data-design-id="other">其他页面</h1></main>' },
  ], activePageId: doc.pages[0]!.id }));
  seed.activeId = seed.documents[0]!.id; saveProjectDesignDocuments(seed);
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
  const onDocumentsChange = vi.fn(), props: DesignEditorProps = { projectId, onDocumentsChange, onSelection: vi.fn() };
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(DesignEditor, props)));
  const state = () => onDocumentsChange.mock.lastCall![0] as ProjectDesignDocuments;
  const current = () => { const doc = state().documents.find(item => item.id === state().activeId)!; return { doc, page: doc.pages.find(item => item.id === doc.activePageId)! }; };
  return { node, props, state, current };
}
type Workspace = Awaited<ReturnType<typeof mount>>;
function button(node: ParentNode, text: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
  if (!found) throw new Error(`未找到按钮 ${text}`); return found;
}
const field = <T extends HTMLElement>(node: ParentNode, label: string) => node.querySelector<T>(`[aria-label="${label}"]`)!;
const panel = (work: Workspace) => field<HTMLElement>(work.node, "插入图片");
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
async function selectNode(work: Workspace, nodeId: string) {
  const frame = work.node.querySelector<HTMLIFrameElement>('iframe[title="设计预览"]')!;
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: {
    type: DESIGN_BRIDGE, generation: frame.dataset.designGeneration, action: "select", nodeId, nodeIds: [nodeId],
  } })); });
  expect(work.props.onSelection).toHaveBeenLastCalledWith(expect.objectContaining({ nodeId, nodeIds: [nodeId], editable: true }));
}
async function source(work: Workspace, value: string) {
  await click(button(work.node, "HTML 源码"));
  const input = field<HTMLTextAreaElement>(work.node, "页面 HTML 源码");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseFile(work: Workspace) {
  const input = field<HTMLInputElement>(work.node, "从本机选择图片");
  Object.defineProperty(input, "files", { value: [new File([new Uint8Array([1, 2, 3])], "cup.png", { type: "image/png" })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(readers).toHaveLength(1);
  expect(input.value).toBe("");
}
async function completeFile(fail = false) {
  const reader = readers.shift(); expect(reader).toBeDefined();
  await act(async () => { if (fail) reader!.fail(); else reader!.succeed(); });
}
async function open(work: Workspace) { await click(button(work.node, "图片")); expect(panel(work)).not.toBeNull(); }
function expectUnchanged(work: Workspace, before: string) {
  expect.soft(JSON.stringify(work.state().documents)).toBe(before);
  expect.soft(readProjectAssets(work.props.projectId)).toEqual([]);
  expect.soft(localStorage.getItem(projectAssetsKey(work.props.projectId))).toBeNull();
}

it("刷新素材库时保持面板打开，更新列表并可继续选图", async () => {
  const next = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(Response.json({ assets: [] })).mockReturnValueOnce(next.promise);
  vi.stubGlobal("fetch", fetch); const work = await mount(), before = JSON.stringify(work.state().documents); await open(work);
  expect(button(work.node, "图片").getAttribute("aria-pressed")).toBe("true");
  await click(button(panel(work), "刷新素材库"));
  expect(panel(work)).not.toBeNull(); expect(button(panel(work), "读取中…").disabled).toBe(true);
  await act(async () => next.resolve(libraryResponse()));
  expect(panel(work)).not.toBeNull(); expect(button(panel(work), "cup.png").disabled).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  expectUnchanged(work, before);
});

it.each(["本机", "素材库"] as const)("%s 图片实际插入、一次撤销重做且成功后才记住素材库引用", async kind => {
  const fetch = vi.fn().mockResolvedValueOnce(libraryResponse()).mockResolvedValueOnce(imageResponse()); vi.stubGlobal("fetch", fetch);
  const work = await mount(), before = work.current().page.html; await open(work);
  if (kind === "本机") await chooseFile(work); else await click(button(panel(work), "cup.png"));
  expect(work.current().page.html).toBe(before); expect(readProjectAssets(work.props.projectId)).toEqual([]);
  await completeFile();
  expect(panel(work)).toBeNull();
  const inserted = new DOMParser().parseFromString(work.current().page.html, "text/html");
  expect(inserted.querySelectorAll("img")).toHaveLength(2);
  expect(inserted.querySelector("main > figure > img")?.getAttribute("src")).toBe(newImage);
  expect(readProjectAssets(work.props.projectId)).toEqual(kind === "素材库" ? [asset] : []);
  const after = work.current().page.html;
  await click(button(work.node, "撤销")); expect(work.current().page.html).toBe(before);
  await click(button(work.node, "重做")); expect(work.current().page.html).toBe(after);
});

it("通过真实选区替换图片且保留布局、替代文字与节点标识", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(libraryResponse())); const work = await mount();
  await selectNode(work, "picture"); await open(work); expect.soft(panel(work).textContent).toContain("将替换选中图片");
  await chooseFile(work); await completeFile();
  const doc = new DOMParser().parseFromString(work.current().page.html, "text/html"), image = doc.querySelector('[data-design-id="picture"]')!;
  expect(doc.querySelectorAll("img")).toHaveLength(1); expect(image.getAttribute("src")).toBe(newImage);
  expect(image.getAttribute("style")).toBe("width:120px;height:80px"); expect(image.getAttribute("alt")).toBe("原图");
});

for (const kind of ["本机", "素材库"] as const) {
  describe(`${kind}异步读取上下文冻结`, () => {
    it.each(["切页", "切文档", "改源码", "改选区"] as const)("%s 后拒绝写入任何文档或项目引用", async change => {
      const fetch = vi.fn().mockResolvedValueOnce(libraryResponse()).mockResolvedValueOnce(imageResponse()); vi.stubGlobal("fetch", fetch);
      const work = await mount(); await selectNode(work, "picture"); await open(work);
      if (kind === "本机") await chooseFile(work); else await click(button(panel(work), "cup.png"));
      if (change === "切页") await click(work.node.querySelectorAll<HTMLButtonElement>('.design-page-row button')[1]!);
      if (change === "切文档") {
        const input = field<HTMLSelectElement>(work.node, "切换设计文档");
        await act(async () => { input.value = work.state().documents[1]!.id; input.dispatchEvent(new Event("change", { bubbles: true })); });
      }
      if (change === "改源码") await source(work, '<main><h1 data-design-id="new-title">读取期间的新源码</h1></main>');
      if (change === "改选区") await selectNode(work, "description");
      const before = JSON.stringify(work.state().documents); await completeFile(); expectUnchanged(work, before);
      expect(panel(work)).not.toBeNull(); expect(field<HTMLInputElement>(work.node, "从本机选择图片").disabled).toBe(false);
      if (change === "改源码" || change === "改选区") expect(panel(work).querySelector('[role="alert"]')?.textContent).toContain("页面或选区已变化");
      if (kind === "素材库" && (change === "切页" || change === "切文档")) expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
    });
  });
}

for (const close of ["关闭", "图片"] as const) {
  describe(`${close}取消任务`, () => {
    it("取消尚未完成的素材库列表，重新打开只显示新请求", async () => {
      const pending = deferred<Response>();
      const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json({ assets: [] })); vi.stubGlobal("fetch", fetch);
      const work = await mount(); await open(work);
      const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
      await click(button(close === "关闭" ? panel(work) : work.node, close));
      expect(panel(work)).toBeNull();
      const abortedOnClose = signal.aborted;
      await act(async () => pending.resolve(libraryResponse()));
      await open(work); expect(panel(work).textContent).toContain("素材库还没有图片");
      expect(panel(work).textContent).not.toContain("cup.png");
      expect(abortedOnClose).toBe(true);
    });
    it.each(["本机", "素材库"] as const)("%s 读取期间关闭后，迟到的成功不得插入或记住引用", async kind => {
      const fetch = vi.fn().mockResolvedValueOnce(libraryResponse()).mockResolvedValueOnce(imageResponse()); vi.stubGlobal("fetch", fetch);
      const work = await mount(); await open(work);
      if (kind === "本机") await chooseFile(work); else await click(button(panel(work), "cup.png"));
      const before = JSON.stringify(work.state().documents);
      await click(button(close === "关闭" ? panel(work) : work.node, close)); expect(panel(work)).toBeNull();
      await completeFile(); expectUnchanged(work, before);
      if (kind === "素材库") expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
    });
  });
}

it("素材库加载错误可原面板刷新重试，并清除错误恢复选择", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("offline", { status: 503 })).mockResolvedValueOnce(libraryResponse()); vi.stubGlobal("fetch", fetch);
  const work = await mount(), before = JSON.stringify(work.state().documents); await open(work);
  expect(panel(work).querySelector('[role="alert"]')?.textContent).toContain("素材库读取失败");
  expect(field<HTMLInputElement>(work.node, "从本机选择图片").disabled).toBe(false);
  await click(button(panel(work), "刷新素材库")); expect(panel(work).querySelector('[role="alert"]')).toBeNull();
  expect(button(panel(work), "cup.png").disabled).toBe(false); expectUnchanged(work, before);
});

it("本机文件读取错误可重新选择同名文件并成功插入", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(libraryResponse())); const work = await mount();
  const before = JSON.stringify(work.state().documents); await open(work); await chooseFile(work); await completeFile(true);
  expectUnchanged(work, before); expect(panel(work).querySelector('[role="alert"]')?.textContent).toContain("图片读取失败");
  expect(field<HTMLInputElement>(work.node, "从本机选择图片").disabled).toBe(false);
  await chooseFile(work); await completeFile(); expect(panel(work)).toBeNull(); expect(work.current().page.html).toContain(newImage);
});

it("素材下载失败可重选同一素材，失败时不写入最近使用列表", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(libraryResponse()).mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(imageResponse()); vi.stubGlobal("fetch", fetch);
  const work = await mount(), before = JSON.stringify(work.state().documents); await open(work); await click(button(panel(work), "cup.png"));
  expectUnchanged(work, before); expect(panel(work).querySelector('[role="alert"]')?.textContent).toContain("素材读取失败");
  expect(button(panel(work), "cup.png").disabled).toBe(false); await click(button(panel(work), "cup.png")); await completeFile();
  expect(panel(work)).toBeNull(); expect(work.current().page.html).toContain(newImage); expect(readProjectAssets(work.props.projectId)).toEqual([asset]);
});

it.each([
  { name: "超限声明长度", response: () => new Response("abc", { headers: { "content-type": "image/png", "content-length": String(8 * 1024 * 1024 + 1) } }), error: "超过" },
  { name: "实际响应超限", response: () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/png", "content-length": "3" } }), error: "超过" },
  { name: "MIME 不支持", response: () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }), error: "格式" },
  { name: "MIME 与扩展名不同", response: () => new Response("abc", { headers: { "content-type": "image/jpeg" } }), error: "格式" },
  { name: "响应截断", response: () => new Response("ab", { headers: { "content-type": "image/png", "content-length": "3" } }), error: "不一致" },
  { name: "响应为空", response: () => new Response("", { headers: { "content-type": "image/png" } }), error: "为空" },
])("素材下载 $name 不写入页面或项目引用，并保留可重试面板", async ({ response, error }) => {
  const fetch = vi.fn().mockResolvedValueOnce(libraryResponse()).mockResolvedValueOnce(response()); vi.stubGlobal("fetch", fetch);
  const work = await mount(), before = JSON.stringify(work.state().documents); await open(work); await click(button(panel(work), "cup.png"));
  expectUnchanged(work, before); expect(readers).toHaveLength(0);
  expect(panel(work).querySelector('[role="alert"]')?.textContent).toContain(error); expect(button(panel(work), "cup.png").disabled).toBe(false);
});

it.each([
  { name: "列表大小超限", response: () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(DESIGN_LIBRARY_BYTES + 1) } }), error: "超过" },
  { name: "列表 MIME 不符", response: () => new Response(JSON.stringify({ assets: [asset] }), { headers: { "content-type": "text/html" } }), error: "格式无效" },
])("$name 不提供可点击素材，且可刷新重试", async ({ response, error }) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(libraryResponse()));
  const work = await mount(), before = JSON.stringify(work.state().documents); await open(work);
  expectUnchanged(work, before); expect(panel(work).querySelector(".design-asset-grid")).toBeNull();
  expect(panel(work).querySelector('[role="alert"]')?.textContent).toContain(error);
  await click(button(panel(work), "刷新素材库")); expect(button(panel(work), "cup.png").disabled).toBe(false);
});
