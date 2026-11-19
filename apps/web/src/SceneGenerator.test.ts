// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { SceneGenerator } from "./SceneGenerator";
import { sceneReworkContext } from "./scene-rework";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (name: string, _options: unknown, callback: (lock: { name: string } | null) => Promise<unknown>) => {
    if (held.has(name)) return callback(null);
    held.add(name); try { return await callback({ name }); } finally { held.delete(name); }
  } } });
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (navigator as { locks?: unknown }).locks; });
const project = (kind: "image" | "title" = "image") => parseProject({ schemaVersion: 1, id: "gen", title: "Gen", aspect: "16:9", knowledgeSources: [],
  scenes: [kind === "image"
    ? { id: "one", kind: "image", src: "assets/old.png", narration: { text: "一张旧图", durationMs: 1000 }, effects: [{ id: "mono", kind: "grayscale", value: 1 }] }
    : { id: "one", kind: "title", title: "纯文字", narration: { text: "文字镜头", durationMs: 1000 } }] });
function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 30)); }); };
const savedTask = (taskId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 2, taskId, projectId: "gen", sceneId: "one", basis: sceneReworkContext(project(), "one").basis, requestId: "request-12345678", signature: "saved", ...extra });
async function mount(initial = project(), onAdoptReferenceCandidate?: (taskId: string, mode: "replace" | "insert") => Promise<boolean>) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), changes: SceneScriptProject[] = [], selected: string[] = [];
  cleanups.push(() => act(() => root.unmount()));
  let changeProject!: (value: SceneScriptProject) => void;
  function Harness() { const [value, setValue] = useState(initial); changeProject = setValue; return createElement(SceneGenerator, { project: value, sceneId: "one", pollMs: 0, onAdoptReferenceCandidate, onChange: next => { changes.push(next); setValue(next); }, onSelect: id => selected.push(id) }); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { const details = div.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  await flush();
  const click = async (text: string) => act(async () => { const target = [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text)); if (!target) throw new Error(`missing button ${text}`); target.click(); });
  const consent = async () => act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const setProject = async (value: SceneScriptProject) => act(async () => changeProject(value));
  return { div, changes, selected, click, consent, setProject };
}
function happy() {
  return stub((url, init) => {
    if (url.startsWith("/api/media/models")) return Response.json({ configured: true, models: [{ id: "m1", name: "Image One" }] });
    if (url === "/api/media/submit") return Response.json({ taskId: "task-1" });
    if (url === "/api/media/status/task-1") return Response.json({ taskId: "task-1", state: "success", isFinal: true, assetUrl: "/api/media/assets/gen.png", cost: 0.12 });
    return Response.json({});
  });
}
describe("generation recovery", () => {
  it("restores a finished candidate for the same scene without calling the gateway", async () => {
    const fetcher = stub((url) => url.startsWith("/api/media/models") ? Response.json({ configured: true, models: [{ id: "m1", name: "Image One" }] }) : Response.json({}));
    localStorage.setItem("glint.scene-generation:v2:gen:one", savedTask("task-9", { isFinal: true, assetUrl: "/api/media/assets/gen.png" }));
    const h = await mount();
    expect(h.div.querySelector('img[aria-label="候选生成图片"]')?.getAttribute("src")).toBe("/api/media/assets/gen.png");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/media/status/"))).toBe(false);
  });
  it("keeps polling an unfinished task after a reload", async () => {
    stub((url) => {
      if (url.startsWith("/api/media/models")) return Response.json({ configured: true, models: [{ id: "m1", name: "Image One" }] });
      if (url === "/api/media/status/task-9") return Response.json({ taskId: "task-9", state: "success", isFinal: true, assetUrl: "/api/media/assets/gen.png" });
      return Response.json({});
    });
    localStorage.setItem("glint.scene-generation:v2:gen:one", savedTask("task-9"));
    const h = await mount();
    await flush(); await flush();
    expect(h.div.querySelector('img[aria-label="候选生成图片"]')).not.toBeNull();
  });
  it("does not restore a legacy candidate or a candidate from another project", async () => {
    const fetcher = stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : Response.json({}));
    localStorage.setItem("glint.scene-generation", JSON.stringify({ taskId: "task-9", sceneId: "one", isFinal: true, assetUrl: "/api/media/assets/gen.png" }));
    const h = await mount(); expect(h.div.querySelector('img[aria-label="候选生成图片"]')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/api/media/status/"))).toBe(false);
    expect(h.div.textContent).toContain("旧任务缺少工程归属");
  });
});describe("in-editor scene generator", () => {
  it("requires explicit consent and sends one confirmed gateway request", async () => {
    const fetcher = happy();
    const h = await mount();
    expect(h.div.textContent).toContain("可能产生费用");
    expect(h.div.querySelector<HTMLButtonElement>("button")!.disabled || [...h.div.querySelectorAll("button")].find(b => b.textContent?.includes("生成候选"))!.disabled).toBe(true);
    await h.consent();
    await h.click("生成候选");
    await flush();
    const submit = fetcher.mock.calls.find(([url]) => String(url) === "/api/media/submit")!;
    const body = JSON.parse(String((submit[1] as RequestInit).body));
    expect(body).toMatchObject({ type: "image", model: "m1", params: {} });
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(h.div.querySelector('img[aria-label="候选生成图片"]')?.getAttribute("src")).toBe("/api/media/assets/gen.png");
    expect(h.div.textContent).toContain("确认后再采用");
  });
  it("adopts a candidate only on an explicit click and keeps effects", async () => {
    happy();
    const h = await mount();
    await h.consent(); await h.click("生成候选"); await flush();
    expect(h.changes).toHaveLength(0);
    await h.click("用候选替换当前镜头");
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.scenes[0]).toMatchObject({ id: "one", kind: "image", src: "assets/gen.png", effects: [{ id: "mono", kind: "grayscale", value: 1 }] });
  });
  it("does not silently adopt a gateway failure or an external asset URL", async () => {
    stub((url) => {
      if (url.startsWith("/api/media/models")) return Response.json({ configured: true, models: [{ id: "m1", name: "Image One" }] });
      if (url === "/api/media/submit") return Response.json({ taskId: "task-1" });
      if (url === "/api/media/status/task-1") return Response.json({ taskId: "task-1", state: "failed", isFinal: true });
      return Response.json({});
    });
    const h = await mount();
    await h.consent(); await h.click("生成候选"); await flush();
    expect(h.changes).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("没有可用素材");
    vi.unstubAllGlobals();
    stub((url) => {
      if (url.startsWith("/api/media/models")) return Response.json({ configured: true, models: [{ id: "m1", name: "Image One" }] });
      if (url === "/api/media/submit") return Response.json({ taskId: "task-1" });
      if (url === "/api/media/status/task-1") return Response.json({ taskId: "task-1", isFinal: true, assetUrl: "https://evil.example/x.png" });
      return Response.json({});
    });
    const second = await mount();
    await second.consent(); await second.click("生成候选"); await flush();
    expect(second.div.querySelector('img[aria-label="候选生成图片"]')).toBeNull();
    expect([...second.div.querySelectorAll("button")].some(button => button.textContent?.includes("用候选替换当前镜头"))).toBe(false);
  });
  it("explains an unconfigured gateway and offers insert-only for structured scenes", async () => {
    stub((url) => url.startsWith("/api/media/models") ? Response.json({ configured: false, models: [] }) : Response.json({}));
    const h = await mount();
    expect(h.div.textContent).toContain("尚未配置媒体网关");
    vi.unstubAllGlobals();
    stub((url) => {
      if (url.startsWith("/api/media/models")) return Response.json({ configured: true, models: [{ id: "m1", name: "Image One" }] });
      if (url === "/api/media/submit") return Response.json({ taskId: "task-1" });
      if (url === "/api/media/status/task-1") return Response.json({ taskId: "task-1", isFinal: true, assetUrl: "/api/media/assets/gen.png" });
      return Response.json({});
    });
    const structured = await mount(project("title"));
    await structured.consent(); await structured.click("生成候选"); await flush();
    expect([...structured.div.querySelectorAll("button")].find(button => button.textContent === "用候选替换当前镜头")!.disabled).toBe(true);
    await structured.click("添加为新镜头");
    expect(structured.changes[0]!.scenes).toHaveLength(2);
    expect(structured.changes[0]!.scenes[0]).toEqual(project("title").scenes[0]);
  });
  it("sends video duration/aspect params and validates them before submit", async () => {
    const fetcher = stub((url) => {
      if (url.startsWith("/api/media/models")) return Response.json({ configured: true, models: [{ id: "v1", name: "Video One" }] });
      if (url === "/api/media/submit") return Response.json({ taskId: "task-v" });
      if (url === "/api/media/status/task-v") return Response.json({ taskId: "task-v", state: "success", isFinal: true, assetUrl: "/api/media/assets/gen.mp4" });
      return Response.json({});
    });
    const h = await mount();
    await act(async () => {
      const select = h.div.querySelector<HTMLSelectElement>('select[aria-label="生成素材类型"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "video"); select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await h.consent(); await h.click("生成候选"); await flush();
    const submit = fetcher.mock.calls.find(([url]) => String(url) === "/api/media/submit")!;
    expect(JSON.parse(String((submit[1] as RequestInit).body)).params).toEqual({ aspect: "16:9", duration: 5, resolution: "480P" });
    expect(h.div.querySelector('video[aria-label="候选生成视频"]')).not.toBeNull();
  });
});

describe("single-shot regeneration safety", () => {
  it("refuses paid submissions when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const fetcher = happy(), h = await mount(); await h.consent(); await h.click("生成候选");
    expect(h.div.textContent).toContain("不支持跨标签页互斥");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
  });
  it("allows only one concurrent paid submission for the same project and shot", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const fetcher = stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : url === "/api/media/submit" ? pending : url === "/api/media/status/task-1" ? Response.json({ taskId: "task-1", isFinal: true, assetUrl: "/api/media/assets/gen.png" }) : Response.json({}));
    const a = await mount(), b = await mount(); await a.consent(); await b.consent(); await a.click("生成候选"); await b.click("生成候选");
    expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/media/submit")).toHaveLength(1);
    expect(b.div.textContent).toContain("另一个标签页");
    await act(async () => resolve(Response.json({ taskId: "task-1" }))); await flush();
    expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/media/submit")).toHaveLength(1);
  });
  it("treats a server HTTP 400 as uncertain and retains the request ID", async () => {
    const fetcher = stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : url === "/api/media/submit" ? new Response("{}", { status: 400 }) : new Response("{}", { status: 404 }));
    const h = await mount(); await h.consent(); await h.click("生成候选"); await flush();
    const submit = fetcher.mock.calls.find(([url]) => String(url) === "/api/media/submit")!;
    const requestId = JSON.parse(String((submit[1] as RequestInit).body)).requestId;
    expect(fetcher.mock.calls.some(([url]) => String(url) === `/api/media/request/${requestId}`)).toBe(true);
    expect(JSON.parse(localStorage.getItem("glint.scene-generation:v2:gen:one")!).requestId).toBe(requestId);
    expect(h.div.textContent).toContain("提交回执未确认");
    expect([...h.div.querySelectorAll("button")].find(item => item.textContent === "生成候选（可能计费）")!.disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/media/submit")).toHaveLength(1);
  });
  it("recovers a confirmed task from a request ID without resubmitting", async () => {
    const requestId = "request-12345678";
    localStorage.setItem("glint.scene-generation:v2:gen:one", JSON.stringify({ version: 2, projectId: "gen", sceneId: "one", basis: sceneReworkContext(project(), "one").basis, requestId, signature: "saved" }));
    const fetcher = stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : url === `/api/media/request/${requestId}` ? Response.json({ taskId: "task-1" }) : url === "/api/media/status/task-1" ? Response.json({ taskId: "task-1", isFinal: true, assetUrl: "/api/media/assets/gen.png" }) : Response.json({}));
    const h = await mount(); await flush();
    expect(h.div.querySelector('img[aria-label="候选生成图片"]')).not.toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
  });
  it("adds text identity context without sending reference images", async () => {
    const original = project();
    const withIdentity = parseProject({ ...original, assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝色外套", refs: ["assets/hero.png"] }], scenes: [{ ...original.scenes[0]!, assetRefs: [{ assetId: "hero", version: "v1" }] }] });
    const fetcher = happy(), h = await mount(withIdentity);
    expect(h.div.textContent).toContain("未选择参考图时不会发送图片");
    await h.consent(); await h.click("生成候选"); await flush();
    const submit = fetcher.mock.calls.find(([url]) => String(url) === "/api/media/submit")!;
    const body = JSON.parse(String((submit[1] as RequestInit).body));
    expect(body.prompt).toContain("小雨"); expect(body.prompt).toContain("蓝色外套");
    expect(body.params).toEqual({}); expect(JSON.stringify(body.params)).not.toContain("hero.png");
  });
  it("blocks an old candidate after the target scene changes in flight", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : url === "/api/media/submit" ? Response.json({ taskId: "task-1" }) : url === "/api/media/status/task-1" ? pending : Response.json({}));
    const h = await mount(); await h.consent(); await h.click("生成候选");
    const newer = project(); newer.scenes[0]!.narration.text = "已更新的旁白"; await h.setProject(newer);
    await act(async () => resolve(Response.json({ taskId: "task-1", isFinal: true, assetUrl: "/api/media/assets/gen.png" })));
    await flush();
    expect(h.div.textContent).toContain("镜头或引用资产已变化");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "用候选替换当前镜头")!.disabled).toBe(true);
    expect(h.changes).toHaveLength(0);
  });
  it("ignores late responses after switching to another project with the same scene ID", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : url === "/api/media/submit" ? Response.json({ taskId: "task-1" }) : url === "/api/media/status/task-1" ? pending : Response.json({}));
    const h = await mount(); await h.consent(); await h.click("生成候选");
    await h.setProject(parseProject({ ...project(), id: "other" }));
    await act(async () => resolve(Response.json({ taskId: "task-1", isFinal: true, assetUrl: "/api/media/assets/gen.png" })));
    await flush(); expect(h.div.querySelector('img[aria-label="候选生成图片"]')).toBeNull();
    expect(localStorage.getItem("glint.scene-generation:v2:other:one")).toBeNull();
  });
  it("does not invalidate a candidate when an unrelated scene changes", async () => {
    const original = project();
    const withSecond = parseProject({ ...original, scenes: [...original.scenes, { id: "two", kind: "title", title: "另一镜", narration: { text: "另一镜" } }] });
    const h = await (happy(), mount(withSecond)); await h.consent(); await h.click("生成候选"); await flush();
    const newer = structuredClone(withSecond); newer.scenes[1]!.narration.text = "另一镜的新旁白"; await h.setProject(newer);
    expect(h.div.textContent).not.toContain("镜头或引用资产已变化");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "用候选替换当前镜头")!.disabled).toBe(false);
  });
  it("blocks sending paid requests when the receipt cannot be saved", async () => {
    const fetcher = happy(), h = await mount(); await h.consent();
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await h.click("生成候选");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
    expect(h.div.textContent).toContain("无法保存生成回执"); storage.mockRestore();
  });
  it("does not overwrite a pending receipt created by another view", async () => {
    const fetcher = happy(), h = await mount(); await h.consent();
    const existing = savedTask("task-other"); localStorage.setItem("glint.scene-generation:v2:gen:one", existing);
    await h.click("生成候选");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
    expect(localStorage.getItem("glint.scene-generation:v2:gen:one")).toBe(existing);
    expect(h.div.textContent).toContain("已有未确认的请求");
  });
  it("keeps uncertain submissions blocked after reload until explicit acknowledgement", async () => {
    const requestId = "request-12345678";
    localStorage.setItem("glint.scene-generation:v2:gen:one", JSON.stringify({ version: 2, projectId: "gen", sceneId: "one", basis: sceneReworkContext(project(), "one").basis, requestId, signature: "saved" }));
    const fetcher = stub(url => url.startsWith("/api/media/models") ? Response.json({ models: [{ id: "m1", name: "Image One" }] }) : new Response("{}", { status: 404 }));
    const h = await mount(); await flush();
    expect(fetcher.mock.calls.some(([url]) => String(url) === `/api/media/request/${requestId}`)).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
    expect(h.div.textContent).toContain("不会自动重复提交");
    expect([...h.div.querySelectorAll("button")].find(item => item.textContent === "解除旧任务关联")!.disabled).toBe(true);
    const checkbox = [...h.div.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
    await act(async () => checkbox.click()); await h.click("解除旧任务关联");
    expect(localStorage.getItem("glint.scene-generation:v2:gen:one")).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
  });
  it("keeps corrupted receipts and locked shots from sending paid work", async () => {
    localStorage.setItem("glint.scene-generation:v2:gen:one", "{broken");
    const fetcher = happy(), h = await mount(); await h.consent(); await h.click("生成候选");
    expect(h.div.textContent).toContain("本机回执无法读取");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
    localStorage.removeItem("glint.scene-generation:v2:gen:one");
    const locked = project(); locked.scenes[0]!.locked = true;
    const other = await mount(locked); await other.consent(); await other.click("生成候选");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/media/submit")).toBe(false);
  });
});

it("explicitly opts in to a bound approved reference only for an edit-capable model", async () => {
  const hash = "a".repeat(64);
  const identity = { id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-1", refs: [`assets/approved-${hash}.png`] };
  const initial = parseProject({ ...project(), assets: [{ ...identity, approval: { version: identity.version, name: identity.name, description: identity.description, voice: identity.voice, refs: identity.refs, refSha256: hash } }], scenes: [{ ...project().scenes[0], assetRefs: [{ assetId: "hero", version: "v1" }] }] });
  const fetcher = stub(url => url.startsWith("/api/media/models")
    ? Response.json({ configured: true, protocol: "skills", models: [{ id: "m1", name: "Edit", tags: ["图生图"] }] })
    : url === "/api/media/submit" ? Response.json({ taskId: "task-1" })
    : Response.json({ taskId: "task-1", isFinal: true, state: "success", assetUrl: "/api/media/assets/gen.png" }));
  const approve = vi.fn(async () => true);
  const h = await mount(initial, approve);
  const select = h.div.querySelector<HTMLSelectElement>('select[aria-label="生成角色或商品参考图"]')!;
  expect(select.disabled).toBe(false); expect(select.value).toBe("");
  await act(async () => { select.value = "hero"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await h.consent(); await h.click("生成候选"); await flush();
  const body = JSON.parse(String((fetcher.mock.calls.find(([url]) => String(url) === "/api/media/submit")![1] as RequestInit).body));
  expect(body.reference).toEqual({ projectId: "gen", sceneId: "one", assetId: "hero", basis: sceneReworkContext(initial, "one").basis });
  expect(body.params).toEqual({});
  await h.click("用候选替换当前镜头");
  expect(approve).toHaveBeenCalledWith("task-1", "replace");
  expect(h.changes).toHaveLength(0);
  expect(h.div.textContent).toContain("已校验参考图");
});


it("offers only bound pinned product references and sends them only after explicit selection", async () => {
  const hash = "b".repeat(64), refs = [`assets/approved-${hash}.png`];
  const item = { id: "item", kind: "product", name: "产品", version: "v1", description: "红色", refs };
  const draft = { id: "draft", kind: "product", name: "草稿", version: "v1", description: "蓝色", refs: ["assets/draft.png"] };
  const initial = parseProject({ ...project(), assets: [{ ...item, approval: { name: item.name, version: item.version, description: item.description, refs, refSha256: hash } }, draft], scenes: [{ ...project().scenes[0], assetRefs: [{ assetId: "item", version: "v1" }, { assetId: "draft", version: "v1" }] }] });
  const fetcher = stub(url => url.startsWith("/api/media/models") ? Response.json({ protocol: "skills", models: [{ id: "m1", name: "Edit", tags: ["图生图"] }] }) : url === "/api/media/submit" ? Response.json({ taskId: "task-1" }) : Response.json({ taskId: "task-1", isFinal: true, assetUrl: "/api/media/assets/gen.png" }));
  const h = await mount(initial); const select = h.div.querySelector<HTMLSelectElement>('select[aria-label="生成角色或商品参考图"]')!;
  expect([...select.options].map(option => option.value)).toEqual(["", "item"]); expect(select.value).toBe("");
  await act(async () => { select.value = "item"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await h.consent(); await h.click("生成候选"); await flush();
  const body = JSON.parse(String((fetcher.mock.calls.find(([url]) => String(url) === "/api/media/submit")![1] as RequestInit).body));
  expect(body.reference).toEqual({ projectId: "gen", sceneId: "one", assetId: "item", basis: sceneReworkContext(initial, "one").basis });
});
