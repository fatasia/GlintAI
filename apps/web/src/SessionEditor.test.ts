// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { SessionEditor } from "./SessionEditor";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); localStorage.clear(); });

const project = parseProject({
  schemaVersion: 1, id: "freeze-ui", title: "冻结演示", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 500 } }],
});

it("keeps shared storyboard undo unavailable until the pending edit is acknowledged", async () => {
  let acknowledge!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { acknowledge = resolve; });
  const edited = parseProject({ ...project, scenes: [{ ...project.scenes[0], narration: { text: "a", durationMs: 400 } }] });
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/api/session/apply")) return pending;
    if (url.endsWith("/api/session/undo")) return reply({ snapshot: { document: project, revision: 2 }, look: { revision: 2, undoDepth: 0, redoDepth: 1, selection: [] }, receipt: { stage: "verified", baseRevision: 1, reason: "" } });
    return reply({ snapshot: { document: project, revision: 0 }, look: { revision: 0, undoDepth: 0, redoDepth: 0, selection: [] } });
  }); vi.stubGlobal("fetch", fetch);
  const div = mountEditor();
  await waitUntil(div, () => div.textContent?.includes("共享工程 · r0") === true);
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "末尾 −100 毫秒")!.click());
  await act(async () => [...div.querySelectorAll(".glint-view-switch button")].find(button => button.textContent === "分镜")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await waitUntil(div, () => fetch.mock.calls.some(([url]) => url.endsWith("/api/session/apply")));
  const undo = div.querySelector<HTMLButtonElement>('button[aria-label="撤销"]')!;
  expect(undo.disabled).toBe(true);
  await act(async () => undo.click()); expect(fetch.mock.calls.some(([url]) => url.endsWith("/api/session/undo"))).toBe(false);
  await act(async () => acknowledge(reply({ snapshot: { document: edited, revision: 1 }, look: { revision: 1, undoDepth: 1, redoDepth: 0, selection: [] }, receipt: { stage: "verified", baseRevision: 0, reason: "" } })));
  await waitUntil(div, () => !undo.disabled);
  await act(async () => undo.click());
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/api/session/undo"))).toHaveLength(1);
});

type FreezeTx = { id: string; actor: string; baseRevision: number; operations: Array<{ kind: string; path: string[]; value?: boolean }> };
interface Reply { snapshot: { document: SceneScriptProject; revision: number }; look: { revision: number; undoDepth: number; redoDepth: number; selection: string[] }; receipt?: { stage: string; baseRevision: number; reason: string } }
const reply = (value: Reply, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** 本地 mock 会话服务：脚本化 open/apply，记录事务；非会话请求（如缩略图）返回空载荷。 */
function mockServer(handler?: (tx: FreezeTx) => Response) {
  const applies: FreezeTx[] = [];
  let revision = 2;
  let frozen: boolean | undefined;
  const doc = (): SceneScriptProject => (frozen === undefined ? project : { ...project, frozen });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { transaction?: FreezeTx } : undefined;
    if (url.endsWith("/api/session/open")) return reply({ snapshot: { document: doc(), revision }, look: { revision, undoDepth: 0, redoDepth: 0, selection: [] } });
    if (url.endsWith("/api/session/apply")) {
      const tx = body!.transaction!;
      applies.push(tx);
      if (tx.operations[0]?.path[0] === "frozen") frozen = tx.operations[0].value;
      revision += 1;
      return handler ? handler(tx) : reply({ snapshot: { document: doc(), revision }, look: { revision, undoDepth: 0, redoDepth: 0, selection: [] }, receipt: { stage: "verified", baseRevision: tx.baseRevision, reason: "" } });
    }
    return reply({ snapshot: { document: project, revision }, look: { revision, undoDepth: 0, redoDepth: 0, selection: [] } });
  }));
  return applies;
}

/** 按真实父组件契约挂载：onChange 回写 project，形成受控循环。 */
function mountEditor() {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root: { current: Root | null } = { current: createRoot(div) };
  let current = project;
  const render = () => act(() => { root.current!.render(createElement(SessionEditor, { project: current, voiceEngine: "test", onFork: () => {}, onChange: value => { current = value; render(); } })); });
  cleanup = () => act(() => { root.current!.unmount(); root.current = null; });
  render();
  return div;
}

const waitUntil = async (div: HTMLDivElement, condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  throw new Error(`condition not reached; status text: ${JSON.stringify(div.querySelector('[aria-label="批准冻结状态"]')?.textContent)}; header: ${JSON.stringify(div.querySelector('[aria-label="共享工程编辑"] > div')?.textContent)}`);
};
const lockButton = (div: HTMLDivElement) => div.querySelector<HTMLButtonElement>('[aria-label="冻结工程"], [aria-label="解冻工程"]')!;

it("shows the freeze control, locks the editor while frozen and unlocks on demand (TEAM-09)", async () => {
  const applies = mockServer();
  const div = mountEditor();
  await waitUntil(div, () => (div.textContent ?? "").includes("共享工程 · r"));
  expect(lockButton(div).textContent).toBe("批准冻结");
  expect(lockButton(div).disabled).toBe(false);
  expect(div.querySelector('[aria-label="批准冻结状态"]')?.textContent).toBe("未冻结");
  expect(div.querySelector('[aria-label="工程编辑区"]')?.getAttribute("aria-disabled")).toBe("false");

  await act(async () => { lockButton(div).click(); });
  await waitUntil(div, () => (div.querySelector('[aria-label="批准冻结状态"]')?.textContent ?? "").includes("已批准冻结") && !lockButton(div).disabled);
  expect(applies).toHaveLength(1);
  expect(applies[0]).toMatchObject({ actor: "user", baseRevision: 2, operations: [{ kind: "set", path: ["frozen"], value: true }] });
  expect(lockButton(div).getAttribute("aria-label")).toBe("解冻工程");
  expect(lockButton(div).textContent).toBe("解冻（所有者）");
  const editor = div.querySelector('[aria-label="工程编辑区"]')!;
  expect(editor.getAttribute("aria-disabled")).toBe("true");
  expect((editor as HTMLElement).style.pointerEvents).toBe("none");

  await act(async () => { lockButton(div).click(); });
  await waitUntil(div, () => (div.querySelector('[aria-label="批准冻结状态"]')?.textContent ?? "").includes("未冻结") && !lockButton(div).disabled);
  expect(applies).toHaveLength(2);
  expect(applies[1]).toMatchObject({ actor: "user", baseRevision: 3, operations: [{ kind: "set", path: ["frozen"], value: false }] });
  expect(div.querySelector('[aria-label="工程编辑区"]')?.getAttribute("aria-disabled")).toBe("false");
});

it("offers an explicit safe copy when an imported approval cannot be trusted", async () => {
  const imported = parseProject({ ...project, frozen: true, assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝衣", voice: "voice", refs: ["assets/hero.png"], approval: { name: "小雨", version: "v1", description: "蓝衣", voice: "voice", refs: ["assets/hero.png"] } }], scenes: [{ ...project.scenes[0], assetRefs: [{ assetId: "hero", version: "v1" }] }] });
  const calls: SceneScriptProject[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/session/open")) {
      const body = JSON.parse(String(init?.body)); calls.push(body.project);
      if (body.project.id === imported.id) return new Response(JSON.stringify({ code: "untrusted-import", error: "Imported approvals are not trusted" }), { status: 409 });
      return reply({ snapshot: { document: body.project, revision: 0 }, look: { revision: 0, undoDepth: 0, redoDepth: 0, selection: [] } });
    }
    return new Response(JSON.stringify({ assets: [] }), { status: 200 });
  }));
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); let current = imported, version = 0;
  const render = () => act(() => { root.render(createElement(SessionEditor, { key: `${current.id}-${version}`, project: current, voiceEngine: "test", onFork: value => { current = value; version++; render(); }, onChange: value => { current = value; render(); } })); });
  cleanup = () => act(() => root.unmount()); render();
  await waitUntil(div, () => div.textContent?.includes("无法验证的旧批准记录") === true);
  expect(calls).toHaveLength(1); expect(calls[0]).toEqual(imported);
  expect(div.textContent).toContain("逐项重新批准"); expect(div.textContent).toContain("图片缺失时请先导入素材库");
  const button = [...div.querySelectorAll("button")].find(item => item.textContent === "保留原件并创建待重新批准副本")!;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  await waitUntil(div, () => calls.length === 2);
  expect(calls[1]!.id).not.toBe(imported.id);
  expect(calls[1]!.frozen).toBe(false); expect(calls[1]!.assets![0]!.approval).toBeUndefined();
  expect(calls[1]!.assets![0]!.refs).toEqual(imported.assets![0]!.refs);
  expect(calls[1]!.scenes[0]!.assetRefs).toEqual(imported.scenes[0]!.assetRefs);
  expect(JSON.parse(localStorage.getItem(`glint.session-draft:${imported.id}`)!)).toEqual(imported);
  expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith(`glint.session-backup:${imported.id}:`))!)!)).toEqual(imported);
  await waitUntil(div, () => div.textContent?.includes("共享工程 · r0") === true);
});

it("clears approvals and freeze when branching a conflicting approved project", async () => {
  const imported = parseProject({ ...project, frozen: true, assets: [{ id: "item", kind: "product", name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"], approval: { name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] } }] });
  let forked: SceneScriptProject | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/api/session/open")
    ? Response.json({ snapshot: { document: { ...imported, title: "共享版本" }, revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] }, conflict: true })
    : Response.json({ assets: [] })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(SessionEditor, { project: imported, voiceEngine: "test", onFork: value => { forked = value; }, onChange: () => {} })); });
  await waitUntil(div, () => div.textContent?.includes("另存为新工程") === true);
  await act(async () => { [...div.querySelectorAll("button")].find(item => item.textContent === "另存为新工程")!.click(); });
  expect(forked?.id).not.toBe(imported.id);
  expect(forked?.frozen).toBe(false);
  expect(forked?.assets?.[0]?.approval).toBeUndefined();
  expect(forked?.assets?.[0]?.refs).toEqual(imported.assets?.[0]?.refs);
  expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith(`glint.session-backup:${imported.id}:`))!)!)).toEqual(imported);
});

const editSceneTitle = async (div: HTMLDivElement, value: string) => {
  const field = div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!;
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it.each(["undo", "redo"] as const)("retains real editor input while shared %s completes", async action => {
  const shared = { ...project, title: `server ${action}` };
  let release!: (response: Response) => void;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/api/session/open")) return Response.json({ snapshot: { document: project, revision: 1 }, look: { revision: 1, undoDepth: 1, redoDepth: 1, selection: [] } });
    if (url.endsWith(`/api/session/${action}`)) return new Promise<Response>(resolve => { release = resolve; });
    if (url.includes("/api/session/")) throw new Error(`unexpected ${url}`);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const div = mountEditor(); await waitUntil(div, () => div.textContent?.includes("共享工程 · r1") === true);
  const button = [...div.querySelectorAll("button")].find(item => item.textContent === (action === "undo" ? "撤销" : "重做"))!;
  await act(async () => { button.click(); });
  await editSceneTitle(div, "请求期间的新输入");
  await act(async () => { release(Response.json({ snapshot: { document: shared, revision: 2 }, look: { revision: 2, undoDepth: 1, redoDepth: 1, selection: [] }, receipt: { stage: "saved", revision: 2, baseRevision: 1 } })); });
  await waitUntil(div, () => div.textContent?.includes("版本不同，草稿仍保留") === true);
  expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("请求期间的新输入");
  expect(div.textContent).toContain("共享操作已保存，但本地草稿同时变化");
  expect(JSON.parse(localStorage.getItem(`glint.session-draft:${project.id}`)!).scenes[0].title).toBe("请求期间的新输入");
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/api/session/apply"))).toHaveLength(0);
});

it("retains real editor input made after backup until the shared reload completes", async () => {
  const shared = { ...project, title: "共享版本" };
  let release!: (response: Response) => void;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/api/session/open")) return Response.json({ snapshot: { document: shared, revision: 2 }, look: { revision: 2, undoDepth: 0, redoDepth: 0, selection: [] }, conflict: true });
    if (url.includes("/api/session/snapshot")) return new Promise<Response>(resolve => { release = resolve; });
    if (url.includes("/api/session/")) throw new Error(`unexpected ${url}`);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const div = mountEditor(); await waitUntil(div, () => div.textContent?.includes("保留副本并接续共享版本") === true);
  await act(async () => { [...div.querySelectorAll("button")].find(item => item.textContent === "保留副本并接续共享版本")!.click(); });
  expect(div.textContent).toContain("正在读取共享版本");
  const key = Object.keys(localStorage).find(item => item.startsWith(`glint.session-backup:${project.id}:`))!;
  expect(JSON.parse(localStorage.getItem(key)!).scenes[0].title).toBe("One");
  await editSceneTitle(div, "备份之后输入");
  await act(async () => { release(Response.json({ snapshot: { document: shared, revision: 2 }, look: { revision: 2, undoDepth: 0, redoDepth: 0, selection: [] } })); });
  await waitUntil(div, () => div.textContent?.includes("尚未接续共享版本") === true && div.textContent?.includes("保留副本并接续共享版本") === true);
  expect(div.textContent).toContain("尚未接续共享版本");
  expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("备份之后输入");
  expect(JSON.parse(localStorage.getItem(`glint.session-draft:${project.id}`)!).scenes[0].title).toBe("备份之后输入");
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/api/session/apply"))).toHaveLength(0);
});

it("does not start a reload if the independent backup fails", async () => {
  const shared = { ...project, title: "共享版本" };
  const fetcher = vi.fn(async (url: string) => url.endsWith("/api/session/open")
    ? Response.json({ snapshot: { document: shared, revision: 1 }, look: { revision: 1, undoDepth: 0, redoDepth: 0, selection: [] }, conflict: true })
    : Response.json({ assets: [] }));
  vi.stubGlobal("fetch", fetcher);
  const div = mountEditor(); await waitUntil(div, () => div.textContent?.includes("保留副本并接续共享版本") === true);
  const original = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith("glint.session-backup:")) throw new DOMException("quota", "QuotaExceededError");
    return original.call(this, key, value);
  });
  try {
    await act(async () => { [...div.querySelectorAll("button")].find(item => item.textContent === "保留副本并接续共享版本")!.click(); });
    expect(div.textContent).toContain("无法保留本地副本");
    expect(div.querySelector<HTMLTextAreaElement>('textarea[aria-label="title"]')!.value).toBe("One");
    expect(fetcher.mock.calls.some(([url]) => url.includes("/api/session/snapshot"))).toBe(false);
  } finally { spy.mockRestore(); }
});

it("surfaces the frozen 409 refusal text with the conflict banner", async () => {
  // 模拟竞态：另一入口先冻结了工程，本入口的冻结请求被服务器以 409 拒绝。
  const applies = mockServer(tx => reply({
    snapshot: { document: { ...project, frozen: true }, revision: 2 }, look: { revision: 2, undoDepth: 0, redoDepth: 0, selection: [] },
    receipt: { stage: "refused", baseRevision: tx.baseRevision, reason: "Project is frozen for approval; only the owner can unfreeze it" },
  }, 409));
  const div = mountEditor();
  await waitUntil(div, () => (div.textContent ?? "").includes("共享工程 · r"));
  await act(async () => { lockButton(div).click(); });
  await waitUntil(div, () => (div.textContent ?? "").includes("frozen for approval"));
  expect(applies).toHaveLength(1);
  expect((div.textContent ?? "")).toContain("版本不同，草稿仍保留");
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("查看共享版本与本地草稿的不同字段");
});
