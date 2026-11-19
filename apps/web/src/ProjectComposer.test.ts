// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectComposer } from "./ProjectComposer";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); dispose = () => {}; localStorage.clear(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const pendingKey = "glint:project-compose-pending.v1";
const material = "# 咖啡实验\n\n热咖啡放在桌上，温度会逐渐接近室温。每隔一分钟测量并记录温度，同时记录室温。";
const project = { schemaVersion: 1, id: "editor-created", title: "咖啡实验", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "咖啡实验", narration: { text: "观察热咖啡如何降温。" } }] };
const result = { project, source: material, generatedSource: false };
function api(configured = false, compose: (init: RequestInit) => Promise<Response> = async () => Response.json(result)) {
  const mock = vi.fn(async (url: string, init: RequestInit = {}) => url === "/api/settings/llm" ? Response.json({ configured }) : compose(init));
  vi.stubGlobal("fetch", mock); return mock;
}
async function mount(props: Partial<Parameters<typeof ProjectComposer>[0]> = {}) {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  dispose = () => act(() => root.unmount()); const onCreated = vi.fn();
  await act(async () => { root.render(createElement(ProjectComposer, { onCreated, ...props })); await Promise.resolve(); });
  const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const edit = async (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, text); area.dispatchEvent(new Event("input", { bubbles: true })); });
  const click = async (label: string) => act(async () => { const button = [...host.querySelectorAll("button")].find(item => item.textContent?.replace("↗", "") === label); if (!button) throw Error(`Missing ${label}`); button.click(); await Promise.resolve(); });
  return { host, area, edit, click, onCreated };
}
const posts = (mock: ReturnType<typeof api>) => mock.mock.calls.filter(([url]) => url === "/api/compose");

it("资料直接生成可编辑工程，不先调用视频渲染或丢掉生成依据", async () => {
  const mock = api(), h = await mount(); await h.edit(material); await h.click("开始创作");
  expect(posts(mock)).toHaveLength(1);
  expect(JSON.parse(posts(mock)[0]![1]!.body as string)).toMatchObject({ source: material, engine: "heuristic", aspect: "16:9", requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(mock.mock.calls.some(([url]) => url.startsWith("/api/make"))).toBe(false);
  expect(h.onCreated).toHaveBeenCalledWith(expect.objectContaining(result), expect.objectContaining({ input: material, mode: "source" }));
  expect(localStorage.getItem(pendingKey)).toBeNull();
});
it("无模型时给连接与免费示例路径，不将创作要求悄悄降级成照抄字卡", async () => {
  const mock = api(), onOpenSettings = vi.fn(), h = await mount({ onOpenSettings });
  await h.edit("帮我制作一条咖啡广告，精致一点"); await h.click("开始创作"); expect(posts(mock)).toHaveLength(0);
  await h.click("连接模型"); expect(onOpenSettings).toHaveBeenCalledOnce();
  vi.spyOn(window, "confirm").mockReturnValue(true); await h.click("用示例资料试试");
  expect(h.area.value).toContain("热咖啡"); await h.click("开始创作"); expect(posts(mock)).toHaveLength(1);
});
it("模型配置保存事件刷新能力，不清除已经输入的描述", async () => {
  let configured = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("settings") ? { configured } : { ...result, generatedSource: true })));
  const h = await mount(); await h.edit("帮我制作一条咖啡广告，精致一点"); configured = true;
  await act(async () => { window.dispatchEvent(new Event("glint:model-settings")); await Promise.resolve(); });
  expect(h.area.value).toContain("咖啡广告"); await h.click("开始创作");
  expect(h.onCreated).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "idea" }));
});
it("网络未确认后刷新只保留回执，明确恢复复用原 requestId 和原输入", async () => {
  const mock = api(false, async () => { throw Error("network"); }), h = await mount();
  await h.edit(material); await h.click("开始创作"); const first = JSON.parse(posts(mock)[0]![1]!.body as string);
  dispose(); mock.mockImplementation(async (url: string) => Response.json(url.includes("settings") ? { configured: false } : result));
  const next = await mount(); expect(posts(mock)).toHaveLength(1); expect(next.area.value).toBe(material);
  await next.edit("另一个暂未提交的描述"); await next.click("恢复生成结果");
  expect(posts(mock)).toHaveLength(2); expect(JSON.parse(posts(mock)[1]![1]!.body as string)).toEqual(first);
});
it("生成完成后离开预检拒绝，保留结果；保存原稿后直接打开，不再请求模型", async () => {
  const mock = api(), guard = vi.fn<() => void>(() => { throw Error("批注尚未保存"); }), beforeCreate = vi.fn(() => guard);
  const h = await mount({ beforeCreate }); await h.edit(material); await h.click("开始创作");
  expect(h.onCreated).not.toHaveBeenCalled(); expect(h.host.textContent).toContain("批注尚未保存");
  expect(JSON.parse(localStorage.getItem(pendingKey)!).result.project.id).toBe(project.id);
  guard.mockImplementation(() => {}); await h.click("打开已生成工程"); expect(h.onCreated).toHaveBeenCalledOnce(); expect(posts(mock)).toHaveLength(1);
});
it("发送前预检拒绝时不写回执、不请求模型", async () => {
  const mock = api(), h = await mount({ beforeCreate: () => { throw Error("请先完成中文输入"); } });
  await h.edit(material); await h.click("开始创作"); expect(posts(mock)).toHaveLength(0); expect(localStorage.getItem(pendingKey)).toBeNull();
});
it("父工程保存失败保留可重新打开的结果，重挂也不会重复生成", async () => {
  const mock = api(), h = await mount({ onCreated: () => { throw Error("作品列表已满"); } });
  await h.edit(material); await h.click("开始创作"); expect(h.host.textContent).toContain("作品列表已满"); dispose();
  const next = await mount(); await next.click("打开已生成工程"); expect(next.onCreated).toHaveBeenCalledOnce(); expect(posts(mock)).toHaveLength(1);
});
it.each([400, 413, 503])("已知拒绝 %s 保留输入并允许修正后新请求", async status => {
  const mock = api(false, async () => Response.json({ error: "请修正输入" }, { status })), h = await mount();
  await h.edit(material); await h.click("开始创作"); expect(localStorage.getItem(pendingKey)).toBeNull(); expect(h.area.value).toBe(material);
  await h.click("开始创作"); expect(posts(mock)).toHaveLength(2);
  expect(JSON.parse(posts(mock)[0]![1]!.body as string).requestId).not.toBe(JSON.parse(posts(mock)[1]![1]!.body as string).requestId);
});
it("损坏回执失败关闭，不覆盖原始记录", async () => {
  const mock = api(); localStorage.setItem(pendingKey, "{"); const h = await mount(); await h.edit(material); await h.click("开始创作");
  expect(posts(mock)).toHaveLength(0); expect(localStorage.getItem(pendingKey)).toBe("{"); expect(h.host.textContent).toContain("上次生成记录无法读取");
});
it("回执静默丢写或配额失败时不开始生成", async () => {
  const mock = api(), h = await mount(), write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) { if (key !== pendingKey) write.call(this, key, value); });
  await h.edit(material); await h.click("开始创作"); expect(posts(mock)).toHaveLength(0); expect(h.host.textContent).toContain("写入未确认");
});
it("同步重复点击仅发一次请求；处理中禁用输入与新任务", async () => {
  let resolve!: (response: Response) => void;
  const mock = api(false, () => new Promise(done => { resolve = done; })), h = await mount(); await h.edit(material);
  await act(async () => { h.host.querySelector<HTMLButtonElement>(".pc-submit")!.click(); h.host.querySelector<HTMLButtonElement>(".pc-submit")!.click(); });
  expect(posts(mock)).toHaveLength(1); expect(h.area.disabled).toBe(true);
  await act(async () => { resolve(Response.json(result)); await Promise.resolve(); }); expect(h.onCreated).toHaveBeenCalledOnce();
});
it("中文组合输入期间快捷键不提交，结束后提交一次", async () => {
  const mock = api(), h = await mount(); await h.edit(material);
  await act(async () => { h.area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); h.area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
  expect(posts(mock)).toHaveLength(0);
  await act(async () => { h.area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); h.area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); await Promise.resolve(); });
  expect(posts(mock)).toHaveLength(1);
});
it("非法成功响应不清回执，也不把不完整工程交给编辑器", async () => {
  api(false, async () => Response.json({ project: { id: "broken" }, source: material, generatedSource: false }));
  const h = await mount(); await h.edit(material); await h.click("开始创作"); expect(h.onCreated).not.toHaveBeenCalled(); expect(localStorage.getItem(pendingKey)).not.toBeNull();
});
it("示例替换取消时保留用户原始描述", async () => {
  api(); const h = await mount(); await h.edit(material); vi.spyOn(window, "confirm").mockReturnValue(false); await h.click("用示例资料试试"); expect(h.area.value).toBe(material);
});
