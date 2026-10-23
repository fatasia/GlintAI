// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { SceneGenerator } from "./SceneGenerator";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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
async function mount(initial = project()) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), changes: SceneScriptProject[] = [], selected: string[] = [];
  cleanup = () => act(() => root.unmount());
  function Harness() { const [value, setValue] = useState(initial); return createElement(SceneGenerator, { project: value, sceneId: "one", pollMs: 0, onChange: next => { changes.push(next); setValue(next); }, onSelect: id => selected.push(id) }); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { const details = div.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  await flush();
  const click = async (text: string) => act(async () => { const target = [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text)); if (!target) throw new Error(`missing button ${text}`); target.click(); });
  const consent = async () => act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  return { div, changes, selected, click, consent };
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
    localStorage.setItem("glint.scene-generation", JSON.stringify({ taskId: "task-9", sceneId: "one", isFinal: true, assetUrl: "/api/media/assets/gen.png" }));
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
    localStorage.setItem("glint.scene-generation", JSON.stringify({ taskId: "task-9", sceneId: "one" }));
    const h = await mount();
    await flush(); await flush();
    expect(h.div.querySelector('img[aria-label="候选生成图片"]')).not.toBeNull();
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