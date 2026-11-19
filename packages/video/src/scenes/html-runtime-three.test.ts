// @vitest-environment jsdom
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HtmlScene } from "@glintai/scenescript";
import { buildHtmlSceneDocument } from "./html-runtime";

// MOTION-04: the sandbox also drives WebGL documents through MODE=three.
// These tests pin the in-page contract (factory shape, preserveDrawingBuffer,
// render+finish per seek) and the document-level egress boundary, using a stub
// renderer because jsdom has no GPU.
interface ThreeStub {
  seek: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
}
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

const threeScene = (html = '<div id="glint-root"></div>'): HtmlScene => ({
  id: "anim-three", kind: "html", html, animation: "three", narration: { text: "三维" },
});

function runtime(stub: ThreeStub, html?: string) {
  const dom = new JSDOM(buildHtmlSceneDocument(threeScene(html), "/three.runtime.js"), {
    url: "https://glint.test/", runScripts: "dangerously", pretendToBeVisual: true,
  });
  cleanups.push(() => dom.window.close());
  const win = dom.window;
  const rendererInstances: Array<Record<string, unknown>> = [];
  const renderer = class {
    domElement = win.document.createElement("canvas");
    constructor(public options: Record<string, unknown>) { rendererInstances.push({ options, ...stub }); }
    setPixelRatio() { return undefined; }
    setSize() { return undefined; }
    render(scene: unknown, camera: unknown) { stub.render(scene, camera); }
    getContext() { return { finish: stub.finish }; }
  };
  Object.assign(win, {
    THREE: { WebGLRenderer: renderer },
    __glintThree: vi.fn(() => ({ scene: { tag: "scene" }, camera: { tag: "camera" }, seek: stub.seek })),
    requestAnimationFrame: (callback: (time: number) => void) => { queueMicrotask(() => callback(0)); return 1; },
  });
  const replies: Array<Record<string, unknown>> = [];
  vi.spyOn(win, "postMessage").mockImplementation((data) => {
    if ((data as Record<string, unknown>).type !== "glint:ready") replies.push(data as Record<string, unknown>);
  });
  win.dispatchEvent(new win.Event("load"));
  const send = (id: number, t: number) => win.dispatchEvent(new win.MessageEvent("message", {
    source: win as unknown as MessageEventSource,
    data: { type: "glint:seek", generation: "standalone", requestId: id, t },
  }));
  return { win, replies, send, rendererInstances };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe("MODE=three sandbox runtime", () => {
  it("renders the factory scene absolutely and finishes the GPU before acking", async () => {
    const stub = { seek: vi.fn(), render: vi.fn(), finish: vi.fn() };
    const r = runtime(stub);
    r.send(1, 0.5); await flush();
    r.send(2, 1.5); await flush();
    r.send(3, 0.5); await flush();
    expect(r.replies.filter((reply) => reply.type === "glint:seeked")).toHaveLength(3);
    expect(stub.seek.mock.calls).toEqual([[0.5], [1.5], [0.5]]);
    expect(stub.render.mock.calls.map((call) => call[0]?.tag)).toEqual(["scene", "scene", "scene"]);
    expect(stub.render.mock.calls.map((call) => call[1]?.tag)).toEqual(["camera", "camera", "camera"]);
    expect(stub.finish).toHaveBeenCalledTimes(3);
  });
  it("creates one antialiased, buffer-preserving renderer inside #glint-root", async () => {
    const stub = { seek: vi.fn(), render: vi.fn(), finish: vi.fn() };
    const r = runtime(stub);
    r.send(1, 0); await flush();
    expect(r.rendererInstances).toHaveLength(1);
    expect(r.rendererInstances[0]!.options).toMatchObject({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    expect(r.win.document.querySelectorAll("#glint-root canvas")).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ type: "glint:seeked", requestId: 1, t: 0 });
  });
  it.each(["runtime", "factory", "shape"])("returns glint:seek-error, never success, for %s failure", async (failure) => {
    const stub = { seek: vi.fn(), render: vi.fn(), finish: vi.fn() };
    const r = runtime(stub);
    if (failure === "runtime") Object.assign(r.win, { THREE: undefined });
    if (failure === "factory") Object.assign(r.win, { __glintThree: undefined });
    if (failure === "shape") Object.assign(r.win, { __glintThree: () => ({ scene: {}, camera: {} }) });
    r.send(1, 0); await flush();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toMatchObject({ type: "glint:seek-error", requestId: 1 });
    expect(String(r.replies[0]!.error)).toMatch(/Missing Three runtime|must return scene, camera and seek/);
    expect(stub.render).not.toHaveBeenCalled();
  });
  it("keeps the WebGL document inside the no-egress policy boundary", () => {
    const doc = buildHtmlSceneDocument(threeScene(), "/three.runtime.js");
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(doc)![1]!;
    expect(policy).toContain("script-src 'unsafe-inline' http");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("worker-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(doc).toContain('window.__glintThree');
    expect(doc).toContain('MODE = "three"');
  });
});
