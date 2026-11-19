// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNleProject, parseProject } from "@glintai/scenescript";
import { ProjectGitPanel } from "./ProjectGitPanel";
import { captureGit, gitSignature, readGitSnapshot, type GitProject, type ProjectGitProps, type ProjectWorkspace } from "./project-git-client";
import { captureProjectWorkspace } from "./project-git-storage";
import { designDocumentsKey } from "./design-artifacts";
import { projectBrandKey, projectBrandRaw } from "./design-brand";
import { projectAssetsKey } from "./design-assets";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseProject({ schemaVersion: 1, id: "git-panel", title: "当前工程", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "标题", narration: { text: "旁白", durationMs: 1000 } }] });
const older = { ...project, title: "历史工程" };
function workspace(projectId = project.id, label = "当前附件"): ProjectWorkspace {
  return { version: 1, projectId, designs: { version: 1, projectId, activeId: "design", documents: [{ id: "design", title: label, kind: "page", updatedAt: 1, activePageId: "page", pages: [{ id: "page", title: label, html: `<main>${label}</main>`, notes: "备注", annotations: [{ id: "mark", x: 1, y: 2, text: label, createdAt: 1 }] }] }] }, brand: { name: label, accent: "#abcdef", bg: "#000000", text: "#ffffff" }, assets: [{ name: "cover.png", url: "/assets/cover.png", bytes: 10 }] };
}
const documents = [{ id: "script", title: "脚本", kind: "script" as const, content: "正文", updatedAt: 1760000000000 }];
const version = (id: string, current = false, deleted = false) => ({ id, parent: id === "first" ? null : "first", parents: id === "first" ? [] : ["first"], message: id === "head" ? "最新版本" : "开场调整", at: 1760000000000, current, deleted });
let root: Root | undefined, container: HTMLDivElement;
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });
function fixture(returnedWorkspace?: ProjectWorkspace) {
  let dirty = true, current = "head";
  const versions = [version("head", true), version("first")];
  const attachment = (copy = false) => returnedWorkspace === undefined ? {} : { workspace: copy ? { ...returnedWorkspace, projectId: "copy-id", designs: { ...returnedWorkspace.designs, projectId: "copy-id" } } : returnedWorkspace };
  const status = () => ({ current, versionCount: versions.length, changedFiles: dirty ? [{ path: "project.json", status: "M" }] : [], mediaRefs: ["media/引用.mp4"], mediaPolicy: "references-only" });
  const request = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => {
    if (input.operation === "open") return { ok: true, ...status() };
    if (input.operation === "status") return { ok: true, ...status() };
    if (input.operation === "history") return { ok: true, versions: versions.filter(item => input.includeDeleted || !item.deleted), more: false, deletedCount: versions.filter(item => item.deleted).length };
    if (input.operation === "diff") return { ok: true, files: input.version || dirty ? [{ path: "project.json", status: "M", before: JSON.stringify(project), after: JSON.stringify(input.version ? older : project) }] : [] };
    if (input.operation === "commit") { dirty = false; return { ok: true, version: version("saved"), current, status: status() }; }
    if (input.operation === "checkout") { current = String(input.version); return { ok: true, project: older, documents, ...attachment() }; }
    if (input.operation === "copy") return { ok: true, projectId: "copy-id", project: { ...older, id: "copy-id" }, documents, ...attachment(true) };
    if (input.operation === "discard") { dirty = false; return { ok: true, project, documents, ...attachment() }; }
    if (input.operation === "deleteVersions" || input.operation === "recoverVersions") { for (const item of versions) if ((input.versions as string[]).includes(item.id)) item.deleted = input.operation === "deleteVersions"; return { ok: true }; }
    throw new Error(`未支持的测试操作 ${String(input.operation)}`);
  });
  Object.assign(window, { glintDesktop: { request } });
  return { request, versions };
}
async function mount(overrides: Partial<ProjectGitProps> = {}) {
  const onApply = vi.fn<(...args: unknown[]) => void | boolean>(), onCopy = vi.fn(), onClose = vi.fn();
  const base: ProjectGitProps = { project, documents, kind: "scene", onApply, onCopy, onClose, ...overrides };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const render = async (next: GitProject = base.project, nextProps: Partial<ProjectGitProps> = {}) => { await act(async () => root!.render(createElement(ProjectGitPanel, { ...base, project: next, ...nextProps }))); };
  await render(); return { render, onApply, onCopy, onClose };
}
const buttons = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].filter(item => item.textContent === text);
const button = (text: string) => { const result = buttons(text)[0]; if (!result) throw new Error(`找不到按钮 ${text}`); return result; };
const click = async (text: string) => { await act(async () => button(text).click()); };
const input = async (selector: string, value: string) => { await act(async () => { const element = container.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); };
const check = async (selector: string) => { await act(async () => container.querySelector<HTMLInputElement>(selector)!.click()); };
const history = async () => { await click("历史版本"); await act(async () => container.querySelectorAll<HTMLButtonElement>(".pg-version")[1]!.click()); };
const calls = (host: ReturnType<typeof fixture>, operation: string) => host.request.mock.calls.filter(([call]) => call.operation === operation);

describe("Git 面板桥接与真实交互", () => {
  it("loads native status/current diff with project/documents and never auto commits", async () => {
    const host = fixture(); await mount();
    expect(calls(host, "open")[0]![0]).toMatchObject({ action: "git", projectId: project.id, kind: "scene", snapshot: project, documents });
    expect(container.textContent).toContain("1 个文件有改动"); expect(container.textContent).toContain("project.json");
    expect(calls(host, "commit")).toHaveLength(0); expect(calls(host, "diff")[0]![0].version).toBeUndefined();
    await act(async () => container.querySelector("summary")!.click()); expect(container.querySelector("details")!.open).toBe(true); expect(container.textContent).toContain("修改前");
  });
  it("saves only after explicit click and blocks double clicks without losing document data", async () => {
    const host = fixture(); await mount(); await input("#pg-version-name", "字幕 / 修订 & 完成");
    await act(async () => { button("保存版本").click(); button("保存版本").click(); });
    expect(calls(host, "commit")).toHaveLength(1); expect(calls(host, "commit")[0]![0]).toMatchObject({ message: "字幕 / 修订 & 完成", snapshot: project, documents });
    expect(container.textContent).toContain("版本已保存到本机 Git"); expect(container.querySelector<HTMLInputElement>("#pg-version-name")!.value).toBe("");
  });
  it("preserves the version name on failure and retries only on another explicit click", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!; let fail = true;
    host.request.mockImplementation(async call => call.operation === "commit" && fail ? { ok: false, error: { code: "WRITE_FAILED", message: "Git 写入失败" } } : original(call));
    await mount(); await input("#pg-version-name", "不要丢的版本名"); await click("保存版本");
    expect(container.textContent).toContain("Git 写入失败"); expect(container.querySelector<HTMLInputElement>("#pg-version-name")!.value).toBe("不要丢的版本名"); expect(calls(host, "commit")).toHaveLength(1);
    fail = false; await click("保存版本"); expect(calls(host, "commit")).toHaveLength(2); expect(container.textContent).toContain("版本已保存");
  });
  it("saves current before checkout and applies returned project/documents only after confirmation", async () => {
    const host = fixture(), h = await mount(); await history();
    expect(container.textContent).toContain("历史工程"); await click("恢复此版本");
    expect(calls(host, "commit")[0]![0]).toMatchObject({ message: "恢复前保存", snapshot: project, documents });
    const order = host.request.mock.calls.map(([call]) => call.operation); expect(order.indexOf("commit")).toBeLessThan(order.indexOf("checkout"));
    expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("确认后才替换编辑区");
    await click("确认恢复到编辑区"); expect(h.onApply).toHaveBeenCalledWith(older, documents); expect(h.onApply).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("版本已恢复到编辑区");
  });
  it("does not checkout when saving current fails, keeps original editor and retry affordance", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async call => call.operation === "commit" ? { ok: false, error: { code: "DISK_FULL", message: "本机空间不足" } } : original(call));
    const h = await mount(); await history(); await click("恢复此版本");
    expect(calls(host, "checkout")).toHaveLength(0); expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("本机空间不足"); expect(button("恢复此版本").disabled).toBe(false);
  });
  it("copies only after confirmation and never replaces the original project", async () => {
    const host = fixture(), h = await mount(); await history(); await click("复制为新工程"); expect(calls(host, "copy")).toHaveLength(0);
    await click("取消操作"); expect(h.onCopy).not.toHaveBeenCalled(); await click("复制为新工程"); await click("确认创建副本");
    expect(h.onCopy).toHaveBeenCalledWith({ ...older, id: "copy-id" }, documents); expect(h.onCopy).toHaveBeenCalledTimes(1); expect(h.onApply).not.toHaveBeenCalled(); expect(calls(host, "copy")[0]![0].version).toBe("first");
  });
  it("hides versions and recovers their records without checkout or destructive repo deletion", async () => {
    const host = fixture(); await mount(); await history(); await act(async () => buttons("删除")[1]!.click()); await click("确认删除记录");
    expect(calls(host, "deleteVersions")[0]![0].versions).toEqual(["first"]); expect(container.textContent).toContain("Git 提交与素材文件未删除");
    await check(".pg-check input"); await click("找回"); await click("确认找回版本");
    expect(calls(host, "recoverVersions")[0]![0].versions).toEqual(["first"]); expect(calls(host, "checkout")).toHaveLength(0); expect(container.textContent).toContain("版本已找回");
  });
  it("requires explicit discard confirmation and does not discard on cancel", async () => {
    const host = fixture(), h = await mount(); await click("放弃当前改动"); await click("取消操作"); expect(calls(host, "discard")).toHaveLength(0);
    await click("放弃当前改动"); await click("确认放弃改动"); expect(calls(host, "discard")).toHaveLength(1); expect(h.onApply).toHaveBeenCalledWith(project, documents); expect(h.onApply).toHaveBeenCalledTimes(1);
  });
  it("shows permission errors with a read-only retry and never asks for credentials", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!; let fail = true;
    host.request.mockImplementation(async call => call.operation === "open" && fail ? { ok: false, error: { code: "UNAUTHORIZED", message: "未授权访问本地 Git" } } : original(call));
    await mount(); expect(container.textContent).toContain("未授权访问本地 Git"); expect(button("保存版本").disabled).toBe(true);
    fail = false; await click("重新读取版本"); expect(container.textContent).toContain("1 个文件有改动"); expect(calls(host, "commit")).toHaveLength(0);
  });
  it("explains native-only mode and never uses HTTP as a fallback", async () => {
    delete (window as Window & { glintDesktop?: unknown }).glintDesktop; const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); await mount();
    expect(container.textContent).toContain("本地 Git 仅在桌面版可用"); expect(fetch).not.toHaveBeenCalled(); expect(buttons("保存版本")).toHaveLength(0);
  });
  it("switches diff modes and filters the history by readable metadata", async () => {
    const host = fixture(); await mount(); await history(); expect(calls(host, "diff").at(-1)![0].version).toBe("first");
    await click("查看当前未保存改动"); expect(calls(host, "diff").at(-1)![0].version).toBeUndefined(); expect(container.textContent).toContain("不是所选历史版本的内容");
    await click("与父版本比较"); await input('input[type="search"]', "不存在" ); expect(container.textContent).toContain("没有匹配的版本");
    await input('input[type="search"]', "开场"); expect(container.querySelectorAll(".pg-history li")).toHaveLength(1);
  });
  it("handles escape, no accidental Enter save, and default time-based naming", async () => {
    const host = fixture(), h = await mount();
    await act(async () => container.querySelector("#pg-version-name")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(calls(host, "commit")).toHaveLength(0); await click("保存版本"); expect(calls(host, "commit")[0]![0].message).toMatch(/^保存于 /);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(h.onClose).toHaveBeenCalledTimes(1);
  });
  it("refuses stale restore application if editor changed during the confirmation", async () => {
    fixture(); const h = await mount(); await history(); await click("恢复此版本"); await h.render({ ...project, title: "更新中的工程" }); await click("确认恢复到编辑区");
    expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("编辑区在操作期间有新修改");
  });
  it("rejects malformed host snapshots instead of applying wrong project identity", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!; host.request.mockImplementation(async call => call.operation === "checkout" ? { ok: true, project: { ...older, id: "other" }, documents } : original(call));
    const h = await mount(); await history(); await click("恢复此版本"); expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("返回内容属于其他工程");
  });
  it("supports NLE with the same desktop contract", async () => {
    const host = fixture(), nle = parseNleProject({ schemaVersion: 1, id: "nle-git", title: "剪辑工程", width: 1920, height: 1080, fps: 30, tracks: [] });
    await mount({ project: nle, kind: "nle" }); await click("保存版本"); expect(calls(host, "commit")[0]![0]).toMatchObject({ projectId: nle.id, kind: "nle", snapshot: nle });
  });
});

const mutateWorkspace = (value: ProjectWorkspace, field: string) => {
  if (field === "brand") value.brand!.name = "另一个品牌";
  if (field === "assets") value.assets = [{ name: "other.jpg", url: "/api/media/assets/other.jpg", bytes: 11 }];
  if (field === "design") value.designs.documents[0]!.pages[0]!.html += "<p>新草稿</p>";
};
function diskWorkspace(value: ProjectWorkspace) {
  localStorage.setItem(designDocumentsKey(value.projectId), JSON.stringify(value.designs));
  if (value.brand === null) localStorage.removeItem(projectBrandKey(value.projectId));
  else localStorage.setItem(projectBrandKey(value.projectId), projectBrandRaw(value.brand));
  localStorage.setItem(projectAssetsKey(value.projectId), JSON.stringify(value.assets));
}

describe("Git 面板 workspace 透传与兼容性", () => {
  it("capture/open 与显式 commit 传递完整附件，并冻结请求数据不共享可变草稿", async () => {
    const host = fixture(), value = workspace(), expected = captureGit(value);
    await mount({ workspace: value }); expect(calls(host, "open")[0]![0]).toMatchObject({ snapshot: project, documents, workspace: expected });
    expect(calls(host, "open")[0]![0].workspace).not.toBe(value);
    await click("保存版本"); expect(calls(host, "commit")[0]![0]).toMatchObject({ workspace: expected });
    mutateWorkspace(value, "design"); expect(calls(host, "open")[0]![0].workspace).toEqual(expected); expect(calls(host, "commit")[0]![0].workspace).toEqual(expected);
  });
  it("恢复前备份包含当前 workspace，确认恢复回调接收历史 workspace 第三参", async () => {
    const saved = workspace(project.id, "历史附件"), current = workspace(), host = fixture(saved), h = await mount({ workspace: current });
    await history(); await click("恢复此版本");
    expect(calls(host, "open").at(-1)![0]).toMatchObject({ workspace: current });
    expect(calls(host, "commit")[0]![0]).toMatchObject({ message: "恢复前保存", snapshot: project, documents, workspace: current });
    expect(h.onApply).not.toHaveBeenCalled(); await click("确认恢复到编辑区");
    expect(h.onApply).toHaveBeenCalledTimes(1); expect(h.onApply).toHaveBeenCalledWith(older, documents, saved); expect(container.textContent).toContain("版本已恢复到编辑区");
  });
  it("copy 回调第三参使用独立工程身份，保留设计和素材引用内容", async () => {
    const saved = workspace(project.id, "历史附件"), host = fixture(saved), h = await mount({ workspace: workspace() });
    await history(); await click("复制为新工程"); expect(calls(host, "copy")).toHaveLength(0); await click("确认创建副本");
    expect(h.onCopy).toHaveBeenCalledTimes(1); expect(h.onCopy).toHaveBeenCalledWith({ ...older, id: "copy-id" }, documents, { ...saved, projectId: "copy-id", designs: { ...saved.designs, projectId: "copy-id" } });
    expect(h.onApply).not.toHaveBeenCalled(); expect(saved.projectId).toBe(project.id);
  });
  it("discard 明确确认后透传当前 Git 版本的完整 workspace", async () => {
    const saved = workspace(project.id, "已保存附件"), host = fixture(saved), h = await mount({ workspace: workspace() });
    await click("放弃当前改动"); expect(calls(host, "discard")).toHaveLength(0); await click("确认放弃改动");
    expect(h.onApply).toHaveBeenCalledTimes(1); expect(h.onApply).toHaveBeenCalledWith(project, documents, saved); expect(container.textContent).toContain("未保存改动已放弃");
  });
  it.each(["restore", "copy", "discard"])("旧版 %s 缺 workspace 时仍只调用两个参数，不传空附件清数据", async operation => {
    fixture(); const h = await mount({ workspace: workspace() });
    if (operation === "discard") { await click("放弃当前改动"); await click("确认放弃改动"); }
    else { await history(); await click(operation === "copy" ? "复制为新工程" : "恢复此版本"); await click(operation === "copy" ? "确认创建副本" : "确认恢复到编辑区"); }
    const callback = operation === "copy" ? h.onCopy : h.onApply;
    expect(callback).toHaveBeenCalledTimes(1); expect(callback.mock.calls[0]).toHaveLength(2); expect(callback.mock.calls[0]![1]).toEqual(documents);
  });
  it.each(["brand", "assets", "design"])("确认恢复期间只有 %s 变化也拒绝覆盖", async field => {
    fixture(workspace(project.id, "历史附件")); const initial = workspace(), h = await mount({ workspace: initial });
    await history(); await click("恢复此版本"); const changed = captureGit(initial); mutateWorkspace(changed, field);
    await h.render(project, { workspace: changed }); await click("确认恢复到编辑区");
    expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("编辑区在操作期间有新修改"); expect(container.textContent).not.toContain("版本已恢复到编辑区。");
  });
  it.each(["brand", "assets", "design"])("getWorkspace 检出确认期间磁盘 %s 变化，无需 React rerender", async field => {
    fixture(workspace(project.id, "历史附件")); const initial = workspace(); diskWorkspace(initial);
    const getWorkspace = vi.fn(() => captureProjectWorkspace(project.id)), h = await mount({ getWorkspace });
    await history(); await click("恢复此版本"); const changed = captureGit(initial); mutateWorkspace(changed, field); diskWorkspace(changed);
    await click("确认恢复到编辑区"); expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("编辑区在操作期间有新修改");
  });
  it("异步保存请求中的 workspace 已深拷贝，之后原地改品牌不能篡改备份", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!, value = workspace(), before = captureGit(value);
    let finish!: () => void;
    host.request.mockImplementation(call => call.operation === "commit" ? new Promise(resolve => { finish = () => { void original(call).then(resolve); }; }) : original(call));
    await mount({ getWorkspace: () => value }); await click("保存版本"); mutateWorkspace(value, "brand");
    expect(calls(host, "commit")[0]![0].workspace).toEqual(before);
    await act(async () => finish()); expect(container.textContent).toContain("版本已保存到本机 Git"); expect(container.textContent).toContain("编辑区有更新");
  });
  it("恢复前备份等待期间只有磁盘附件变化，也不得继续 checkout", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!, value = workspace(); diskWorkspace(value);
    let finish!: () => void;
    host.request.mockImplementation(call => call.operation === "commit" ? new Promise(resolve => { finish = () => { void original(call).then(resolve); }; }) : original(call));
    const h = await mount({ getWorkspace: () => captureProjectWorkspace(project.id) }); await history(); await click("恢复此版本");
    mutateWorkspace(value, "assets"); diskWorkspace(value); await act(async () => finish());
    expect(calls(host, "checkout")).toHaveLength(0); expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("编辑区在操作期间有新修改");
  });
  it("getWorkspace 优先于陈旧 prop，每次 open、commit 和备份实时捕获磁盘", async () => {
    const host = fixture(workspace(project.id, "历史附件")), current = workspace(); diskWorkspace(current);
    await mount({ workspace: workspace(project.id, "陈旧 prop"), getWorkspace: () => captureProjectWorkspace(project.id) });
    expect(calls(host, "open")[0]![0].workspace).toEqual(current);
    const changed = workspace(project.id, "磁盘新附件"); diskWorkspace(changed); await click("保存版本");
    expect(calls(host, "commit")[0]![0].workspace).toEqual(changed);
    mutateWorkspace(changed, "assets"); diskWorkspace(changed); await history(); await click("恢复此版本");
    expect(calls(host, "open").at(-1)![0].workspace).toEqual(changed);
  });
  it("getWorkspace 读盘失败时不提交、不 checkout，也不报告成功", async () => {
    const host = fixture(), getWorkspace = vi.fn(() => workspace()); await mount({ getWorkspace });
    getWorkspace.mockImplementation(() => { throw new Error("固定品牌损坏"); }); await click("保存版本");
    expect(calls(host, "commit")).toHaveLength(0); expect(container.textContent).toContain("固定品牌损坏"); expect(container.textContent).not.toContain("版本已保存到本机 Git。");
    await history(); await click("恢复此版本"); expect(calls(host, "checkout")).toHaveLength(0);
  });
  it.each(["brand", "assets", "design"])("discard 确认期间磁盘只有 %s 变化，不能发送 discard 或调用回调", async field => {
    const host = fixture(workspace(project.id, "历史附件")), initial = workspace(); diskWorkspace(initial);
    const h = await mount({ getWorkspace: () => captureProjectWorkspace(project.id) }); await click("放弃当前改动");
    mutateWorkspace(initial, field); diskWorkspace(initial); await click("确认放弃改动");
    expect(calls(host, "discard")).toHaveLength(0); expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("未保存改动已放弃，已回到当前 Git 版本。");
  });
  it("discard 请求等待期间磁盘再变化也拒绝应用返回值", async () => {
    const host = fixture(workspace(project.id, "历史附件")), original = host.request.getMockImplementation()!, initial = workspace(); diskWorkspace(initial);
    let finish!: (value: unknown) => void;
    host.request.mockImplementation(call => call.operation === "discard" ? new Promise(resolve => { finish = resolve; }) : original(call));
    const h = await mount({ getWorkspace: () => captureProjectWorkspace(project.id) }); await click("放弃当前改动"); await click("确认放弃改动");
    mutateWorkspace(initial, "brand"); diskWorkspace(initial);
    await act(async () => finish({ ok: true, project, documents, workspace: workspace(project.id, "历史附件") }));
    expect(h.onApply).not.toHaveBeenCalled(); expect(container.textContent).toContain("编辑区在操作期间有新修改");
  });
  it.each(["restore", "copy", "discard"])("%s 的 callback false 不得报告成功", async operation => {
    fixture(workspace(project.id, "历史附件")); const rejected = vi.fn<ProjectGitProps["onApply"]>(() => false);
    await mount({ workspace: workspace(), onApply: rejected, onCopy: rejected });
    if (operation === "discard") { await click("放弃当前改动"); await click("确认放弃改动"); }
    else { await history(); await click(operation === "copy" ? "复制为新工程" : "恢复此版本"); await click(operation === "copy" ? "确认创建副本" : "确认恢复到编辑区"); }
    expect(rejected).toHaveBeenCalledTimes(1); expect(rejected.mock.calls[0]).toHaveLength(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/未接受|没有接受/);
    expect(container.querySelector(".pg-notice")?.textContent ?? "").not.toMatch(/版本已恢复到编辑区|已创建独立工程副本|未保存改动已放弃/);
  });
  it.each(["checkout", "copy", "discard"])("%s 返回非法 workspace 时不触发编辑器回调", async operation => {
    const host = fixture(), original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async call => call.operation === operation ? { ok: true, project: operation === "copy" ? { ...older, id: "copy-id" } : older, documents, workspace: workspace("foreign") } : original(call));
    const h = await mount({ workspace: workspace() });
    if (operation === "discard") { await click("放弃当前改动"); await click("确认放弃改动"); }
    else { await history(); await click(operation === "copy" ? "复制为新工程" : "恢复此版本"); if (operation === "copy") await click("确认创建副本"); }
    expect(h.onApply).not.toHaveBeenCalled(); expect(h.onCopy).not.toHaveBeenCalled(); expect(container.textContent).toContain("工程附件不属于当前工程");
  });
});

describe("Git client workspace 契约", () => {
  it.each(["brand", "assets", "design"])("签名包含 %s，不只比较工程和脚本", field => {
    const value = workspace(), before = gitSignature(project, documents, value); mutateWorkspace(value, field);
    expect(gitSignature(project, documents, value)).not.toBe(before);
  });
  it("缺 workspace 的旧快照不注入空对象，显式空 workspace 则保留", () => {
    expect(readGitSnapshot({ project, documents }, "scene", project.id)).not.toHaveProperty("workspace");
    const empty: ProjectWorkspace = { version: 1, projectId: project.id, designs: { version: 1, projectId: project.id, documents: [], activeId: "" }, brand: null, assets: [] };
    expect(readGitSnapshot({ project, documents, workspace: empty }, "scene", project.id).workspace).toEqual(empty);
    expect(gitSignature(project, documents)).not.toBe(gitSignature(project, documents, empty));
  });
});
