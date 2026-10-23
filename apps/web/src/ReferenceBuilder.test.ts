// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferenceBuilder } from "./ReferenceBuilder";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const flush = async () => { await act(async () => { await new Promise(done => setTimeout(done, 30)); }); };
function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function mount(uploadFile?: (file: File, onProgress: (percent: number) => void, signal: AbortSignal) => Promise<{ name: string }>) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), projects: unknown[] = [];
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(ReferenceBuilder, { onProject: (value: unknown) => projects.push(value), ...(uploadFile ? { uploadFile } : {}) })));
  await act(async () => { const details = div.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  await flush();
  const click = async (text: string) => act(async () => { const target = [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text)); if (!target) throw new Error(`missing ${text}`); target.click(); });
  const consent = async () => act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  return { div, projects, click, consent };
}
const library = () => Response.json({ assets: [{ name: "ref.mp4", url: "/api/media/assets/ref.mp4" }, { name: "poster.png", url: "/api/media/assets/poster.png" }] });
const project = { schemaVersion: 1, id: "reference-1", title: "参考重建（推断）", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "ref-shot-001", kind: "image", src: "assets/ref-1-001.jpg", narration: { text: "参考镜头 1", durationMs: 1000 } }] };
describe("reference video to project", () => {
  it("lists only library MP4s and requires rights consent before analysing", async () => {
    const fetcher = stub((url) => url === "/api/media/library" ? library() : Response.json({ project, shots: 1 }));
    const h = await mount();
    const select = h.div.querySelector<HTMLSelectElement>('select[aria-label="选择参考片"]')!;
    expect([...select.options].map(option => option.value)).toEqual(["ref.mp4"]);
    await h.click("分析并生成工程");
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/reference/build")).toBe(false);
    expect(h.projects).toHaveLength(0);
  });
  it("generates an editable project and states that it is inferred", async () => {
    const fetcher = stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return Response.json({ project, shots: 1, inferred: true });
      return Response.json({});
    });
    const h = await mount();
    await h.consent(); await h.click("分析并生成工程"); await flush();
    const submit = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((submit[1] as RequestInit).body))).toEqual({ name: "ref.mp4" });
    expect(h.projects).toEqual([project]);
    expect(h.div.querySelector('[role="status"]')?.textContent).toContain("推断");
    expect(h.div.textContent).toContain("交付前请替换");
  });
  it("surfaces a concurrent analysis and keeps the current project", async () => {
    stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return new Response(JSON.stringify({ error: "busy" }), { status: 409 });
      return Response.json({});
    });
    const h = await mount();
    await h.consent(); await h.click("分析并生成工程"); await flush();
    expect(h.projects).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("已有参考分析在运行");
  });
  it("explains an empty library instead of offering a broken control", async () => {
    stub(() => Response.json({ assets: [{ name: "poster.png" }] }));
    const h = await mount();
    expect(h.div.textContent).toContain("还没有 MP4");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent?.includes("分析并生成工程"))!.disabled).toBe(true);
  });
  it("uploads a chosen MP4 first, then builds the project from the uploaded name", async () => {
    const fetcher = stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/upload") return Response.json({ name: "upload-abc123.mp4", bytes: 4 });
      if (url === "/api/reference/build") return Response.json({ project, shots: 1, inferred: true });
      return Response.json({});
    });
    const h = await mount(async () => ({ name: "upload-abc123.mp4" }));
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="上传参考片"]')!;
    const picked = { name: "my-ref.mp4", type: "video/mp4", size: 4 } as File;
    Object.defineProperty(input, "files", { configurable: true, value: [picked] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(h.div.textContent).toContain("my-ref.mp4");
    await h.consent(); await h.click("上传并生成工程"); await flush();
    const order = fetcher.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith("/api/reference/"));
    expect(order).toEqual(["/api/reference/build"]);
    const build = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((build[1] as RequestInit).body))).toEqual({ name: "upload-abc123.mp4" });
    expect(h.projects).toEqual([project]);
  });
  it("keeps the current project when the upload is rejected", async () => {
    stub((url) => {
      if (url === "/api/media/library") return library();
      return Response.json({});
    });
    const h = await mount(async () => { throw new Error("Reference upload is too large"); });
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="上传参考片"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ name: "big.mp4", type: "video/mp4", size: 4 }] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await h.consent(); await h.click("上传并生成工程"); await flush();
    expect(h.projects).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("too large");
  });
  it("shows byte progress while uploading, then builds from the returned name", async () => {
    const fetcher = stub((url) => {
      if (url === "/api/media/library") return library();
      if (url === "/api/reference/build") return Response.json({ project, shots: 1, inferred: true });
      return Response.json({});
    });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const uploadFile = vi.fn(async (_file: File, onProgress: (percent: number) => void) => { onProgress(40); await gate; return { name: "upload-xyz.mp4" }; });
    const h = await mount(uploadFile);
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="上传参考片"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ name: "ref.mp4", type: "video/mp4", size: 4 }] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await h.consent(); await h.click("上传并生成工程");
    await act(async () => { await Promise.resolve(); });
    expect(h.div.textContent).toContain("40%");
    await act(async () => { release(); await gate; });
    await flush();
    const build = fetcher.mock.calls.find(([url]) => String(url) === "/api/reference/build")!;
    expect(JSON.parse(String((build[1] as RequestInit).body))).toEqual({ name: "upload-xyz.mp4" });
    expect(h.projects).toEqual([project]);
  });
});