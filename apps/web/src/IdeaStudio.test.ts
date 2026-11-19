// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTimeline } from "@glintai/scenescript";
import { IdeaStudio } from "./IdeaStudio";
import { parseEditorProject } from "./editor-model";
import { captureStyleTokens } from "./style-snapshot";
import { prepareGitStorage, type GitStorage } from "./project-git-storage";
import { pendingScriptDrafts, pendingDesignDrafts } from "./authoring-drafts";
import { registerAuthoringLeaveGuard } from "./authoring-leave";
import { rememberLocalGitSource } from "./git-local-works";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => {
  dispose();
  localStorage.clear();
  pendingScriptDrafts.clear(); pendingDesignDrafts.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function mount() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  dispose = () => {
    act(() => root.unmount());
    div.remove();
  };
  await act(async () => {
    root.render(createElement(IdeaStudio, { cardStyle: {} }));
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let attempt = 0; attempt < 20 && div.textContent?.includes("正在打开工程…"); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  }
  return div;
}
it("restores a lost POST receipt using requestId, without replaying paid work", async () => {
  localStorage.setItem("glint.last-job:request", "request-1234");
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => _url === "/api/media/library" ? Response.json({ assets: [] }) : _url === "/api/health" ? Response.json({ voices: ["mock", "edge"] }) : new Response(
        JSON.stringify({
          id: "idea-recovered",
          status: "done",
          stage: "done",
          log: [],
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await mount();
  expect(fetch.mock.calls.filter(([url]) => url.startsWith("/api/make"))[0]![0]).toBe("/api/make/request/request-1234");
  // QuickVideo probes the text-model capability on mount; it is not part of job recovery.
  expect(fetch.mock.calls.filter(([url]) => url !== "/api/settings/llm")).toHaveLength(3);
  expect(localStorage.getItem("glint.last-job")).toBe("idea-recovered");
  expect(localStorage.getItem("glint.last-job:request")).toBeNull();
});
it("pauses a failed lookup and retries GET only when requested", async () => {
  localStorage.setItem("glint.last-job:request", "request-1234");
  let queries = 0;
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices: ["mock", "edge"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/settings/llm") return Response.json({ configured: false });
    if (++queries === 1) return new Response("{}", { status: 404 });
    return Response.json({ id: "idea-recovered", status: "done", log: [] });
  });
  vi.stubGlobal("fetch", fetch);
  const div = await mount();
  const resume = div.querySelector<HTMLButtonElement>(".home-resume")!;
  expect(resume.textContent).toContain("继续进行中的任务");
  await act(async () => { resume.click(); await import("./IdeaStudioWorkspace"); });
  expect(div.textContent).toContain("回执未确认");
  const button = [...div.querySelectorAll("button")].find(
    (x) => x.textContent === "恢复查询",
  )!;
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(fetch.mock.calls.filter(([url]) => url === "/api/make/request/request-1234")).toHaveLength(2);
  expect(fetch.mock.calls.every((call) => !call[1]?.method)).toBe(true);
});
const editedProject = { schemaVersion: 1, id: "editor-test", title: "编辑测试", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "One", narration: { text: "第一句" } },
  { id: "two", kind: "definition", term: "Two", definition: "第二句", narration: { text: "第二句" } },
] };
it("blocks stale parent autosave after another tab completes Git restore, even without a storage event", async () => {
  stubApi(["mock"]);
  const initial = parseEditorProject(editedProject);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: initial, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const div = await mount();
  const remote = parseEditorProject({ ...initial, title: "其他窗口恢复的完整工程", scenes: [{ ...initial.scenes[0], title: "恢复镜头" }] });
  // Schedule a real pending autosave; mount timing alone differs across hosts.
  const source = div.querySelector<HTMLTextAreaElement>('[aria-label="创作资料"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(source, "本窗口尚未保存的资料");
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const otherTab: GitStorage = { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) };
  const tx = prepareGitStorage(remote.id, undefined, undefined, otherTab, false, remote); tx.write(); tx.commit(); tx.finish();
  const after = localStorage.getItem("glint.workspace");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
  expect(localStorage.getItem("glint.workspace")).toBe(after);
  expect(div.textContent).toContain("其他窗口已更新工作区");
});

it("recovers committed Git copy on real studio startup without losing source or restored aspect", async () => {
  stubApi(["mock"]);
  const initial = parseEditorProject(editedProject), remote = parseEditorProject({ ...initial, id: "startup-copy", title: "重启后的副本", aspect: "9:16" });
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: initial, template: "explainer", theme: "glint-dark", aspect: "16:9", evidence: "资料证据" }));
  const tx = prepareGitStorage(remote.id, undefined, undefined, localStorage, true, remote); tx.write(); tx.commit();
  const div = await mount();
  expect(div.textContent).toContain("重启后的副本");
  expect(localStorage.getItem(`glint:git-restore.v1:${remote.id}`)).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
  expect(JSON.parse(localStorage.getItem("glint.workspace")!)).toMatchObject({ text: "Original", evidence: "资料证据", project: remote, aspect: "9:16" });
});

it("重启普通草稿保留独立画幅选择，不用尚未更新的工程画幅覆盖它", async () => {
  stubApi(["mock"]);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "资料", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "9:16" }));
  const div = await mount();
  const aspect = div.querySelector<HTMLSelectElement>('select[aria-label="工程画幅"]')!;
  expect(aspect.value).toBe("9:16");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
  expect(JSON.parse(localStorage.getItem("glint.workspace")!).aspect).toBe("9:16");
});

it("preserves corrupt restore journal and workspace instead of autosaving an empty studio", async () => {
  stubApi(["mock"]);
  const initial = parseEditorProject(editedProject);
  const raw = JSON.stringify({ mode: "source", text: "Original", project: initial });
  localStorage.setItem("glint.workspace", raw);
  localStorage.setItem("glint:git-active-restore.v1", initial.id);
  localStorage.setItem(`glint:git-restore.v1:${initial.id}`, "{");
  const div = await mount();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
  expect(localStorage.getItem("glint.workspace")).toBe(raw);
  expect(localStorage.getItem(`glint:git-restore.v1:${initial.id}`)).toBe("{");
  expect(div.textContent).toContain("恢复日志损坏");
});

describe("Git 完整本机版本的作品发现与打开门禁", () => {
  const entry = (value = parseEditorProject(editedProject), id = value.id) => ({ id, name: value.title, mode: "source", text: "Original", template: "explainer", theme: "glint-dark", aspect: value.aspect, updatedAt: 1, project: value });
  const initialize = () => {
    const original = parseEditorProject(editedProject);
    localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: original, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
    return original;
  };
  const completeCopy = () => {
    const copy = parseEditorProject({ ...initialize(), id: "discovery-copy", title: "可找回的 Git 副本" });
    const tx = prepareGitStorage(copy.id, undefined, undefined, localStorage, true, copy); tx.write(); tx.commit(); tx.finish();
    return copy;
  };
  const discover = async (div: HTMLElement, id: string) => {
    await import("./LocalGitWorks");
    const details = [...div.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "查找待登记的本机 Git 工程")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    const row = [...div.querySelectorAll('[aria-label="待核对的本机 Git 工程"] .ws-row')].find(node => node.querySelector("code")?.textContent === id)!;
    expect(row).toBeDefined();
    await act(async () => { row.querySelector<HTMLButtonElement>("button")!.click(); });
  };
  it.each([true, false])("重启可找回无关工程的孤立副本并明确载入，原资料记录=%s", async hasSource => {
    stubApi(["mock"]); const copy = completeCopy();
    if (hasSource) rememberLocalGitSource(copy, { mode: "source", text: "副本独有资料", template: "explainer", theme: "glint-dark", evidence: "副本独有证据" });
    const unrelated = initialize(); const before = localStorage.getItem("glint.workspace"), div = await mount();
    await discover(div, copy.id);
    expect(localStorage.getItem("glint.workspace")).toBe(before); expect(localStorage.getItem("glint.projects")).toBeNull();
    const confirm = vi.fn(() => true); vi.stubGlobal("confirm", confirm);
    await clickVisible(div, "载入本机主快照与当前附件");
    if (!hasSource) expect(confirm).toHaveBeenCalledWith(expect.stringContaining("空资料与空凭据"));
    expect(JSON.parse(localStorage.getItem("glint.workspace")!)).toMatchObject({ project: copy, text: hasSource ? "副本独有资料" : "", evidence: hasSource ? "副本独有证据" : "" });
    expect(div.querySelector(".workspace-title")?.textContent).toBe(copy.title);
    await clickVisible(div, "登记完整本机版本");
    expect(JSON.parse(localStorage.getItem("glint.projects")!)[0]).toMatchObject({ id: copy.id, project: copy, text: hasSource ? "副本独有资料" : "" });
    expect(unrelated.id).not.toBe(copy.id);
  });
  it("多个待登记副本可逐个选择，取消与未保存局部输入不会改当前工程", async () => {
    stubApi(["mock"]); const first = completeCopy(), second = { ...first, id: "second-copy", title: "另一个未登记副本" };
    const tx = prepareGitStorage(second.id, undefined, undefined, localStorage, true, second); tx.write(); tx.commit(); tx.finish();
    const current = initialize(), before = localStorage.getItem("glint.workspace"), div = await mount();
    await discover(div, first.id); vi.stubGlobal("confirm", vi.fn(() => false));
    await clickVisible(div, "载入本机主快照与当前附件"); expect(localStorage.getItem("glint.workspace")).toBe(before);
    await discover(div, second.id);
    const release = registerAuthoringLeaveGuard(current.id, () => { throw new Error("当前批注尚未保存"); });
    const confirm = vi.fn(() => true); vi.stubGlobal("confirm", confirm);
    try { await clickVisible(div, "载入本机主快照与当前附件"); expect(confirm).not.toHaveBeenCalled(); expect(localStorage.getItem("glint.workspace")).toBe(before); }
    finally { release(); }
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(JSON.parse(localStorage.getItem("glint.workspace")!).project).toEqual(second);
    expect(localStorage.getItem(`glint:git-project.v1:${first.id}`)).toBe(JSON.stringify(first));
  });
  it("孤立副本确认期间原资料改变时拒绝载入，不混用其他工程资料", async () => {
    stubApi(["mock"]); const copy = completeCopy();
    rememberLocalGitSource(copy, { mode: "source", text: "原资料", template: "explainer", theme: "glint-dark" });
    initialize(); const before = localStorage.getItem("glint.workspace"), div = await mount(); await discover(div, copy.id);
    vi.stubGlobal("confirm", vi.fn(() => { localStorage.setItem(`glint:git-source.v1:${copy.id}`, "{"); return true; }));
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(localStorage.getItem("glint.workspace")).toBe(before); expect(div.textContent).toContain("原资料记录已变化");
  });
  it("重启仅发现当前完整副本，显式登记后最近作品可打开，再保存不重复", async () => {
    stubApi(["mock"]); const copy = completeCopy(); const div = await mount();
    expect(localStorage.getItem("glint.projects")).toBeNull();
    await clickVisible(div, "登记完整本机版本");
    expect(JSON.parse(localStorage.getItem("glint.projects")!)).toMatchObject([{ id: copy.id, project: copy }]);
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    expect(div.querySelector('[aria-label="共享工程编辑"]')!.closest("[hidden]")).toBeNull();
    await clickVisible(div, "历史版本"); await clickVisible(div, "保存项目");
    expect(JSON.parse(localStorage.getItem("glint.projects")!)).toHaveLength(1);
  });
  it("prepared副本重启回退后不发现或登记幽灵工程", async () => {
    stubApi(["mock"]); const original = initialize();
    const copy = { ...original, id: "prepared-copy", title: "不应出现的副本" };
    const tx = prepareGitStorage(copy.id, undefined, undefined, localStorage, true, copy); tx.write();
    const div = await mount();
    expect(div.textContent).not.toContain(copy.title); expect(div.textContent).not.toContain("登记完整本机版本");
    expect(localStorage.getItem("glint.projects")).toBeNull();
    expect(localStorage.getItem(`glint:git-project.v1:${copy.id}`)).toBeNull();
  });
  it("删除当前Git作品入口后重启只提示，不静默复活", async () => {
    stubApi(["mock"]); const copy = completeCopy(); localStorage.setItem("glint.projects", JSON.stringify([entry(copy)]));
    const div = await mount();
    await act(async () => { div.querySelector<HTMLButtonElement>(`[aria-label="删除 ${copy.title}"]`)!.click(); });
    expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual([]); dispose();
    const reopened = await mount(); expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual([]);
    expect(reopened.querySelector(".home-project")).toBeNull(); expect(reopened.textContent).toContain("未自动恢复已删除的入口");
  });
  it("完整版本与旧列表不同先确认；取消不写，接受保留别名且不触碰其他作品", async () => {
    stubApi(["mock"]); const copy = completeCopy();
    const old = { ...copy, title: "旧列表分镜" }, other = entry({ ...copy, id: "other-work", title: "另一作品" });
    const raw = JSON.stringify([entry(old, "old-alias"), other]); localStorage.setItem("glint.projects", raw);
    const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm); const div = await mount();
    expect(localStorage.getItem("glint.projects")).toBe(raw);
    await clickVisible(div, "登记完整本机版本"); expect(confirm).toHaveBeenCalled(); expect(localStorage.getItem("glint.projects")).toBe(raw);
    confirm.mockReturnValue(true); await clickVisible(div, "登记完整本机版本");
    expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual([expect.objectContaining({ id: "old-alias", project: copy }), other]);
  });
  it.each(["满额", "损坏", "静默丢写"])("登记遇%s不回退完整版本或淘汰作品，可明确重试", async mode => {
    stubApi(["mock"]); const copy = completeCopy();
    const raw = mode === "满额" ? JSON.stringify(Array.from({ length: 20 }, (_, index) => entry({ ...copy, id: `work-${index}` }))) : mode === "损坏" ? "{" : "[]";
    localStorage.setItem("glint.projects", raw); const main = localStorage.getItem(`glint:git-project.v1:${copy.id}`);
    const div = await mount();
    const write = Storage.prototype.setItem;
    if (mode === "静默丢写") vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) { if (key !== "glint.projects") write.call(this, key, value); });
    await clickVisible(div, "登记完整本机版本");
    expect(localStorage.getItem("glint.projects")).toBe(raw); expect(localStorage.getItem(`glint:git-project.v1:${copy.id}`)).toBe(main);
    expect(JSON.parse(localStorage.getItem("glint.workspace")!).project).toEqual(copy);
    expect(div.querySelector('[aria-label="完整本机版本与作品列表"]')!.textContent).toMatch(/满|损坏|核对失败/);
  });
  it.each(["首页", "全部作品"])("损坏恢复日志不能经%s绕过，也不发起共享工程连接", async location => {
    const fetch = stubApi(["mock"]), original = initialize();
    const raw = localStorage.getItem("glint.workspace"); localStorage.setItem("glint.projects", JSON.stringify([entry(original)]));
    localStorage.setItem("glint:git-active-restore.v1", original.id); localStorage.setItem(`glint:git-restore.v1:${original.id}`, "{");
    const div = await mount(); if (location === "全部作品") await clickVisible(div, "打开工程"); const target = location === "首页" ? div.querySelector<HTMLButtonElement>(".home-project")! : div.querySelector<HTMLButtonElement>(".ws-item .ws-pick")!;
    await act(async () => { target.click(); });
    expect(div.querySelector('[aria-label="共享工程编辑"]')).toBeNull(); expect(localStorage.getItem("glint.workspace")).toBe(raw);
    expect(fetch.mock.calls.some(([url]) => url === "/api/session/open")).toBe(false); expect(div.textContent).toContain("未打开旧作品快照");
  });
  it("挂载后才出现活动恢复也必须拒绝旧列表点击，无需storage事件", async () => {
    const fetch = stubApi(["mock"]), original = parseEditorProject(editedProject); localStorage.setItem("glint.projects", JSON.stringify([entry(original)]));
    const div = await mount(); localStorage.setItem("glint:git-active-restore.v1", "other-project");
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    expect(div.querySelector('[aria-label="共享工程编辑"]')).toBeNull(); expect(fetch.mock.calls.some(([url]) => url === "/api/session/open")).toBe(false);
  });
  it("列表渲染后被其他窗口修改，不用陈旧按钮快照打开工程", async () => {
    stubApi(["mock"]); localStorage.setItem("glint.projects", JSON.stringify([entry()])); const div = await mount();
    const foreign = JSON.stringify([entry({ ...parseEditorProject(editedProject), title: "foreign" })]); localStorage.setItem("glint.projects", foreign);
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    expect(div.querySelector('[aria-label="共享工程编辑"]')).toBeNull(); expect(localStorage.getItem("glint.projects")).toBe(foreign); expect(div.textContent).toContain("作品列表已变化");
  });
  const divergentWork = () => {
    const current = initialize();
    const older = { ...current, id: "divergent-work", title: "上次 Git 主快照" };
    const newer = { ...older, title: "较新手动分镜" };
    localStorage.setItem(`glint:git-project.v1:${older.id}`, JSON.stringify(older));
    localStorage.setItem("glint.projects", JSON.stringify([entry(newer, "manual-alias")]));
    const attachments: [string, string][] = [
      [`glint.project-documents.v1:${older.id}`, JSON.stringify({ version: 1, projectId: older.id, activeId: "script", documents: [{ id: "script", title: "保留脚本", kind: "script", content: "当前脚本不随列表快照恢复", updatedAt: 1 }] })],
      [`glint.project-designs.v1:${older.id}`, JSON.stringify({ version: 1, projectId: older.id, activeId: "", documents: [] })],
      [`glint:brand-project.v1:${older.id}`, JSON.stringify({ name: "保留品牌", colors: { accent: "#abcdef", bg: "#111111", text: "#ffffff" } })],
      [`glint:project-assets.v1:${older.id}`, JSON.stringify([{ name: "kept.png", url: "/assets/kept.png", bytes: 10 }])],
    ];
    for (const [key, raw] of attachments) localStorage.setItem(key, raw);
    return { current, older, newer, attachments };
  };
  it("最近作品入口也执行只读离开门禁，不经旧列表绕过局部输入保护", async () => {
    stubApi(["mock"]); const { current } = divergentWork(), div = await mount();
    const before = localStorage.getItem("glint.workspace"), list = localStorage.getItem("glint.projects");
    const release = registerAuthoringLeaveGuard(current.id, () => { throw new Error("仍有未保存批注"); });
    const confirm = vi.fn(() => true); vi.stubGlobal("confirm", confirm);
    try {
      await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
      expect(div.textContent).toContain("仍有未保存批注"); expect(confirm).not.toHaveBeenCalled();
      expect(localStorage.getItem("glint.workspace")).toBe(before); expect(localStorage.getItem("glint.projects")).toBe(list);
      expect(div.querySelector(".workspace-title")?.textContent).toBe(current.title);
    } finally { release(); }
  });
  it.each([false, true])("列表分镜较 Git 主快照更新时明确选择，接受=%s；不恢复或重写附件", async accept => {
    const fetch = stubApi(["mock"]), { current, older, newer, attachments } = divergentWork();
    const confirm = vi.fn(() => accept); vi.stubGlobal("confirm", confirm); const div = await mount();
    const raw = localStorage.getItem("glint.workspace"), list = localStorage.getItem("glint.projects");
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("仅载入作品列表的分镜快照"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("不会执行 Git 完整恢复"));
    expect(localStorage.getItem(`glint:git-project.v1:${older.id}`)).toBe(JSON.stringify(older));
    expect(localStorage.getItem("glint.projects")).toBe(list);
    for (const [key, raw] of attachments) expect(localStorage.getItem(key)).toBe(raw);
    expect(div.querySelector(".workspace-title")?.textContent).toBe(accept ? newer.title : current.title);
    if (!accept) {
      expect(localStorage.getItem("glint.workspace")).toBe(raw);
      expect(fetch.mock.calls.some(([url, init]) => url === "/api/session/open" && JSON.parse(String(init?.body)).projectId === newer.id)).toBe(false);
    } else {
      expect(div.textContent).toContain("脚本、设计、品牌和素材不会随列表快照恢复");
      await clickVisible(div, "历史版本"); await clickVisible(div, "保存项目");
      expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual([expect.objectContaining({ id: "manual-alias", project: newer })]);
    }
  });
  it.each(["列表", "主快照", "删除主快照", "工作区", "恢复日志"]) ("仅分镜确认期间%s变化必须拒绝，不切换当前工程", async change => {
    const fetch = stubApi(["mock"]), { current, older, newer, attachments } = divergentWork();
    for (const [key] of attachments) localStorage.removeItem(key);
    let after = "";
    vi.stubGlobal("confirm", vi.fn(() => {
      if (change === "列表") localStorage.setItem("glint.projects", "[]");
      if (change === "主快照") localStorage.setItem(`glint:git-project.v1:${older.id}`, JSON.stringify({ ...older, title: "其他窗口版本" }));
      if (change === "删除主快照") localStorage.removeItem(`glint:git-project.v1:${older.id}`);
      if (change === "工作区") localStorage.setItem("glint.workspace", JSON.stringify({ text: "其他窗口输入", project: current }));
      if (change === "恢复日志") localStorage.setItem(`glint:git-restore.v1:${older.id}`, "{");
      after = JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
      return true;
    }));
    const div = await mount();
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    expect(div.querySelector(".workspace-title")?.textContent).toBe(current.title);
    expect(fetch.mock.calls.some(([url, init]) => url === "/api/session/open" && JSON.parse(String(init?.body)).projectId === newer.id)).toBe(false);
    expect(JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))).toBe(after);
    expect(div.querySelector('[aria-label="完整本机版本与作品列表"]')!.textContent).toMatch(/变化|其他窗口|恢复日志/);
  });
  it.each(["工作区", "主快照", "活动恢复"]) ("登记确认期间%s变化必须拒绝，保留旧入口与外来修改", async change => {
    stubApi(["mock"]); const copy = completeCopy();
    const raw = JSON.stringify([entry({ ...copy, title: "旧入口" }, "kept-alias")]); localStorage.setItem("glint.projects", raw);
    const div = await mount(); let foreign = "";
    vi.stubGlobal("confirm", vi.fn(() => {
      if (change === "工作区") localStorage.setItem("glint.workspace", foreign = JSON.stringify({ text: "外来输入", project: { ...copy, title: "外来工程" } }));
      if (change === "主快照") localStorage.setItem(`glint:git-project.v1:${copy.id}`, foreign = JSON.stringify({ ...copy, title: "外来完整工程" }));
      if (change === "活动恢复") localStorage.setItem("glint:git-active-restore.v1", foreign = "foreign-project");
      return true;
    }));
    await clickVisible(div, "登记完整本机版本");
    expect(localStorage.getItem("glint.projects")).toBe(raw);
    const changedKey = change === "工作区" ? "glint.workspace" : change === "主快照" ? `glint:git-project.v1:${copy.id}` : "glint:git-active-restore.v1";
    expect(localStorage.getItem(changedKey)).toBe(foreign);
  });
  it("只更改画幅也必须阻止旧完整版本登记，不误称当前编辑区未改变", async () => {
    stubApi(["mock"]); completeCopy(); const div = await mount();
    const select = div.querySelector<HTMLSelectElement>('select[aria-label="工程画幅"]')!;
    await act(async () => { select.value = "9:16"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await clickVisible(div, "登记完整本机版本");
    expect(localStorage.getItem("glint.projects")).toBeNull();
    expect(div.textContent).toContain("编辑区已产生新修改");
  });
  it("committed日志持续清理失败时不登记；恢复权限后明确重试再登记，不回退完整工程", async () => {
    stubApi(["mock"]); const copy = completeCopy();
    // A second accepted restore leaves a committed marker whose cleanup is unavailable at startup.
    const tx = prepareGitStorage(copy.id, undefined, undefined, localStorage, false, copy); tx.write(); tx.commit();
    const remove = Storage.prototype.removeItem;
    const denied = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith("glint:git-restore.v1:")) throw new Error("storage denied");
      remove.call(this, key);
    });
    const raw = localStorage.getItem("glint.workspace"), main = localStorage.getItem(`glint:git-project.v1:${copy.id}`);
    const div = await mount(); await clickVisible(div, "登记完整本机版本");
    expect(localStorage.getItem("glint.projects")).toBeNull();
    expect(JSON.parse(localStorage.getItem(`glint:git-restore.v1:${copy.id}`)!).state).toBe("committed");
    expect(localStorage.getItem("glint:git-active-restore.v1")).toBe(copy.id);
    await clickVisible(div, "重试本机恢复"); expect(localStorage.getItem("glint.projects")).toBeNull();
    denied.mockRestore(); await clickVisible(div, "重试本机恢复");
    expect(localStorage.getItem(`glint:git-restore.v1:${copy.id}`)).toBeNull(); expect(localStorage.getItem("glint:git-active-restore.v1")).toBeNull();
    await clickVisible(div, "登记完整本机版本");
    expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual([expect.objectContaining({ id: copy.id, project: copy })]);
    expect(localStorage.getItem(`glint:git-project.v1:${copy.id}`)).toBe(main);
    expect(JSON.parse(localStorage.getItem("glint.workspace")!).project).toEqual(copy);
    expect(JSON.parse(raw!).project).toEqual(copy);
  });
  it.each([false, true])("无分镜文本入口同编号有Git主快照时明确提示，接受=%s，不无声丢失发现入口", async accept => {
    stubApi(["mock"]); const current = initialize(), complete = { ...current, id: "text-work", title: "可找回主快照" };
    localStorage.setItem(`glint:git-project.v1:${complete.id}`, JSON.stringify(complete));
    const { project: _, ...draft } = entry(complete); localStorage.setItem("glint.projects", JSON.stringify([{ ...draft, name: "文本草稿", text: "原文本" }]));
    const confirm = vi.fn(() => accept); vi.stubGlobal("confirm", confirm); const div = await mount();
    const before = localStorage.getItem("glint.workspace");
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("同编号下保留了完整本机主快照"));
    expect(div.textContent).toContain("载入本机主快照与当前附件");
    expect(localStorage.getItem(`glint:git-project.v1:${complete.id}`)).toBe(JSON.stringify(complete));
    if (!accept) expect(localStorage.getItem("glint.workspace")).toBe(before);
  });
  it("切到另一作品再回旧列表分镜后可明确载入本机主快照，保留原资料并重新登记", async () => {
    stubApi(["mock"]); const copy = completeCopy(), old = { ...copy, title: "旧列表分镜" };
    const other = entry({ ...copy, id: "other-work", title: "另一作品" }); other.text = "另一作品资料";
    localStorage.setItem("glint.projects", JSON.stringify([{ ...entry(old, "kept-alias"), text: "原工程资料" }, other]));
    vi.stubGlobal("confirm", vi.fn(() => true)); const div = await mount();
    const open = async (name: string) => act(async () => { [...div.querySelectorAll<HTMLButtonElement>(".home-project")].find(node => node.querySelector("strong")?.textContent === name)!.click(); });
    await open(other.name); await clickVisible(div, "返回作品"); await open(old.title);
    await clickVisible(div, "登记完整本机版本"); expect(div.textContent).toContain("编辑区已产生新修改");
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(div.querySelector(".workspace-title")?.textContent).toBe(copy.title);
    expect(JSON.parse(localStorage.getItem("glint.workspace")!)).toMatchObject({ project: copy, text: "原工程资料" });
    expect(div.textContent).toContain("未还原 Git 提交");
    await clickVisible(div, "登记完整本机版本");
    expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual([expect.objectContaining({ id: "kept-alias", project: copy, text: "原工程资料" }), other]);
  });
  it.each(["取消", "附件变化", "列表变化", "日志变化"]) ("显式载入本机主快照遇%s不得替换当前工程或外来数据", async failure => {
    stubApi(["mock"]); const copy = completeCopy();
    const raw = JSON.stringify([entry({ ...copy, title: "旧列表" })]); localStorage.setItem("glint.projects", raw);
    const div = await mount(), before = localStorage.getItem("glint.workspace");
    vi.stubGlobal("confirm", vi.fn(() => {
      if (failure === "附件变化") localStorage.setItem(`glint:project-assets.v1:${copy.id}`, "[]");
      if (failure === "列表变化") localStorage.setItem("glint.projects", "[]");
      if (failure === "日志变化") localStorage.setItem(`glint:git-restore.v1:${copy.id}`, "{");
      return failure !== "取消";
    }));
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(localStorage.getItem("glint.workspace")).toBe(before);
    expect(div.querySelector('[aria-label="共享工程编辑"]')!.closest("[hidden]")).not.toBeNull();
    expect(localStorage.getItem("glint.projects")).toBe(failure === "列表变化" ? "[]" : raw);
  });
  const pendingDraft = (id: string, module: "脚本" | "设计") => {
    if (module === "脚本") {
      const draft = { state: { version: 1 as const, projectId: id, activeId: "script", documents: [{ id: "script", title: "未保存脚本", kind: "script" as const, content: "不能丢的脚本", updatedAt: 1 }] }, raw: null, error: "quota" };
      pendingScriptDrafts.set(id, draft); return draft;
    }
    const draft = { state: { version: 1 as const, projectId: id, activeId: "design", documents: [{ id: "design", title: "未保存设计", kind: "page" as const, activePageId: "page", updatedAt: 1, pages: [{ id: "page", title: "首页", html: "<p>不能丢的设计</p>" }] }] }, raw: undefined, error: "denied" };
    pendingDesignDrafts.set(id, draft); return draft;
  };
  it.each(["脚本", "设计"] as const)("目标工程存在未挂载的%s草稿时拒绝载入，不清除草稿或替换工作区", async module => {
    const fetch = stubApi(["mock"]), { current, older } = divergentWork(); const div = await mount();
    vi.stubGlobal("confirm", vi.fn(() => false));
    await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    const draft = pendingDraft(older.id, module), before = localStorage.getItem("glint.workspace"), list = localStorage.getItem("glint.projects");
    const confirm = vi.fn(() => true); vi.stubGlobal("confirm", confirm);
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(confirm).not.toHaveBeenCalled(); expect(div.querySelector(".workspace-title")?.textContent).toBe(current.title);
    expect(div.textContent).toContain("未保存的脚本或设计草稿");
    expect(localStorage.getItem("glint.workspace")).toBe(before); expect(localStorage.getItem("glint.projects")).toBe(list);
    expect(module === "脚本" ? pendingScriptDrafts.get(older.id) : pendingDesignDrafts.get(older.id)).toBe(draft);
    expect(fetch.mock.calls.some(([url, init]) => url === "/api/session/open" && JSON.parse(String(init?.body)).projectId === older.id)).toBe(false);
  });
  it.each(["脚本", "设计"] as const)("切到其他工程前当前%s草稿阻止主快照重挂载", async module => {
    stubApi(["mock"]); const { current } = divergentWork(), div = await mount();
    vi.stubGlobal("confirm", vi.fn(() => false)); await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    const draft = pendingDraft(current.id, module), before = localStorage.getItem("glint.workspace");
    vi.stubGlobal("confirm", vi.fn(() => true)); await clickVisible(div, "载入本机主快照与当前附件");
    expect(div.querySelector(".workspace-title")?.textContent).toBe(current.title); expect(localStorage.getItem("glint.workspace")).toBe(before);
    expect(module === "脚本" ? pendingScriptDrafts.get(current.id) : pendingDesignDrafts.get(current.id)).toBe(draft);
    expect(div.textContent).toContain("未保存的脚本或设计草稿");
  });
  it.each(["当前脚本", "当前设计", "目标脚本", "目标设计"]) ("确认期间出现%s草稿也拒绝载入且保留新草稿", async change => {
    stubApi(["mock"]); const { current, older } = divergentWork(), div = await mount();
    vi.stubGlobal("confirm", vi.fn(() => false)); await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    const before = localStorage.getItem("glint.workspace"), id = change.startsWith("当前") ? current.id : older.id;
    let draft: ReturnType<typeof pendingDraft>;
    vi.stubGlobal("confirm", vi.fn(() => { draft = pendingDraft(id, change.endsWith("脚本") ? "脚本" : "设计"); return true; }));
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(div.querySelector(".workspace-title")?.textContent).toBe(current.title); expect(localStorage.getItem("glint.workspace")).toBe(before);
    expect(change.endsWith("脚本") ? pendingScriptDrafts.get(id) : pendingDesignDrafts.get(id)).toBe(draft!);
    expect(div.textContent).toContain("未保存的脚本或设计草稿");
  });
  it("同工程有草稿时不重挂编辑器，用户明确保存后可重试", async () => {
    stubApi(["mock"]); const copy = completeCopy(); localStorage.setItem("glint.projects", JSON.stringify([entry({ ...copy, title: "旧入口" })]));
    const div = await mount(), draft = pendingDraft(copy.id, "脚本"), before = localStorage.getItem("glint.workspace");
    vi.stubGlobal("confirm", vi.fn(() => true)); await clickVisible(div, "载入本机主快照与当前附件");
    expect(localStorage.getItem("glint.workspace")).toBe(before); expect(pendingScriptDrafts.get(copy.id)).toBe(draft);
    // Simulate an explicit successful module save, never a loader-initiated deletion.
    localStorage.setItem(`glint.project-documents.v1:${copy.id}`, JSON.stringify(draft.state)); pendingScriptDrafts.delete(copy.id);
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(div.textContent).toContain("已载入上次接受的本机主快照");
    expect(localStorage.getItem(`glint.project-documents.v1:${copy.id}`)).toBe(JSON.stringify(draft.state));
  });
  it.each(["当前", "目标", "确认后当前", "确认后目标"])("载入主快照会只读复验%s工程的局部输入，拒绝后不替换工作区", async point => {
    stubApi(["mock"]); const { current, older } = divergentWork(), div = await mount();
    vi.stubGlobal("confirm", vi.fn(() => false)); await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
    let dirty = !point.startsWith("确认后"); const check = vi.fn(() => { if (dirty) throw Error("局部输入尚未提交"); });
    const release = registerAuthoringLeaveGuard(point.endsWith("目标") ? older.id : current.id, check);
    try {
      const before = localStorage.getItem("glint.workspace"), list = localStorage.getItem("glint.projects");
      const confirm = vi.fn(() => { dirty = true; return true; }); vi.stubGlobal("confirm", confirm);
      await clickVisible(div, "载入本机主快照与当前附件");
      expect(div.textContent).toContain("局部输入尚未提交"); expect(localStorage.getItem("glint.workspace")).toBe(before);
      expect(localStorage.getItem("glint.projects")).toBe(list); expect(div.querySelector(".workspace-title")?.textContent).toBe(current.title);
      expect(check).toHaveBeenCalledTimes(point.startsWith("确认后") ? 2 : 1);
      expect(confirm).toHaveBeenCalledTimes(point.startsWith("确认后") ? 1 : 0);
    } finally { release(); }
  });
  it.each(["脚本", "设计"])("真实%s编辑器保存后解除主快照重挂载门禁，隐藏 pane 也不能绕过", async kind => {
    stubApi(["mock"]); const copy = completeCopy(); localStorage.setItem("glint.projects", JSON.stringify([entry({ ...copy, title: "旧入口" })]));
    const div = await mount(); await act(async () => { div.querySelector<HTMLButtonElement>(".home-resume")!.click(); }); await clickVisible(div, kind);
    const label = kind === "脚本" ? "脚本文档编辑器" : "设计文档编辑器";
    for (let attempt = 0; attempt < 30 && !div.querySelector(`[aria-label="${label}"]`); attempt++)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const editor = div.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    if (kind === "设计") await act(async () => { [...editor.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "HTML 源码")!.click(); });
    await act(async () => { [...editor.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "保存")!.click(); });
    const area = editor.querySelector<HTMLTextAreaElement>(`[aria-label="${kind === "脚本" ? "脚本文档正文" : "页面 HTML 源码"}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, kind === "脚本" ? "真实按钮保存的脚本" : "<p>真实按钮保存的设计</p>");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickVisible(div, "作品"); const before = localStorage.getItem("glint.workspace");
    vi.stubGlobal("confirm", vi.fn(() => true)); await clickVisible(div, "载入本机主快照与当前附件");
    expect(div.textContent).toContain("未保存的脚本或设计草稿"); expect(localStorage.getItem("glint.workspace")).toBe(before);
    expect(div.querySelector(`[aria-label="${label}"]`)).toBe(editor);
    await act(async () => { [...editor.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "保存")!.click(); });
    await clickVisible(div, "载入本机主快照与当前附件"); expect(div.textContent).toContain("已载入上次接受的本机主快照");
    expect(div.querySelector(`[aria-label="${label}"]`)).not.toBe(editor);
    expect(localStorage.getItem(`${kind === "脚本" ? "glint.project-documents.v1:" : "glint.project-designs.v1:"}${copy.id}`)).toContain(kind === "脚本" ? "真实按钮保存的脚本" : "真实按钮保存的设计");
  });
  it("无关工程的草稿不阻止当前工程载入，也不被清理", async () => {
    stubApi(["mock"]); const copy = completeCopy(); localStorage.setItem("glint.projects", JSON.stringify([entry({ ...copy, title: "旧入口" })]));
    const div = await mount(), draft = pendingDraft("unrelated", "设计"); vi.stubGlobal("confirm", vi.fn(() => true));
    await clickVisible(div, "载入本机主快照与当前附件");
    expect(div.textContent).toContain("已载入上次接受的本机主快照"); expect(pendingDesignDrafts.get("unrelated")).toBe(draft);
  });
  it("恢复清理后若当前内存已有新输入，不以磁盘覆盖，也不登记过期工程", async () => {
    stubApi(["mock"]); const copy = completeCopy(); const div = await mount();
    const foreign = JSON.stringify({ project: { ...copy, title: "外来磁盘版本" }, text: "其他窗口资料" });
    localStorage.setItem("glint.workspace", foreign);
    await choose(div, "风格", "bold-poster");
    await clickVisible(div, "重试本机恢复");
    expect(div.textContent).toContain("未用磁盘版本覆盖编辑区");
    expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("bold-poster");
    expect(localStorage.getItem("glint.workspace")).toBe(foreign);
    await clickVisible(div, "登记完整本机版本");
    expect(localStorage.getItem("glint.projects")).toBeNull(); expect(localStorage.getItem("glint.workspace")).toBe(foreign);
  });
});

it("restores the autosaved editor and submits the edited project, not the original source", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => url === "/api/make" ? new Response(JSON.stringify({ jobId: "idea-edit-test" })) : new Response(JSON.stringify({ id: "idea-edit-test", status: "done", log: [] })));
  vi.stubGlobal("fetch", fetch);
  const div = await mount();
  expect(div.textContent).toContain("2 个分镜");
  const submit = [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!;
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = fetch.mock.calls.find(([url]) => url === "/api/make")!;
  const payload = JSON.parse(call[1]!.body as string);
  expect(payload.project.id).toBe("editor-test");
  expect(payload.source).toBeUndefined(); expect(payload.tts).toBe("mock");
});
it("submits the frozen theme tokens with the edited project instead of replacing them with the selector name", async () => {
  const theme = captureStyleTokens("bold-poster");
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: { ...editedProject, theme }, template: "explainer", theme: "bold-poster", aspect: "16:9" }));
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url === "/api/make" ? Response.json({ jobId: "theme-render" }) : url === "/api/health" ? Response.json({ voices: ["mock"] }) : url === "/api/media/library" ? Response.json({ assets: [] }) : Response.json({ id: "theme-render", status: "done", log: [] }));
  vi.stubGlobal("fetch", fetcher);
  const div = await mount();
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); await new Promise(resolve => setTimeout(resolve, 50)); });
  const request = fetcher.mock.calls.find(([url]) => url === "/api/make")!;
  expect(JSON.parse(String(request[1]!.body)).project.theme).toEqual(theme);
});
it("CREATE-11 preserves an unknown draft theme, blocks render and replaces it only on selection", async () => {
  const fetch = stubApi(["mock"]);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: { ...editedProject, theme: "external-theme" }, theme: "glint-dark", aspect: "16:9" }));
  const div = await mount();
  expect(div.textContent).toContain("未知风格「external-theme」");
  expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("");
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); [...div.querySelectorAll("button")].find(button => button.textContent === "重新生成（替换当前分镜）")!.click(); });
  expect(fetch.mock.calls.some(([url]) => url === "/api/compose")).toBe(false);
  expect(fetch.mock.calls.some(([url]) => url === "/api/make")).toBe(false);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(JSON.parse(localStorage.getItem("glint.workspace")!).project.theme).toBe("external-theme");
  await choose(div, "风格", "bold-poster");
  expect(div.textContent).not.toContain("未知风格「external-theme」");
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(JSON.parse(String(fetch.mock.calls.find(([url]) => url === "/api/make")![1]!.body)).project.theme).toBe("bold-poster");
});

it("CREATE-11 syncs a known project theme instead of the stale workspace selector", async () => {
  const fetch = stubApi(["mock"]);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: { ...editedProject, theme: "bold-poster" }, theme: "glint-dark", aspect: "16:9" }));
  const div = await mount();
  expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("bold-poster");
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  const payload = JSON.parse(String(fetch.mock.calls.find(([url]) => url === "/api/make")![1]!.body));
  expect(payload.theme).toBe("bold-poster"); expect(payload.project.theme).toBe("bold-poster");
});

it("CREATE-11 preserves an unknown snapshot until replacement is confirmed", async () => {
  const fetch = stubApi(["mock"]);
  const snapshot = captureStyleTokens("bold-poster");
  (snapshot.glintStyleSnapshot as Record<string, unknown>).version = "9.0.0";
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: { ...editedProject, theme: snapshot }, theme: "glint-dark", aspect: "16:9" }));
  const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
  const div = await mount();
  expect(div.textContent).toContain("无法识别的风格快照");
  await choose(div, "风格", "hand-note");
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("替换"));
  expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(JSON.parse(localStorage.getItem("glint.workspace")!).project.theme).toEqual(snapshot);
  confirm.mockReturnValue(true);
  await choose(div, "风格", "hand-note");
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(JSON.parse(String(fetch.mock.calls.find(([url]) => url === "/api/make")![1]!.body)).project.theme).toBe("hand-note");
});

it("CREATE-11 synchronizes saved works and historical revisions from the project theme", async () => {
  stubApi(["mock"]);
  const saved = { id: "saved", name: "旧作品", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.now(), project: { ...editedProject, theme: "bold-poster" } };
  const revision = { version: 1, id: "rev", projectId: "saved", at: Date.now(), label: "旧版本", reason: "manual", snapshot: { ...saved, project: { ...editedProject, theme: "hand-note" } } };
  localStorage.setItem("glint.projects", JSON.stringify([saved]));
  localStorage.setItem("glint.revisions.v1:saved", JSON.stringify([revision]));
  const div = await mount();
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent?.includes("旧作品"))!.click(); });
  expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("bold-poster");
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "恢复")!.click(); });
  expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("hand-note");
});

it("keeps a saved approved work independent when its untrusted copy is saved and restored", async () => {
  const original = { ...editedProject, frozen: true, assets: [{ id: "hero", kind: "character", name: "角色", version: "v1", description: "蓝衣", voice: "voice", refs: ["assets/missing.png"], approval: { name: "角色", version: "v1", description: "蓝衣", voice: "voice", refs: ["assets/missing.png"] } }] };
  const saved = { id: "saved-original", name: "原作品", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.now(), project: original };
  localStorage.setItem("glint.projects", JSON.stringify([saved]));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/session/open") {
      const body = JSON.parse(String(init?.body));
      if (body.project.id === original.id) return Response.json({ code: "untrusted-import" }, { status: 409 });
      return Response.json({ snapshot: { document: body.project, revision: 0 }, look: { revision: 0, undoDepth: 0, redoDepth: 0, selection: [] } });
    }
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    return Response.json({});
  }));
  const div = await mount();
  const click = async (label: string) => act(async () => {
    const button = [...div.querySelectorAll("button")].find(item => item.textContent?.trim() === label || item.textContent?.includes(label));
    expect(button, label).toBeTruthy(); button!.click(); await new Promise(resolve => setTimeout(resolve, 30));
  });
  await click("原作品");
  await click("保留原件并创建待重新批准副本");
  await click("保存项目");
  const entries = JSON.parse(localStorage.getItem("glint.projects")!);
  expect(entries).toHaveLength(2);
  expect(entries.find((entry: { id: string }) => entry.id === saved.id).project).toEqual(original);
  const copy = entries.find((entry: { id: string }) => entry.id !== saved.id);
  expect(copy.project.id).not.toBe(original.id);
  expect(copy.project.assets[0].approval).toBeUndefined();
  expect(copy.project.frozen).toBe(false);
  await click("原作品");
  expect(div.textContent).toContain("旧批准需要重新审阅");
  await click("待重新批准");
  expect(div.textContent).toContain(copy.project.id);
});

it("keeps a post-backup edit in the real parent workspace when a delayed reload returns", async () => {
  const local = parseEditorProject(editedProject), remote = { ...local, title: "共享版本" };
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "原资料", project: local, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  let release!: (response: Response) => void;
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/session/open") return Response.json({ snapshot: { document: remote, revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] }, conflict: true });
    if (url.startsWith("/api/session/snapshot?")) return new Promise<Response>(resolve => { release = resolve; });
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    return Response.json({ assets: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  const div = await mount();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const resume = [...div.querySelectorAll("button")].find(button => button.textContent === "保留副本并接续共享版本")!;
  expect(resume).toBeTruthy(); await act(async () => { resume.click(); });
  const input = div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "父组件中的新草稿"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { release(Response.json({ snapshot: { document: remote, revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] } })); await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(div.textContent).toContain("读取共享版本期间本地草稿发生变化");
  expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("父组件中的新草稿");
  expect(JSON.parse(localStorage.getItem("glint.workspace")!).project.scenes[0].title).toBe("父组件中的新草稿");
  expect(JSON.parse(localStorage.getItem(`glint.session-draft:${local.id}`)!).scenes[0].title).toBe("父组件中的新草稿");
});

it("recovers a conflict backup as a separate work without replacing the current parent draft", async () => {
  const source = parseEditorProject({ ...editedProject, title: "旧备份", frozen: true, assets: [{ id: "hero", kind: "character", name: "角色", version: "v1", description: "蓝衣", voice: "voice", refs: ["assets/hero.png"], approval: { name: "角色", version: "v1", description: "蓝衣", voice: "voice", refs: ["assets/hero.png"] } }] });
  const key = `glint.session-backup:${source.id}:1700000000000-abc`;
  const raw = JSON.stringify(source); localStorage.setItem(key, raw);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "当前资料", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => url === "/api/session/open" ? (() => { const body = JSON.parse(String(init?.body)); return Response.json({ snapshot: { document: body.createOnly ? body.project : parseEditorProject(editedProject), revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] } }); })() : Response.json({ assets: [] })));
  const div = await mount();
  const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("本机冲突备份"))!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  expect(details.textContent).toContain("旧备份");
  const click = async (label: string) => act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === label)!.click(); });
  await click("恢复为独立作品"); await click("取消恢复");
  expect(localStorage.getItem("glint.projects")).toBeNull();
  await click("恢复为独立作品"); await click("确认恢复");
  const saved = JSON.parse(localStorage.getItem("glint.projects")!);
  expect(saved).toHaveLength(1); expect(saved[0].project.id).not.toBe(source.id);
  expect(saved[0].project.frozen).toBe(false); expect(saved[0].project.assets[0].approval).toBeUndefined();
  expect(saved[0].project.assets[0].refs).toEqual(source.assets![0]!.refs);
  expect(localStorage.getItem(key)).toBe(raw);
  expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("One");
  expect(details.textContent).toContain("当前草稿未改变");
});

it("exports even an invalid backup without changing its raw contents", async () => {
  const key = "glint.session-backup:broken:1700000000000-x", raw = "{invalid backup";
  localStorage.setItem(key, raw); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [] })));
  const create = vi.fn(() => "blob:test"); vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  try {
    const div = await mount(); await clickVisible(div, "打开工程"); const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("本机冲突备份"))!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(details.textContent).toContain("无法恢复，可导出原文件");
    expect([...details.querySelectorAll("button")].some(item => item.textContent === "恢复为独立作品")).toBe(false);
    await act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === "导出备份")!.click(); });
    expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce();
    expect(localStorage.getItem(key)).toBe(raw); expect(details.textContent).toContain("已发起备份文件下载");
  } finally { click.mockRestore(); }
});

it("does not replace any work when backup recovery hits quota or a full project list", async () => {
  const key = `glint.session-backup:${editedProject.id}:1700000000000-abc`;
  localStorage.setItem(key, JSON.stringify(editedProject));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => url === "/api/session/open" ? Response.json({ snapshot: { document: JSON.parse(String(init?.body)).project } }) : Response.json({ assets: [] })));
  const div = await mount(); await clickVisible(div, "打开工程");
  const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("本机冲突备份"))!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  const click = async (label: string) => act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === label)!.click(); });
  await click("恢复为独立作品");
  const original = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) { if (name === "glint.projects") throw new DOMException("quota", "QuotaExceededError"); return original.call(this, name, value); });
  await click("确认恢复"); spy.mockRestore();
  expect(details.textContent).toContain("本机存储失败，共享副本已创建");
  expect(localStorage.getItem("glint.projects")).toBeNull(); expect(localStorage.getItem(key)).toBeTruthy();
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: "作品", mode: "source", text: "", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: i }));
  localStorage.setItem("glint.projects", JSON.stringify(entries)); await click("确认恢复");
  expect(details.textContent).toContain("作品列表已满"); expect(JSON.parse(localStorage.getItem("glint.projects")!)).toEqual(entries);
});

it("lists and deletes any of 20 works without switching the current draft", async () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: `work-${i}`, name: `作品${i}`, mode: "source", text: "", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: i }));
  localStorage.setItem("glint.projects", JSON.stringify(entries));
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "当前资料", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/session/open" ? Response.json({ snapshot: { document: parseEditorProject(editedProject), revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] } }) : Response.json({ assets: [] })));
  const div = await mount();
  const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("全部作品与删除"))!;
  await act(async () => { details.open = true; });
  expect(details.querySelectorAll('button[aria-label^="删除 "]')).toHaveLength(20);
  await act(async () => { details.querySelector<HTMLButtonElement>('[aria-label="删除 作品19"]')!.click(); });
  expect(JSON.parse(localStorage.getItem("glint.projects")!)).toHaveLength(19);
  expect(JSON.parse(localStorage.getItem("glint.projects")!).some((item: { id: string }) => item.id === "work-19")).toBe(false);
  expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("One");
});

it("retries a server ID collision without changing the existing remote or active draft", async () => {
  const key = `glint.session-backup:${editedProject.id}:1700000000000-abc`, raw = JSON.stringify(editedProject);
  localStorage.setItem(key, raw); localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "当前资料", project: editedProject }));
  const reserved: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/session/open") {
      const body = JSON.parse(String(init?.body));
      if (body.createOnly) { reserved.push(body.projectId); return reserved.length === 1 ? Response.json({ code: "project-conflict" }, { status: 409 }) : Response.json({ snapshot: { document: body.project, revision: 0 }, look: { revision: 0, undoDepth: 0, redoDepth: 0, selection: [] } }); }
      return Response.json({ snapshot: { document: parseEditorProject(editedProject), revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] } });
    }
    return Response.json({ assets: [] });
  });
  vi.stubGlobal("fetch", fetcher); const div = await mount();
  const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("本机冲突备份"))!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  await act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === "恢复为独立作品")!.click(); });
  await act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === "确认恢复")!.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(reserved).toHaveLength(2); expect(reserved[1]).not.toBe(reserved[0]);
  expect(JSON.parse(localStorage.getItem("glint.projects")!)[0].project.id).toBe(reserved[1]);
  expect(localStorage.getItem(key)).toBe(raw); expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("One");
});

it("does not reassign an ID on server failure and preserves the backup", async () => {
  const key = `glint.session-backup:${editedProject.id}:1700000000000-abc`;
  localStorage.setItem(key, JSON.stringify(editedProject)); let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url === "/api/session/open") { attempts++; return Response.json({ error: "offline" }, { status: 503 }); } return Response.json({ assets: [] }); }));
  const div = await mount(); await clickVisible(div, "打开工程"); const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("本机冲突备份"))!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  await act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === "恢复为独立作品")!.click(); });
  await act(async () => { [...details.querySelectorAll("button")].find(item => item.textContent === "确认恢复")!.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(attempts).toBe(1); expect(localStorage.getItem(key)).toBeTruthy(); expect(localStorage.getItem("glint.projects")).toBeNull();
  expect(details.textContent).toContain("共享工程创建未确认");
});

it("CREATE-11 opens a shared project with its own known style", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (url === "/api/session/list") return Response.json({ projects: [{ projectId: "shared", title: "共享作品", revision: 1 }] });
    if (url.startsWith("/api/session/snapshot?")) return Response.json({ snapshot: { document: { ...editedProject, theme: "whiteboard" } } });
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch); const div = await mount(); await clickVisible(div, "打开工程");
  const details = [...div.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.includes("从 Skill / CLI 继续"))!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent?.includes("共享作品"))!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(div.querySelector<HTMLSelectElement>('[aria-label="风格"]')!.value).toBe("whiteboard");
});

it("CREATE-11 imports unknown JSON without substituting the previous selection", async () => {
  stubApi(["mock"]); const div = await mount(); await clickVisible(div, "打开工程");
  const input = [...div.querySelectorAll<HTMLInputElement>('input[accept=".json,application/json"]')].find(element => element.hidden)!;
  const theme = "imported-future-theme";
  const file = { size: 100, text: async () => JSON.stringify({ ...editedProject, theme }) };
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(div.textContent).toContain(theme);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(JSON.parse(localStorage.getItem("glint.workspace")!).project.theme).toBe(theme);
});

it("undoes and redoes scene deletion", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject }));
  const div = await mount();
  const click = async (label: string) => { await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === label)!.click(); }); };
  await click("删除分镜"); expect(div.textContent).toContain("1 个分镜");
  await click("撤销"); expect(div.textContent).toContain("2 个分镜");
  await click("重做"); expect(div.textContent).toContain("1 个分镜");
});

const approvedProject = { schemaVersion: 1, id: "plan-approved", title: "批准工程", aspect: "16:9", knowledgeSources: [], theme: "glint-dark", scenes: [
  { id: "hook", kind: "title", title: "批准标题", narration: { text: "批准的旁白第一句，逐字保留。", durationMs: 3000 } },
  { id: "body", kind: "definition", term: "概念", definition: "定义正文", narration: { text: "批准的旁白第二句，逐字保留。", durationMs: 3000 } },
] };

it("restores the approved narration verbatim through undo and redo (CREATE-07)", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: approvedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  stubApi(["mock"]);
  const div = await mount();
  const narration = div.querySelector<HTMLTextAreaElement>('[aria-label="旁白"]')!;
  expect(narration.value).toBe("批准的旁白第一句，逐字保留。");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(narration, "手滑改掉的旁白");
    narration.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(narration.value).toBe("手滑改掉的旁白");
  const click = async (label: string) => { await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === label)!.click(); }); };
  await click("撤销");
  expect(div.querySelector<HTMLTextAreaElement>('[aria-label="旁白"]')!.value).toBe("批准的旁白第一句，逐字保留。");
  await click("重做");
  expect(div.querySelector<HTMLTextAreaElement>('[aria-label="旁白"]')!.value).toBe("手滑改掉的旁白");
  await click("撤销");
  expect(div.querySelector<HTMLTextAreaElement>('[aria-label="旁白"]')!.value).toBe("批准的旁白第一句，逐字保留。");
});

it("flags TTS duration drift against the approved storyboard budget (CREATE-07)", async () => {
  const budget = buildTimeline(parseEditorProject(editedProject)).totalMs / 1000;
  // Mock TTS runs silent; a real engine's audio length is what drifts. Simulate
  // that by returning a done job whose duration overshoots the budget.
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/make") { void init; return Response.json({ jobId: "idea-drift" }); }
    if (url === "/api/make/idea-drift") return Response.json({ id: "idea-drift", status: "done", log: [], duration: budget + 2 });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const div = await mountSavedProject();
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); await new Promise(resolve => setTimeout(resolve, 100)); });
  const drift = div.querySelector('p[role="status"]');
  expect(div.textContent).toContain(`配音让成片比批准时长长 2.0 秒（预算 ${budget.toFixed(1)}s · 实际 ${(budget + 2).toFixed(1)}s）`);
  // Within half a second the budget holds and the warning stays quiet.
  (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/make") return Response.json({ jobId: "idea-drift" });
    if (url === "/api/make/idea-drift") return Response.json({ id: "idea-drift", status: "done", log: [], duration: budget + 0.2 });
    return Response.json({});
  });
  await act(async () => { [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!.click(); await new Promise(resolve => setTimeout(resolve, 100)); });
  expect(div.textContent).not.toContain("配音让成片比批准时长");
  void drift;
});
it("creates from the unified library, backs up the old project and opens editable content", async () => {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const div = await mount();
  await clickVisible(div, "浏览模板");
  await act(async()=>{await import("./CreationLibrary");await new Promise(resolve=>setTimeout(resolve,0));});
  const card = [...div.querySelectorAll("button")].find(button => button.querySelector("strong")?.textContent === "12 秒产品发布")!;
  await act(async () => card.click());
  await act(async () => div.querySelector<HTMLInputElement>('[aria-label="创作库"] input[type="checkbox"]')!.click());
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "用这个创作")!.click());
  expect(div.textContent).toContain("3 个分镜");
  expect(div.querySelector('[aria-label="共享工程编辑"]')!.closest("[hidden]")).toBeNull();
  const saved = JSON.parse(localStorage.getItem("glint.projects") ?? "[]");
  expect(saved[0].project.id).toBe("editor-test");
  expect(div.textContent).toContain("product-launch v1.0.0");
});
it("does not load the player before an explicit preview action", async () => {
  const div = await mount();
  expect(div.querySelector("video")).toBeNull();
  expect(div.querySelector('[aria-label="工程工作区"]')).toBeNull();
  await clickVisible(div, "打开工程");
  expect(div.textContent).toContain("载入入门示例");
  expect(div.querySelector("video")).toBeNull();
});

it("puts examples and recent works on the first screen and keeps jargon out of the main path", async () => {
  localStorage.setItem("glint.projects", JSON.stringify([{ id: "p1", name: "上周的讲解", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.now() }]));
  const div = await mount();
  const recent = div.querySelector('[aria-label="最近作品"]')!;
  expect(recent).not.toBeNull();
  expect(recent.closest("details")).toBeNull();
  expect(div.textContent).toContain("上周的讲解");
  const example = div.querySelector<HTMLButtonElement>('[aria-label="使用知识讲解起点"]')!;
  await act(async () => { example.click(); });
  expect(div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!.value).toContain("熵增");
  expect(div.textContent).not.toContain("叙事模板");
  expect(div.textContent).not.toContain("编排分镜");
  expect(recent.closest("[hidden]")).toBeNull();
  expect(div.querySelector('[aria-label="工程工作区"]')).toBeNull();
  expect(div.querySelector('[aria-label="创作参数"]')).toBeNull();
  expect(div.querySelector('[aria-label="方案视图"]')).toBeNull();
  await clickVisible(div, "从参考片开始");
  expect(div.querySelector('[aria-label="参考片工具"]')!.closest("[hidden]")).toBeNull();
  await vi.waitFor(() => expect(div.querySelector('[aria-label="参考片工具"]')!.textContent).toContain("参考片 → 可审阅工程"));
});

async function clickVisible(div: HTMLElement, label: string) {
  const target = [...div.querySelectorAll<HTMLButtonElement>("button")].find(button => !button.closest("[hidden]") && button.textContent?.trim() === label);
  expect(target, `visible action: ${label}`).toBeTruthy();
  await act(async () => { target!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
}

it("navigates home, plan and templates while keeping the same editor and unfinished plan alive", async () => {
  stubApi(["mock"]);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const div = await mount();
  const editor = div.querySelector('[aria-label="共享工程编辑"]')!;
  expect(editor.closest("[hidden]")).not.toBeNull();
  await act(async () => { div.querySelector<HTMLButtonElement>(".home-resume")!.click(); });
  expect(editor.closest("[hidden]")).toBeNull();
  await clickVisible(div, "方案");
  await vi.waitFor(() => expect(div.querySelector('[aria-label="创作目标"]')).not.toBeNull());
  const goal = div.querySelector<HTMLTextAreaElement>('[aria-label="创作目标"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(goal, "保留这份尚未制作的方案"); goal.dispatchEvent(new Event("input", { bubbles: true })); });
  await clickVisible(div, "返回作品");
  await clickVisible(div, "浏览模板");
  expect(div.querySelector('[aria-label="模板视图"]')!.closest("[hidden]")).toBeNull();
  expect(goal.closest("[hidden]")).not.toBeNull();
  await clickVisible(div, "返回作品"); await clickVisible(div, "先看方案");
  expect(div.querySelector('[aria-label="创作目标"]')).toBe(goal); expect(goal.value).toBe("保留这份尚未制作的方案");
  await clickVisible(div, "继续编辑工程");
  expect(div.querySelector('[aria-label="共享工程编辑"]')).toBe(editor);
  expect(editor.closest("[hidden]")).toBeNull();
});

it("opens history in one click, saves a version, restores it, and closes options with Escape", async () => {
  stubApi(["mock"]);
  const saved = { id: "history-work", name: "可追溯作品", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.now(), project: editedProject };
  localStorage.setItem("glint.projects", JSON.stringify([saved]));
  const div = await mount();
  await act(async () => { div.querySelector<HTMLButtonElement>(".home-project")!.click(); });
  await clickVisible(div, "历史版本");
  const history = div.querySelector<HTMLElement>('section[aria-label="历史版本"]')!;
  expect(history.closest("[hidden]")).toBeNull(); expect(history.closest("details")).toBeNull();
  expect(history.textContent).toContain("还没有版本");
  await clickVisible(div, "保存项目");
  expect(history.querySelectorAll(".revision-item")).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem("glint.revisions.v1:history-work")!)).toHaveLength(1);
  await clickVisible(div, "恢复");
  expect(div.querySelector('[role="dialog"]')!.closest("[hidden]")).not.toBeNull();
  await clickVisible(div, "更多创作选项");
  const dialog = div.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(div.querySelector('[aria-label="创作参数"]')!.closest("[hidden]")).toBeNull();
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(dialog.closest("[hidden]")).not.toBeNull();
  expect(div.querySelector('[aria-label="共享工程编辑"]')!.closest("[hidden]")).toBeNull();
});

it("keeps the parent editor alive when template descriptions are applied without generating", async () => {
  const fetcher = stubApi(["mock"]);
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  const div = await mount(); const editor = div.querySelector('[aria-label="共享工程编辑"]')!;
  await clickVisible(div, "浏览模板");
  const use = [...div.querySelectorAll<HTMLButtonElement>("button")].find(button => !button.closest("[hidden]") && button.textContent?.includes("套用"));
  if (use) { await act(async () => { use.click(); }); expect(div.querySelector('[aria-label="共享工程编辑"]')).toBe(editor); }
  expect(fetcher.mock.calls.some(([url]) => url === "/api/make" || url === "/api/compose")).toBe(false);
});

it("labels all ten renderable styles", async () => {
  const div = await mount(); await clickVisible(div, "打开工程");
  const select = div.querySelector<HTMLSelectElement>('select[aria-label="风格"]')!;
  expect(select.options).toHaveLength(10);
  expect([...select.options].every(option => (option.textContent ?? "").trim().length > 0)).toBe(true);
  expect(select.options[5]!.textContent).toBe("手绘笔记");
});

function stubApi(voices: string[]) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/make") return Response.json({ jobId: "idea-preflight-test" });
    if (url.startsWith("/api/make/")) return Response.json({ id: "idea-preflight-test", status: "done", log: [] });
    if (url.startsWith("/api/session/")) return Response.json({});
    return Response.json({ id: "idea-preflight-test", status: "done", log: [] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function mountSavedProject() {
  localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "Original", project: editedProject, template: "explainer", theme: "glint-dark", aspect: "16:9" }));
  return mount();
}

it("首页生成后直接载入可编辑工程并登记资料，不提交一次视频渲染", async () => {
  await import("./ProjectComposer"); const mock = stubApi(["mock"]), base = mock.getMockImplementation()!;
  const source = "# 新作品资料\n\n热咖啡放在桌上会逐渐接近室温，记录温度与测量时间。", next = { ...editedProject, id: "new-created-work", title: "新建可编辑工程" };
  mock.mockImplementation(async (url, init) => url === "/api/compose" ? Response.json({ project: next, source, generatedSource: false }) : base(url, init));
  const div = await mount(), area = div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, source); area.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { div.querySelector<HTMLButtonElement>('[aria-label="视频创作起点"] button:last-child')!.click(); }); await clickVisible(div, "开始创作↗");
  expect(div.querySelector('[aria-label="工程工作区"]')!.hasAttribute("hidden")).toBe(false);
  expect(div.querySelector(".workspace-title")?.textContent).toBe(next.title);
  expect(JSON.parse(localStorage.getItem("glint.projects")!)[0]).toMatchObject({ id: next.id, project: next, text: source, evidence: source });
  expect(mock.mock.calls.some(([url]) => url === "/api/make")).toBe(false);
});

it("新建前检查隐藏编辑器的未保存内容；列表满额也不先消耗模型请求", async () => {
  await import("./ProjectComposer"); const mock = stubApi(["mock"]), div = await mount();
  const source = "# 原始资料\n\n这份资料足够长，能够离线生成工程，但作品列表已满时不应继续提交。";
  const entry = { id: "full", name: "旧作品", mode: "source", text: source, template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: 1 };
  localStorage.setItem("glint.projects", JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ ...entry, id: `full-${index}` }))));
  const area = div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, source); area.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { div.querySelector<HTMLButtonElement>('[aria-label="视频创作起点"] button:last-child')!.click(); }); await clickVisible(div, "开始创作↗"); expect(div.textContent).toContain("作品列表已满");
  expect(mock.mock.calls.some(([url]) => url === "/api/compose")).toBe(false);
  expect(JSON.parse(localStorage.getItem("glint.projects")!)).toHaveLength(20);
});

async function choose(div: HTMLElement, label: string, value: string) {
  const select = div.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return select;
}

it("submits the free silent path without any cost confirmation", async () => {
  const fetch = stubApi(["mock", "openai"]);
  const div = await mountSavedProject();
  expect(div.querySelector('[aria-label="出片前预检"]')).not.toBeNull();
  expect(div.querySelector('[aria-label="我确认可能产生费用"]')).toBeNull();
  const submit = [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!;
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = fetch.mock.calls.find(([url]) => url === "/api/make");
  expect(call).toBeTruthy();
  const payload = JSON.parse(call![1]!.body as string);
  expect(payload.tts).toBe("mock");
  expect(payload).not.toHaveProperty("costConfirmed");
});

it("blocks a possibly billable cloud engine until the cost confirmation is checked", async () => {
  const fetch = stubApi(["mock", "openai"]);
  const div = await mountSavedProject();
  await choose(div, "配音", "openai");
  const summary = div.querySelector('[aria-label="出片前预检"]')!;
  expect(summary.textContent).toContain("可能计费");
  expect(summary.textContent).toContain("本机未配置价格表，费用由服务商决定");
  const checkbox = div.querySelector<HTMLInputElement>('[aria-label="我确认可能产生费用"]')!;
  expect(checkbox.checked).toBe(false);
  const submit = [...div.querySelectorAll("button")].find(button => ["生成草稿", "导出 MP4"].includes(button.textContent ?? ""))!;
  expect(submit.disabled).toBe(true);
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(fetch.mock.calls.some(([url]) => url === "/api/make")).toBe(false);
  await act(async () => { checkbox.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox.checked).toBe(true);
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const call = fetch.mock.calls.find(([url]) => url === "/api/make")!;
  const payload = JSON.parse(call[1]!.body as string);
  expect(payload.tts).toBe("openai");
  expect(Object.keys(payload).sort()).toEqual(["aspect", "encoding", "music", "project", "requestId", "template", "theme", "tts"]);
});

it("resets the cost confirmation when engine, encoding or project changes", async () => {
  stubApi(["mock", "openai", "elevenlabs"]);
  const div = await mountSavedProject();
  const checkbox = () => div.querySelector<HTMLInputElement>('[aria-label="我确认可能产生费用"]')!;
  await choose(div, "配音", "openai");
  await act(async () => { checkbox().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox().checked).toBe(true);
  await choose(div, "导出规格", "quality");
  expect(checkbox().checked).toBe(false);
  await act(async () => { checkbox().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox().checked).toBe(true);
  await choose(div, "配音", "elevenlabs");
  expect(checkbox().checked).toBe(false);
  await act(async () => { checkbox().click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox().checked).toBe(true);
  await act(async () => {
    [...div.querySelectorAll("button")].find(button => button.textContent === "添加图表（示例数据）")!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(checkbox().checked).toBe(false);
  expect(div.querySelector('[aria-label="分镜数"]')!.textContent).toBe("3 个");
});

it("shows scene count and the buildTimeline duration before rendering", async () => {
  stubApi(["mock"]);
  const div = await mountSavedProject();
  const project = parseEditorProject(editedProject);
  const summary = div.querySelector('[aria-label="出片前预检"]')!;
  expect(summary.querySelector('[aria-label="分镜数"]')!.textContent).toBe("2 个");
  expect(summary.querySelector('[aria-label="预计总时长"]')!.textContent).toBe(`${(buildTimeline(project).totalMs / 1000).toFixed(1)} 秒`);
  expect(summary.querySelector('[aria-label="配音引擎"]')!.textContent).toBe("无声草稿 · 最快");
  expect(summary.querySelector('[aria-label="导出规格"]')!.textContent).toBe("预览 · 半尺寸 / 快速");
  await choose(div, "导出规格", "quality");
  expect(summary.querySelector('[aria-label="导出规格"]')!.textContent).toBe("母版 · 全尺寸 / CRF16");
});

it("carries the audited source into evidence and the re-review surface after composing (CREATE-14)", async () => {
  const source = "# 审查资料\n\n熵在孤立系统里只增不减。\n";
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/compose") {
      expect(JSON.parse(String(init!.body)).source).toBe(source);
      return Response.json({
        project: editedProject,
        source,
        review: { version: 1, basis: "词汇匹配候选；匹配不等于事实正确", sourceChars: source.length, flagged: 1,
          sentences: [{ sceneId: "one", text: "第一句", flags: ["no-candidate"], candidates: [] }] },
      });
    }
    if (url === "/api/review") {
      return Response.json({ version: 1, basis: "词汇匹配候选；匹配不等于事实正确", sourceChars: source.length, flagged: 1,
        sentences: [{ sceneId: "one", text: "第一句", flags: ["no-candidate"], candidates: [] }] });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch);
  const div = await mount(); await clickVisible(div, "打开工程");
  const input = div.querySelector<HTMLTextAreaElement>("#make-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, source);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Before composing there is no project and nothing to re-check against.
  expect([...div.querySelectorAll("button")].find(button => button.textContent === "重新核对旁白依据")).toBeUndefined();
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "生成分镜")!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  // The audit source came back with the project: re-review is armed and the
  // flagged sentence renders with its basis disclaimer, not a truth verdict.
  expect([...div.querySelectorAll("button")].find(button => button.textContent === "重新核对旁白依据")!.disabled).toBe(false);
  expect(div.textContent).toContain("旁白依据核对 · 1/1 句待看");
  expect(div.textContent).toContain("词汇匹配候选；匹配不等于事实正确");
  expect(div.textContent).toContain("no-candidate");
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent === "重新核对旁白依据")!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(fetch.mock.calls.filter(([url]) => url === "/api/review").length).toBe(1);
});
it("keeps reference review open after adopting the generated project", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [{name:"reference.mp4"}] });
    if (url === "/api/reference/build") return Response.json({project:editedProject, shots:2, inferred:true});
    return Response.json({});
  }));
  const div = await mount();
  await clickVisible(div, "从参考片开始");
  await vi.waitFor(() => expect(div.querySelector('[aria-label="从参考片重建工程"] summary')).not.toBeNull());
  await act(async () => div.querySelector<HTMLElement>('[aria-label="从参考片重建工程"] summary')!.click());
  await vi.waitFor(() => expect(div.querySelector<HTMLSelectElement>('[aria-label="选择参考片"]')!.value).toBe("reference.mp4"));
  await act(async () => div.querySelector<HTMLInputElement>('[aria-label="从参考片重建工程"] input[type="checkbox"]')!.click());
  await clickVisible(div, "分析并生成工程");
  await vi.waitFor(() => expect(div.querySelector('[aria-label="分镜编辑器"]')).not.toBeNull());
  expect(div.querySelector('[aria-label="参考片工具"]')!.closest("[hidden]")).toBeNull();
  expect(div.querySelector('#workspace-tools')!.getAttribute("aria-label")).toBe("参考片");
});
