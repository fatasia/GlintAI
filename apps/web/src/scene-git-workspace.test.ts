// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type ProjectWorkspace, type SceneScriptProject } from "@glintai/scenescript";
import { SceneEditor } from "./SceneEditor";
import { designDocumentsKey } from "./design-artifacts";
import { projectDocumentsKey, readProjectDocuments, type ProjectDocuments } from "./script-documents";
import { projectBrandKey, projectBrandRaw } from "./design-brand";
import { projectAssetsKey } from "./design-assets";
import { captureProjectWorkspace, recoverGitStorage } from "./project-git-storage";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

function workspace(projectId: string, label: string): ProjectWorkspace {
  return {
    version: 1, projectId,
    designs: { version: 1, projectId, activeId: "design", documents: [{
      id: "design", title: `${label}设计`, kind: "page", updatedAt: 1, activePageId: "page",
      pages: [{ id: "page", title: `${label}页面`, html: `<main data-design-id="main">${label}设计正文</main>`, notes: `${label}备注`,
        annotations: [{ id: "mark", x: 12, y: 34, text: `${label}批注`, nodeId: "main", createdAt: 1 }] }],
    }] },
    brand: { name: `${label}品牌`, accent: label === "历史" ? "#123456" : "#abcdef", bg: "#111111", text: "#ffffff", logoText: label },
    assets: [{ name: label === "历史" ? "history.png" : "current.png", url: label === "历史" ? "/assets/history.png" : "/assets/current.png", bytes: 12 }],
  };
}
function scripts(projectId: string, label: string): ProjectDocuments {
  return { version: 1, projectId, activeId: "script", documents: [
    { id: "script", title: `${label}脚本`, kind: "script", content: `${label}脚本正文`, updatedAt: 1 },
    { id: "outline", title: `${label}大纲`, kind: "outline", content: `${label}大纲正文`, updatedAt: 2 },
  ] };
}
const attachmentKeys = (id: string) => [projectDocumentsKey(id), designDocumentsKey(id), projectBrandKey(id), projectAssetsKey(id)];
const journalKey = (id: string) => `glint:git-restore.v1:${id}`;
function seed(documents: ProjectDocuments, value: ProjectWorkspace) {
  localStorage.setItem(projectDocumentsKey(value.projectId), JSON.stringify(documents));
  localStorage.setItem(designDocumentsKey(value.projectId), JSON.stringify(value.designs));
  if (value.brand) localStorage.setItem(projectBrandKey(value.projectId), projectBrandRaw(value.brand));
  localStorage.setItem(projectAssetsKey(value.projectId), JSON.stringify(value.assets));
}
function disk() {
  return Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
}
function required<T extends Element>(selector: string, scope: ParentNode = container): T {
  const node = scope.querySelector<T>(selector);
  if (!node) throw new Error(`找不到测试元素 ${selector}`);
  return node;
}
const source = () => required<HTMLTextAreaElement>('[aria-label="页面 HTML 源码"]');
const body = () => required<HTMLTextAreaElement>('[aria-label="脚本文档正文"]');
const panel = () => required<HTMLElement>('[aria-label="Git 版本"]');
function button(text: string, scope: ParentNode = container) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text);
  if (!node) throw new Error(`找不到测试按钮 ${text}`);
  return node;
}
async function click(text: string, scope: ParentNode = container) {
  expect(button(text, scope).disabled, `按钮 ${text} 应可操作`).toBe(false);
  await act(async () => button(text, scope).click());
}
async function edit(node: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function loaded(selector: string) {
  for (let i = 0; i < 200 && !container.querySelector(selector); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  return required(selector);
}
async function timers() { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
async function closeGit() {
  await act(async () => required<HTMLButtonElement>('.project-git-panel [aria-label="关闭 Git 版本"]').click());
}

function nativeFixture(project: SceneScriptProject, legacy: boolean, empty: boolean) {
  const older = parseProject({ ...project, title: "历史工程", scenes: [{ ...project.scenes[0]!, title: "历史镜头" }] });
  const copyId = `workspace-copy-${crypto.randomUUID()}`;
  const saved = workspace(project.id, "历史");
  if (empty) { saved.designs.documents = []; saved.designs.activeId = ""; saved.brand = null; saved.assets = []; }
  const savedScripts = scripts(project.id, "历史");
  let head = "head";
  const status = () => ({ current: head, versionCount: 2, changedFiles: [{ path: "project.json", status: "M" }], mediaRefs: [], mediaPolicy: "references-only" });
  const version = (id: string) => ({ id, parent: id === "first" ? null : "first", parents: id === "first" ? [] : ["first"],
    message: id === "first" ? "历史版本夹具" : "当前版本夹具", at: 1760000000000, current: id === head, deleted: false });
  const copied = { ...saved, projectId: copyId, designs: { ...saved.designs, projectId: copyId } };
  const request = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => {
    if (input.action !== "git") throw new Error(`不应请求其他 native 功能 ${String(input.action)}`);
    if (input.operation === "open" || input.operation === "status") return { ok: true, ...status() };
    if (input.operation === "history") return { ok: true, versions: [version("head"), version("first")], more: false, deletedCount: 0 };
    if (input.operation === "diff") return { ok: true, files: [{ path: "project.json", status: "M", before: project, after: older }] };
    if (input.operation === "commit") return { ok: true, current: head, status: status() };
    if (input.operation === "checkout") { head = "first"; return { ok: true, project: older, documents: savedScripts.documents, ...(legacy ? {} : { workspace: saved }) }; }
    if (input.operation === "copy") return { ok: true, projectId: copyId, project: { ...older, id: copyId }, documents: savedScripts.documents, ...(legacy ? {} : { workspace: copied }) };
    throw new Error(`未支持的测试操作 ${String(input.operation)}`);
  });
  vi.stubGlobal("glintDesktop", { request });
  return { request, older, saved, savedScripts, copyId, copied,
    calls: (operation: string) => request.mock.calls.filter(([input]) => input.operation === operation).map(([input]) => input) };
}

async function setup(options: { legacy?: boolean; empty?: boolean; changeThrows?: boolean; forkThrows?: boolean;
  onGitAccepted?: (project: SceneScriptProject) => void } = {}) {
  const initial = parseProject({ schemaVersion: 1, id: `workspace-${crypto.randomUUID()}`, title: "当前工程", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "one", kind: "title", title: "当前镜头", narration: { text: "当前旁白", durationMs: 1000 } }] });
  const currentWorkspace = workspace(initial.id, "当前"), currentScripts = scripts(initial.id, "当前");
  seed(currentScripts, currentWorkspace);
  const host = nativeFixture(initial, Boolean(options.legacy), Boolean(options.empty));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [], thumbnails: {}, entries: [] })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  let current = initial;
  let selectProject!: (next: SceneScriptProject) => void;
  const onChange = vi.fn<(next: SceneScriptProject) => void>(() => { if (options.changeThrows) throw new Error("父工程拒绝恢复"); });
  const onFork = vi.fn<(next: SceneScriptProject) => void>(() => { if (options.forkThrows) throw new Error("父工程拒绝副本"); });
  const onGitAccepted = vi.fn<(project: SceneScriptProject) => void>(options.onGitAccepted ?? (() => {}));
  function Harness() {
    const [value, setValue] = useState(initial); current = value; selectProject = setValue;
    return createElement(SceneEditor, { project: value, onChange: next => { onChange(next); setValue(next); }, onFork, onGitAccepted });
  }
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  // 在同一个 act 内立即收起真实预览，不播放媒体、不替换任何内部组件。
  await act(async () => {
    flushSync(() => root!.render(createElement(Harness)));
    flushSync(() => button("收起预览").click());
  });
  await click("设计"); await loaded('[aria-label="设计文档编辑器"]'); await click("HTML 源码");
  const designNode = source();
  await click("脚本"); await loaded('[aria-label="脚本文档正文"]');
  const scriptNode = body();
  expect(designNode.closest("[hidden]")).not.toBeNull();
  await click("设计"); expect(source()).toBe(designNode); expect(scriptNode.closest("[hidden]")).not.toBeNull();
  await click("脚本"); expect(body()).toBe(scriptNode);
  await click("Git 改动与历史…"); await loaded('[aria-label="Git 版本"]');
  await loaded('.pg-history, .pg-commit');
  await click("历史版本", panel());
  await act(async () => required<HTMLButtonElement>(".pg-version", panel().querySelectorAll(".pg-history li")[1]!).click());
  vi.useFakeTimers();
  await edit(designNode, '<main data-design-id="main">待备份设计草稿</main>');
  await edit(scriptNode, "待备份脚本草稿");
  return { ...host, initial, currentWorkspace, currentScripts, designNode, scriptNode, onChange, onFork, onGitAccepted, current: () => current,
    async selectProject(next: SceneScriptProject) {
      await act(async () => {
        flushSync(() => selectProject(next));
        const preview = [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "收起预览");
        if (preview) flushSync(() => preview.click());
      });
    } };

}
async function proposeRestore() {
  await click("恢复此版本", panel());
  expect(required('[aria-label="确认恢复版本"]', panel())).not.toBeNull();
}
function expectRestored(h: Awaited<ReturnType<typeof setup>>) {
  expect(h.current()).toEqual(h.older);
  expect(readProjectDocuments(h.initial.id)).toEqual(h.savedScripts);
  expect(captureProjectWorkspace(h.initial.id)).toEqual(h.saved);
  expect(body()).toBe(h.scriptNode); expect(source()).toBe(h.designNode);
  expect(body().value).toBe("历史脚本正文"); expect(source().value).toBe(h.saved.designs.documents[0]!.pages[0]!.html);
  expect(required<HTMLInputElement>('[aria-label="设计文档标题"]').value).toBe("历史设计");
  expect(container.querySelector('[aria-label="页面批注"]')?.textContent).toContain("历史批注");
  expect(container.querySelector(".design-brand-chip")?.textContent).toContain("历史品牌");
  expect(container.querySelector(".design-error, .script-editor [role=alert]")).toBeNull();
  expect(localStorage.getItem(journalKey(h.initial.id))).toBeNull();
}
function expectRejected(h: Awaited<ReturnType<typeof setup>>, before: ReturnType<typeof disk>, error: RegExp) {
  expect(panel().querySelector('[role="alert"]')?.textContent).toMatch(error);
  expect(panel().querySelector(".pg-notice")?.textContent ?? "").not.toContain("版本已恢复到编辑区");
  expect(h.onChange).not.toHaveBeenCalled(); expect(h.current()).toEqual(h.initial); expect(disk()).toEqual(before);
  expect(source()).toBe(h.designNode); expect(body()).toBe(h.scriptNode);
  expect(source().value).toContain("待备份设计草稿"); expect(body().value).toBe("待备份脚本草稿");
}

describe("真实 SceneEditor Git workspace 集成", () => {
  it("两视图保活：恢复先备份实时草稿，确认后工程与全部附件一致，旧 timer 不得回写", async () => {
    const h = await setup(), before = disk();
    expect(h.calls("commit")).toHaveLength(0);
    expect(h.calls("open")[0]).toMatchObject({ snapshot: h.initial, documents: h.currentScripts.documents, workspace: h.currentWorkspace });
    await proposeRestore();
    expect(h.calls("commit")).toHaveLength(1);
    expect(h.calls("commit")[0]).toMatchObject({ message: "恢复前保存", snapshot: h.initial,
      documents: [expect.objectContaining({ content: "待备份脚本草稿" }), h.currentScripts.documents[1]],
      workspace: { ...h.currentWorkspace, designs: { ...h.currentWorkspace.designs, documents: [expect.objectContaining({ pages: [expect.objectContaining({ html: h.designNode.value })] })] } } });
    const operations = h.request.mock.calls.map(([call]) => call.operation);
    expect(operations.indexOf("commit")).toBeLessThan(operations.indexOf("checkout"));
    expect(h.onChange).not.toHaveBeenCalled(); expect(h.current()).toEqual(h.initial); expect(disk()).toEqual(before);
    expect(body().value).toBe("待备份脚本草稿"); expect(source().value).toContain("待备份设计草稿");
    h.onChange.mockImplementation(() => {
      // journal 此刻尚未 finish，只读取原始附件，不能调用会主动恢复日志的 capture。
      expect(readProjectDocuments(h.initial.id)).toEqual(h.savedScripts);
      expect(JSON.parse(localStorage.getItem(designDocumentsKey(h.initial.id))!)).toEqual(h.saved.designs);
      expect(JSON.parse(localStorage.getItem(projectBrandKey(h.initial.id))!)).toEqual(JSON.parse(projectBrandRaw(h.saved.brand!)));
      expect(JSON.parse(localStorage.getItem(projectAssetsKey(h.initial.id))!)).toEqual(h.saved.assets);
      expect(body().value).toBe("待备份脚本草稿"); expect(source().value).toContain("待备份设计草稿");
    });
    await click("确认恢复到编辑区", panel()); expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(panel().querySelector('[role="alert"]')?.textContent).toBeUndefined(); expectRestored(h);
    const after = disk(); await timers(); expect(disk()).toEqual(after); expectRestored(h);
    await click("图片", required('[aria-label="设计文档编辑器"]'));
    expect(required('[aria-label="插入图片"]', required('[aria-label="设计文档编辑器"]')).textContent).toContain("history.png");
    await closeGit(); await click("设计"); expect(source()).toBe(h.designNode); await click("脚本"); expect(body()).toBe(h.scriptNode);
    expect(required<HTMLButtonElement>('button[aria-label="撤销"]').disabled).toBe(true);
  });

  it.each(["script", "design"] as const)("%s 的 IME 组合输入拒绝确认，不能部分接收另一编辑器或改存储", async field => {
    const h = await setup(); await timers(); await proposeRestore(); const before = disk();
    const node = field === "script" ? body() : source();
    await act(async () => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await click("确认恢复到编辑区", panel()); expectRejected(h, before, /完成中文输入/);
    await timers(); expect(disk()).toEqual(before);
    await act(async () => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await click("确认恢复到编辑区", panel()); expectRestored(h);
  });

  it.each(["script", "design", "brand", "assets"] as const)("%s 附件写失败必须回退全部存储，编辑区不得混版，且可以明确重试", async field => {
    const h = await setup(); await timers(); await proposeRestore(); const before = disk();
    const key = attachmentKeys(h.initial.id)[["script", "design", "brand", "assets"].indexOf(field)]!;
    const original = Storage.prototype.setItem;
    let failed = false;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      if (name === key && !failed) { failed = true; throw new Error(`夹具拒绝写入 ${field}`); }
      return original.call(this, name, value);
    });
    await click("确认恢复到编辑区", panel()); expect(failed).toBe(true);
    expectRejected(h, before, new RegExp(`夹具拒绝写入 ${field}`));
    expect(localStorage.getItem(journalKey(h.initial.id))).toBeNull();
    await timers(); expect(disk()).toEqual(before); write.mockRestore();
    await click("确认恢复到编辑区", panel()); expectRestored(h);
  });

  it.each(["script", "design", "brand", "assets"] as const)("确认期间磁盘 %s 外部变化，即使无事件、无 rerender 也拒绝覆盖", async field => {
    const h = await setup(); await timers(); await proposeRestore();
    const key = attachmentKeys(h.initial.id)[["script", "design", "brand", "assets"].indexOf(field)]!;
    if (field === "script") localStorage.setItem(key, JSON.stringify(scripts(h.initial.id, "外部")));
    if (field === "design") localStorage.setItem(key, JSON.stringify(workspace(h.initial.id, "外部").designs));
    if (field === "brand") localStorage.setItem(key, projectBrandRaw(workspace(h.initial.id, "外部").brand!));
    if (field === "assets") localStorage.setItem(key, JSON.stringify([{ name: "external.png", url: "/assets/external.png", bytes: 9 }]));
    const before = disk();
    // 不派发 storage 事件，也不调用 render；设计内存草稿会遮住磁盘设计，只能靠存储签名检出。
    expect(panel().querySelector('[role="alert"]')).toBeNull();
    await click("确认恢复到编辑区", panel()); expectRejected(h, before, /编辑区在操作期间有新修改/);
    await timers(); expect(disk()).toEqual(before);
  });

  it("legacy 快照缺 workspace 时只恢复工程脚本，保留设计草稿、品牌、素材和批注", async () => {
    const h = await setup({ legacy: true }); await timers(); const before = disk();
    await proposeRestore(); expect(panel().textContent).toContain("此旧版本未记录设计、品牌和素材列表");
    await click("确认恢复到编辑区", panel());
    expect(h.onChange).toHaveBeenCalledTimes(1); expect(h.current()).toEqual(h.older);
    expect(readProjectDocuments(h.initial.id)).toEqual(h.savedScripts);
    for (const key of attachmentKeys(h.initial.id).slice(1)) expect(localStorage.getItem(key)).toBe(before[key]);
    expect(source()).toBe(h.designNode); expect(source().value).toContain("待备份设计草稿"); expect(body().value).toBe("历史脚本正文");
    expect(container.querySelector('[aria-label="页面批注"]')?.textContent).toContain("当前批注");
    const after = disk(); await timers(); expect(disk()).toEqual(after);
  });

  it("显式空 workspace 清空设计品牌素材，安全卸载；再打开不能从 module 草稿复活旧稿", async () => {
    const h = await setup({ empty: true }); await proposeRestore(); await click("确认恢复到编辑区", panel());
    expect(h.current()).toEqual(h.older); expect(readProjectDocuments(h.initial.id)).toEqual(h.savedScripts);
    expect(captureProjectWorkspace(h.initial.id)).toEqual(h.saved);
    expect(container.querySelector('[aria-label="设计文档编辑器"]')).toBeNull(); expect(h.designNode.isConnected).toBe(false);
    expect(body().value).toBe("历史脚本正文"); expect(panel().querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".design-error, .script-editor [role=alert]")).toBeNull();
    const after = disk(); await timers(); expect(disk()).toEqual(after);
    await closeGit(); await click("设计");
    if (!container.querySelector('[aria-label="页面 HTML 源码"]')) await click("HTML 源码");
    expect(source()).not.toBe(h.designNode); expect(source().value).not.toContain("待备份设计草稿"); expect(source().value).not.toContain("当前设计正文");
    expect(container.querySelector('[aria-label="页面批注"]')).toBeNull();
    await timers();
    const reopened = captureProjectWorkspace(h.initial.id);
    expect(reopened.designs.documents.map(document => document.kind)).toEqual(["page", "prototype", "slides"]);
    expect(reopened.designs.documents.every(document => document.id !== "design")).toBe(true);
    expect(reopened.brand).toBeNull(); expect(reopened.assets).toEqual([]);
    expect(JSON.stringify(reopened)).not.toMatch(/待备份设计草稿|当前设计正文|当前批注/);
  });

  it("copy 确认后以独立工程身份持久化全部附件，onFork 收到工程时附件已完整，原工程不变", async () => {
    const h = await setup(); await timers(); await click("刷新改动", panel()); const before = disk();
    let atFork: ReturnType<typeof disk> | undefined;
    h.onFork.mockImplementation(() => { atFork = disk(); });
    await click("复制为新工程", panel()); expect(h.calls("copy")).toHaveLength(0); expect(h.onFork).not.toHaveBeenCalled();
    await click("确认创建副本", panel());
    expect(h.calls("copy")).toHaveLength(1); expect(h.onFork).toHaveBeenCalledTimes(1); expect(h.onFork).toHaveBeenCalledWith({ ...h.older, id: h.copyId });
    expect(readProjectDocuments(h.copyId)).toEqual({ ...h.savedScripts, projectId: h.copyId });
    expect(captureProjectWorkspace(h.copyId)).toEqual(h.copied);
    for (const key of attachmentKeys(h.copyId)) expect(atFork?.[key]).toBe(localStorage.getItem(key));
    for (const [key, value] of Object.entries(before)) expect(localStorage.getItem(key)).toBe(value);
    expect(h.onChange).not.toHaveBeenCalled(); expect(h.current()).toEqual(h.initial); expect(body().value).toBe("待备份脚本草稿"); expect(source().value).toContain("待备份设计草稿");
    expect(localStorage.getItem(journalKey(h.copyId))).toBeNull(); const after = disk(); await timers(); expect(disk()).toEqual(after);
  });

  it("onChange 抛错回退所有附件且不接受子编辑器，后续 timer 不得写入历史版本", async () => {
    const h = await setup({ changeThrows: true }); await timers(); await proposeRestore(); const before = disk();
    await click("确认恢复到编辑区", panel());
    expect(h.onChange).toHaveBeenCalledTimes(1); expect(h.onChange).toHaveBeenCalledWith(h.older);
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain("父工程拒绝恢复");
    expect(h.current()).toEqual(h.initial); expect(disk()).toEqual(before); expect(source()).toBe(h.designNode); expect(body()).toBe(h.scriptNode);
    expect(source().value).toContain("待备份设计草稿"); expect(body().value).toBe("待备份脚本草稿");
    expect(localStorage.getItem(journalKey(h.initial.id))).toBeNull(); await timers(); expect(disk()).toEqual(before);
    expect(h.onGitAccepted).not.toHaveBeenCalled();
    expect(panel().querySelector(".pg-notice")?.textContent ?? "").not.toContain("版本已恢复到编辑区");
  });

  it("onFork 抛错删除此次副本写入的全部附件，不留下 journal 或成功提示", async () => {
    const h = await setup({ forkThrows: true }); await timers(); await click("刷新改动", panel()); const before = disk();
    await click("复制为新工程", panel()); await click("确认创建副本", panel());
    expect(h.onFork).toHaveBeenCalledTimes(1); expect(panel().querySelector('[role="alert"]')?.textContent).toContain("父工程拒绝副本");
    expect(disk()).toEqual(before); for (const key of [...attachmentKeys(h.copyId), journalKey(h.copyId)]) expect(localStorage.getItem(key)).toBeNull();
    expect(h.current()).toEqual(h.initial); expect(h.onChange).not.toHaveBeenCalled(); expect(source().value).toContain("待备份设计草稿"); expect(body().value).toBe("待备份脚本草稿");
    expect(panel().querySelector(".pg-notice")?.textContent ?? "").not.toContain("已创建独立工程副本"); await timers(); expect(disk()).toEqual(before);
    expect(h.onGitAccepted).not.toHaveBeenCalled();
  });
});

const gitProjectKey = (id: string) => `glint:git-project.v1:${id}`;
const readJson = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");
function seedMainProject(project: SceneScriptProject) {
  const value = { mode: "source", text: "保留原资料", template: "explainer", theme: "glint-dark", aspect: project.aspect, project };
  localStorage.setItem("glint.workspace", JSON.stringify(value));
  return value;
}
function expectAcceptedDisk(project: SceneScriptProject, documents: ProjectDocuments, value: ProjectWorkspace) {
  // 不调用 capture：其恢复日志副作用会干扰正在观测的提交阶段。
  expect.soft(readJson(projectDocumentsKey(project.id))).toEqual(documents);
  expect.soft(readJson(designDocumentsKey(project.id))).toEqual(value.designs);
  expect.soft(readJson(projectBrandKey(project.id))).toEqual(value.brand === null ? null : JSON.parse(projectBrandRaw(value.brand)));
  expect.soft(readJson(projectAssetsKey(project.id))).toEqual(value.assets);
  expect.soft(readJson(gitProjectKey(project.id)), "本机完整 JSON 工程必须可恢复").toEqual(project);
  expect.soft(readJson("glint.workspace")?.project, "工作区必须同步持久化已接受的工程").toEqual(project);
}
async function leaveAndReturn(h: Awaited<ReturnType<typeof setup>>) {
  const other = parseProject({ ...h.initial, id: `workspace-away-${crypto.randomUUID()}`, title: "临时离开的工程" });
  await h.selectProject(other);
  await h.selectProject(h.initial);
  expect(container.querySelector('[aria-label="脚本文档正文"]')).toBeNull();
  expect(container.querySelector('[aria-label="设计文档编辑器"]')).toBeNull();
  expect(h.scriptNode.isConnected).toBe(false); expect(h.designNode.isConnected).toBe(false);
  // 全程不推进 timer；存储中仍是初始正文，未保存稿只能来自 module draft。
  expect(readProjectDocuments(h.initial.id)).toEqual(h.currentScripts);
  expect(readJson(designDocumentsKey(h.initial.id))).toEqual(h.currentWorkspace.designs);
  await click("Git 改动与历史…");
  expect(panel()).not.toBeNull();
  await click("历史版本", panel());
  await act(async () => required<HTMLButtonElement>(".pg-version", panel().querySelectorAll(".pg-history li")[1]!).click());
}

describe("新增缺口回归：事务接受与未挂载草稿", () => {
  it.each([
    { operation: "restore", notificationThrows: false }, { operation: "copy", notificationThrows: false },
    { operation: "restore", notificationThrows: true }, { operation: "copy", notificationThrows: true },
  ] as const)("$operation finish 后仅通知一次；登记抛错=$notificationThrows 不回退六类已接受数据", async ({ operation, notificationThrows }) => {
    let atNotification: ReturnType<typeof disk> | undefined;
    const h = await setup({ onGitAccepted(project) {
      atNotification = disk();
      expect.soft(localStorage.getItem(journalKey(project.id)), "通知必须晚于 journal 清理").toBeNull();
      expect.soft(localStorage.getItem("glint:git-active-restore.v1"), "通知必须晚于 active 清理").toBeNull();
      expectAcceptedDisk(project, scripts(project.id, "历史"), workspace(project.id, "历史"));
      if (notificationThrows) throw new Error("夹具拒绝登记已接受工程");
    } });
    const main = seedMainProject(h.initial);
    await timers(); await click("刷新改动", panel()); const before = disk();
    const next = operation === "restore" ? h.older : { ...h.older, id: h.copyId };
    const expectedScripts = { ...h.savedScripts, projectId: next.id }, expectedWorkspace = operation === "restore" ? h.saved : h.copied;
    if (operation === "restore") await proposeRestore();
    else await click("复制为新工程", panel());
    expect(h.onGitAccepted).not.toHaveBeenCalled();
    await click(operation === "restore" ? "确认恢复到编辑区" : "确认创建副本", panel());
    const accept = operation === "restore" ? h.onChange : h.onFork;
    expect(accept).toHaveBeenCalledTimes(1); expect(accept).toHaveBeenCalledWith(next);
    expect(h.onGitAccepted).toHaveBeenCalledTimes(1); expect(h.onGitAccepted).toHaveBeenCalledWith(next);
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(h.onGitAccepted.mock.invocationCallOrder[0]!);
    expect(atNotification).toBeDefined(); expect(disk()).toEqual(atNotification);
    expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
    expect(readJson("glint.workspace")).toEqual({ ...main, project: next });
    expect(panel().querySelector('[role="alert"]')).toBeNull();
    expect(panel().querySelector(".pg-notice")?.textContent).toContain(operation === "restore" ? "版本已恢复到编辑区" : "已创建独立工程副本");
    expect(panel().querySelector('[aria-label="确认恢复版本"], [aria-label="确认 Git 操作"]')).toBeNull();
    const status = container.querySelector(".glint-editor-status")?.textContent ?? "";
    if (notificationThrows) {
      expect(status).toContain(operation === "restore" ? "完整版本已保存到本机" : "完整副本已保存到本机");
      expect(status).toContain("作品列表登记未确认，请在工作区重试");
    } else expect(status).not.toContain("登记未确认");
    if (operation === "restore") { expectRestored(h); expect(h.onFork).not.toHaveBeenCalled(); }
    else {
      expect(h.current()).toEqual(h.initial); expect(h.onChange).not.toHaveBeenCalled();
      for (const [key, value] of Object.entries(before)) if (key !== "glint.workspace") expect(localStorage.getItem(key)).toBe(value);
      expect(source()).toBe(h.designNode); expect(body()).toBe(h.scriptNode);
      expect(source().value).toContain("待备份设计草稿"); expect(body().value).toBe("待备份脚本草稿");
    }
    const after = disk(); await timers(); expect(disk()).toEqual(after);
    expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
    expect(h.onGitAccepted).toHaveBeenCalledTimes(1); expect(h.onGitAccepted).toHaveBeenCalledWith(next);
    if (operation === "restore") expectRestored(h);
  });

  it.each(["restore", "copy"] as const)("%s 回调期间 glint.workspace 和 git-project 必须已是新工程，不等待 600ms", async operation => {
    const h = await setup();
    const before = seedMainProject(h.initial);
    await click("刷新改动", panel());
    const next = operation === "restore" ? h.older : { ...h.older, id: h.copyId };
    let atCallback: ReturnType<typeof disk> | undefined;
    const observe = () => { atCallback = disk(); };
    if (operation === "restore") { h.onChange.mockImplementation(observe); await proposeRestore(); }
    else { h.onFork.mockImplementation(observe); await click("复制为新工程", panel()); }
    await click(operation === "restore" ? "确认恢复到编辑区" : "确认创建副本", panel());
    expect(operation === "restore" ? h.onChange : h.onFork).toHaveBeenCalledTimes(1);
    expect.soft(JSON.parse(atCallback?.["glint.workspace"] ?? "null"), "回调内应立即读到新工程，并保留工作区资料").toEqual({ ...before, project: next });
    expect.soft(JSON.parse(atCallback?.[gitProjectKey(next.id)] ?? "null"), "回调前必须保存独立编号的完整工程 JSON").toEqual(next);
    expectAcceptedDisk(next, { ...h.savedScripts, projectId: next.id }, operation === "restore" ? h.saved : h.copied);
  });

  it.each(["restore", "copy"] as const)("%s 已接受后 journal removeItem 持续失败不能回滚，恢复日志后主工程与全部附件仍一致", async operation => {
    const h = await setup(); seedMainProject(h.initial);
    await click("刷新改动", panel());
    const next = operation === "restore" ? h.older : { ...h.older, id: h.copyId };
    const expectedScripts = { ...h.savedScripts, projectId: next.id }, expectedWorkspace = operation === "restore" ? h.saved : h.copied;
    let accepted: SceneScriptProject | undefined;
    const observe = (project: SceneScriptProject) => { accepted = project; };
    if (operation === "restore") { h.onChange.mockImplementation(observe); await proposeRestore(); }
    else { h.onFork.mockImplementation(observe); await click("复制为新工程", panel()); }
    const removeItem = Storage.prototype.removeItem;
    let cleanupFailures = 0;
    h.onGitAccepted.mockImplementation(project => {
      // 清理警告不阻止通知；上层负责检查日志，这里只读取原始存储确认提交未回退。
      expect.soft(cleanupFailures, "通知前 finish 必须已经尝试清理").toBeGreaterThan(0);
      expect.soft(project).toEqual(next); expect.soft(accepted).toEqual(next);
      expect.soft(readJson(journalKey(next.id))).toMatchObject({ version: 2, projectId: next.id, state: "committed" });
      expect.soft(localStorage.getItem("glint:git-active-restore.v1")).toBe(next.id);
      expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
    });
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      if (accepted && key === journalKey(next.id)) { cleanupFailures++; throw new Error("夹具拒绝清理已接受的 journal"); }
      return removeItem.call(this, key);
    });
    await click(operation === "restore" ? "确认恢复到编辑区" : "确认创建副本", panel());
    expect(accepted).toEqual(next); expect(cleanupFailures).toBeGreaterThan(0);
    expect(h.onGitAccepted).toHaveBeenCalledTimes(1); expect(h.onGitAccepted).toHaveBeenCalledWith(next);
    expect(operation === "restore" ? h.onChange : h.onFork).toHaveBeenCalledTimes(1);
    expect.soft(h.current()).toEqual(operation === "restore" ? next : h.initial);
    expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
    if (operation === "restore") {
      expect.soft(body().value, "工程已接受后脚本不能仍是旧稿").toBe("历史脚本正文");
      expect.soft(source().value, "工程已接受后设计不能仍是旧稿").toBe(h.saved.designs.documents[0]!.pages[0]!.html);
    }
    await timers(); expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
    remove.mockRestore();
    expect.soft(() => recoverGitStorage(next.id), "清理权限恢复后必须能完成已接受事务的日志恢复").not.toThrow();
    expect.soft(localStorage.getItem(journalKey(next.id))).toBeNull();
    expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
    // 模拟以本机完整工程快照重挂，不能靠仍在内存里的父工程掩盖磁盘不一致。
    const stored = readJson(gitProjectKey(next.id));
    expect(stored, "缺少主工程快照时不能跳过重挂验证").toEqual(next);
    await h.selectProject(parseProject({ ...h.initial, id: `workspace-recover-${crypto.randomUUID()}` }));
    await h.selectProject(parseProject(stored));
    await click("脚本"); expect.soft(body().value).toBe("历史脚本正文");
    await click("设计"); await click("HTML 源码"); expect.soft(source().value).toBe(expectedWorkspace.designs.documents[0]!.pages[0]!.html);
    await timers(); expectAcceptedDisk(next, expectedScripts, expectedWorkspace);
  });

  it("重挂未访问子编辑器时 Git open 与恢复前备份仍捕获两类 module dirty 草稿", async () => {
    const h = await setup();
    await leaveAndReturn(h);
    expect.soft(h.calls("open").at(-1)).toMatchObject({ documents: [expect.objectContaining({ content: "待备份脚本草稿" }), h.currentScripts.documents[1]],
      workspace: { designs: { documents: [expect.objectContaining({ pages: [expect.objectContaining({ html: '<main data-design-id="main">待备份设计草稿</main>' })] })] } } });
    await proposeRestore();
    expect.soft(h.calls("commit").at(-1)).toMatchObject({ message: "恢复前保存", snapshot: h.initial,
      documents: [expect.objectContaining({ content: "待备份脚本草稿" }), h.currentScripts.documents[1]],
      workspace: { designs: { documents: [expect.objectContaining({ pages: [expect.objectContaining({ html: '<main data-design-id="main">待备份设计草稿</main>' })] })] } } });
    expect(container.querySelector('[aria-label="脚本文档正文"]')).toBeNull(); expect(container.querySelector('[aria-label="设计文档编辑器"]')).toBeNull();
    await click("保留当前编辑区", panel()); await closeGit();
    await click("脚本"); expect(body().value).toBe("待备份脚本草稿");
    await click("设计"); await click("HTML 源码"); expect(source().value).toContain("待备份设计草稿");
  });

  it.each([false, true])("未挂载 dirty 草稿恢复后再打开不能复活；显式 empty=%s", async empty => {
    const h = await setup({ empty });
    if (empty) { h.savedScripts.documents = []; h.savedScripts.activeId = ""; }
    await leaveAndReturn(h); await proposeRestore(); await click("确认恢复到编辑区", panel());
    expect(h.onChange).toHaveBeenCalledTimes(1); expect(h.current()).toEqual(h.older);
    expect.soft(readProjectDocuments(h.initial.id)).toEqual(h.savedScripts);
    expect.soft(readJson(designDocumentsKey(h.initial.id))).toEqual(h.saved.designs);
    expect(container.querySelector('[aria-label="脚本文档正文"]')).toBeNull(); expect(container.querySelector('[aria-label="设计文档编辑器"]')).toBeNull();
    await timers();
    expect.soft(readProjectDocuments(h.initial.id)).toEqual(h.savedScripts); expect.soft(readJson(designDocumentsKey(h.initial.id))).toEqual(h.saved.designs);
    await closeGit(); await click("脚本");
    expect.soft(body().value, "未挂载脚本的 module dirty 必须被恢复替换或显式清除").not.toContain("待备份脚本草稿");
    if (!empty) expect.soft(body().value).toBe("历史脚本正文");
    await click("设计"); await click("HTML 源码");
    expect.soft(source().value, "未挂载设计的 module dirty 必须被恢复替换或显式清除").not.toContain("待备份设计草稿");
    if (!empty) expect.soft(source().value).toBe(h.saved.designs.documents[0]!.pages[0]!.html);
    else expect.soft(container.querySelector('[aria-label="页面批注"]')).toBeNull();
    await timers();
    expect.soft(JSON.stringify(readProjectDocuments(h.initial.id))).not.toContain("待备份脚本草稿");
    expect.soft(JSON.stringify(readJson(designDocumentsKey(h.initial.id)))).not.toContain("待备份设计草稿");
  });
});
