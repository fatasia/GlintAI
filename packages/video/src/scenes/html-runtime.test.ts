// @vitest-environment jsdom
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HtmlScene } from "@glintai/scenescript";
import { gsap } from "gsap";
import { HtmlSceneView } from "./HtmlScene";
import { buildHtmlSceneDocument, GLINT_GLUE_SNIPPET, GLINT_SEEK_MESSAGE_TYPE } from "./html-runtime";

const state = vi.hoisted(() => ({ frame: 0, nextHandle: 0 }));
const gates = vi.hoisted(() => ({
  delayRender: vi.fn(() => ++state.nextHandle),
  continueRender: vi.fn(), cancelRender: vi.fn(),
}));
vi.mock("remotion", () => ({
  AbsoluteFill: ({ children }: { children?: unknown }) => children ?? null,
  useCurrentFrame: () => state.frame, useVideoConfig: () => ({ fps: 30 }),
  spring: () => 1, staticFile: (path: string) => `/public/${path}`, ...gates,
}));
const scene = (overrides?: Partial<HtmlScene>): HtmlScene => ({
  id: "anim-html", kind: "html", html: '<div id="root">中文</div>',
  animation: "gsap", narration: { text: "test" }, ...overrides,
});
const cleanups: (() => void)[] = [];
function mount(initial = scene()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let current = initial;
  const renderAt = (frame: number, next = current) => {
    current = next;
    state.frame = frame;
    act(() => root.render(createElement(HtmlSceneView, { scene: current })));
  };
  renderAt(0);
  const getIframe = () => container.querySelector("iframe")!;
  const messages: Record<string, unknown>[] = [];
  const load = () => {
    const iframe = getIframe();
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation((data) => { messages.push(data); });
    act(() => iframe.dispatchEvent(new window.Event("load")));
    const match = /var GENERATION = ("[^"]+");/.exec(iframe.srcdoc);
    if (match) act(() => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow, data: { type: "glint:ready", generation: JSON.parse(match[1]!) },
    })));
  };
  const reply = (data = messages.at(-1), source: MessageEventSource | null = getIframe().contentWindow) => {
    act(() => window.dispatchEvent(new MessageEvent("message", {
      data: { ...data, type: "glint:seeked" }, source,
    })));
  };
  cleanups.push(() => { act(() => root.unmount()); container.remove(); });
  return { getIframe, messages, renderAt, load, reply };
}
beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("HTML capture gates", () => {
  it("holds a cold document until load AND its matching successful seek", () => {
    const m = mount();
    expect(gates.delayRender).toHaveBeenCalledTimes(1);
    expect(gates.continueRender).not.toHaveBeenCalled();
    m.load();
    expect(gates.continueRender).not.toHaveBeenCalled();
    expect(m.messages[0]).toMatchObject({ type: GLINT_SEEK_MESSAGE_TYPE, t: 0, requestId: 1 });
    m.reply();
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
  });
  it("ignores foreign windows, generations, tokens and timestamps", () => {
    const m = mount(); m.load();
    const request = m.messages[0]!;
    m.reply(request, window);
    m.reply({ ...request, generation: "stale" });
    m.reply({ ...request, requestId: 999 });
    m.reply({ ...request, t: 0.01 });
    expect(gates.continueRender).not.toHaveBeenCalled();
    m.reply();
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
  });
  it("seeks repeated and out-of-order frames with new tokens", () => {
    const m = mount(); m.load(); m.reply();
    for (const frame of [1, 2, 2, 7, 2]) { m.renderAt(frame); m.reply(); }
    expect(m.messages.map((message) => message.t)).toEqual([0, 1, 2, 7, 2].map((frame) => frame / 30));
    expect(new Set(m.messages.map((message) => message.requestId)).size).toBe(5);
    expect(gates.cancelRender).not.toHaveBeenCalled();
  });
  it("cannot release a newer seek with an earlier ack", () => {
    const m = mount(); m.load();
    const previous = m.messages[0]!;
    m.renderAt(7);
    const released = gates.continueRender.mock.calls.length;
    m.reply(previous);
    expect(gates.continueRender).toHaveBeenCalledTimes(released);
    m.reply();
    expect(gates.continueRender).toHaveBeenCalledTimes(released + 1);
  });
  it("remounts changed documents and waits to replay the current frame", () => {
    const m = mount(); m.load(); m.reply();
    const oldIframe = m.getIframe(); const old = m.messages[0]!;
    m.renderAt(5, scene({ html: "<div>v2</div>" }));
    expect(m.getIframe()).not.toBe(oldIframe);
    expect(m.messages).toHaveLength(1);
    m.load();
    expect(m.messages[1]).toMatchObject({ t: 5 / 30 });
    expect(m.messages[1]!.generation).not.toBe(old.generation);
    const released = gates.continueRender.mock.calls.length;
    m.reply(old);
    expect(gates.continueRender).toHaveBeenCalledTimes(released);
    m.reply();
    expect(gates.continueRender).toHaveBeenCalledTimes(released + 1);
  });
  it.each([false, true])("cancels timeout without releasing the failed frame (loaded=%s)", (loaded) => {
    vi.useFakeTimers();
    const m = mount(); if (loaded) m.load();
    act(() => vi.advanceTimersByTime(10_000));
    expect(gates.cancelRender).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("timed out") }));
    expect(gates.continueRender).not.toHaveBeenCalled();
    m.reply();
    expect(gates.continueRender).not.toHaveBeenCalled();
  });
  it("cancels an explicit runtime error without acknowledging success", () => {
    const m = mount(); m.load();
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: m.getIframe().contentWindow,
      data: { ...m.messages[0], type: "glint:seek-error", error: "Missing factory" },
    })));
    expect(gates.cancelRender).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Missing factory") }));
    expect(gates.continueRender).not.toHaveBeenCalled();
  });
  it("gates static iframe loading without enabling scripts", () => {
    const value = scene({ animation: undefined }); const m = mount(value);
    const wrapper=new DOMParser().parseFromString(m.getIframe().srcdoc,"text/html");
    const child=wrapper.getElementById("glint-document")!;
    expect(child.getAttribute("srcdoc")).toContain(value.html);
    expect(m.getIframe().getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(child.getAttribute("sandbox")).toBe("");
    expect(gates.continueRender).not.toHaveBeenCalled();
    m.load();
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
    m.renderAt(3);
    expect(m.messages).toEqual([]);
  });
  it("uses only allow-scripts for animated HTML", () => {
    expect(mount().getIframe().getAttribute("sandbox")).toBe("allow-scripts");
  });
  it("does not trust about:blank load events as animated document readiness", () => {
    const m = mount();
    act(() => m.getIframe().dispatchEvent(new window.Event("load")));
    expect(m.messages).toEqual([]);
    expect(gates.continueRender).not.toHaveBeenCalled();
  });
  it("uses the live window after a cold iframe attaches its document", () => {
    const m = mount();
    const replacement = document.createElement("iframe"); document.body.append(replacement);
    Object.defineProperty(m.getIframe(), "contentWindow", { value: replacement.contentWindow });
    m.load(); m.reply();
    expect(m.messages).toHaveLength(1);
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
    replacement.remove();
  });
});

function runtime() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://glint.test/", runScripts: "outside-only" });
  cleanups.push(() => dom.window.close());
  const win = dom.window;
  const timeline = { pause: vi.fn(() => timeline), seek: vi.fn(() => timeline) };
  const factory = vi.fn(() => timeline); const sleep = vi.fn();
  Object.assign(win, { gsap: { ticker: { sleep } }, __glintTimeline: factory });
  win.requestAnimationFrame = (callback) => { queueMicrotask(() => callback(0)); return 1; };
  const replies = vi.fn();
  vi.spyOn(win, "postMessage").mockImplementation((data, target) => {
    if (data.type !== "glint:ready") replies(data, target);
  });
  win.eval(GLINT_GLUE_SNIPPET);
  win.dispatchEvent(new win.Event("load"));
  const send = (id: number, t: number, overrides = {}, source: MessageEventSource | null = win as unknown as Window) => win.dispatchEvent(new win.MessageEvent("message", {
    source, data: { type: GLINT_SEEK_MESSAGE_TYPE, generation: "standalone", requestId: id, t, ...overrides },
  }));
  return { win, timeline, factory, sleep, replies, send };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe("sandbox runtime execution", () => {
  it("revisits the same styles with a real GSAP timeline in one document", async () => {
    const r = runtime();
    const box = document.createElement("div"); document.body.append(box);
    const timeline = gsap.timeline({ paused: true }).fromTo(box,
      { x: 0, opacity: .2 }, { x: 100, opacity: 1, duration: 1, ease: "none" }, 0);
    Object.assign(r.win, { gsap, __glintTimeline: () => timeline });
    try {
      r.send(1, .75); await flush(); const at75 = box.getAttribute("style");
      r.send(2, .125); await flush(); expect(box.getAttribute("style")).not.toBe(at75);
      r.send(3, .75); await flush(); expect(box.getAttribute("style")).toBe(at75);
      expect(r.replies).toHaveBeenLastCalledWith(expect.objectContaining({ type: "glint:seeked", requestId: 3 }), "*");
    } finally { timeline.kill(); gsap.ticker.sleep(); box.remove(); }
  });
  it("builds the runtime before user scripts, with an escaped URL and generation", () => {
    const doc = buildHtmlSceneDocument(scene(), '/public/gsap.min.js?x="&', "</script>");
    expect(doc).toContain('src="/public/gsap.min.js?x=&quot;&amp;"');
    expect(doc.indexOf("var GENERATION")).toBeLessThan(doc.indexOf('<div id="root">'));
    expect(doc).toContain('"\\u003c/script>"');
    expect(() => buildHtmlSceneDocument(scene({ animation: undefined }))).toThrow(/static/);
  });
  it("seeks absolutely, suppresses callbacks and sleeps the ticker", async () => {
    const r = runtime();
    for (const [id, t] of [1.5, 0, 1.5].entries()) { r.send(id + 1, t); await flush(); }
    expect(r.timeline.seek.mock.calls).toEqual([[1.5, true], [0, true], [1.5, true]]);
    expect(r.timeline.pause).toHaveBeenCalledWith(0);
    expect(r.factory).toHaveBeenCalledTimes(1);
    expect(r.sleep).toHaveBeenCalledTimes(3);
    expect(r.replies).toHaveBeenLastCalledWith({ type: "glint:seeked", generation: "standalone", requestId: 3, t: 1.5 }, "*");
  });
  it.each(["gsap", "factory", "invalid", "throwing", "seek"])("returns an error, never success, for %s failure", async (failure) => {
    const r = runtime();
    if (failure === "gsap") Object.assign(r.win, { gsap: undefined });
    if (failure === "factory") Object.assign(r.win, { __glintTimeline: undefined });
    if (failure === "invalid") r.factory.mockReturnValue({} as typeof r.timeline);
    if (failure === "throwing") r.factory.mockImplementation(() => { throw new Error("factory failed"); });
    if (failure === "seek") r.timeline.seek.mockImplementation(() => { throw new Error("seek failed"); });
    r.send(1, 0); await flush();
    expect(r.replies).toHaveBeenCalledTimes(1);
    expect(r.replies).toHaveBeenCalledWith(expect.objectContaining({ type: "glint:seek-error", requestId: 1 }), "*");
  });
  it("waits for fonts, image decode and paint before returning success", async () => {
    const r = runtime();
    let resolveFonts!: () => void; let resolveImage!: () => void;
    Object.defineProperty(r.win.document, "fonts", { value: { ready: new Promise<void>((resolve) => { resolveFonts = resolve; }), forEach: () => {} } });
    const img = r.win.document.createElement("img");
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: 1 },
      decode: { value: () => new Promise<void>((resolve) => { resolveImage = resolve; }) } });
    r.win.document.body.append(img);
    r.send(1, 1); await flush(); expect(r.replies).not.toHaveBeenCalled();
    resolveFonts(); await flush(); expect(r.replies).not.toHaveBeenCalled();
    resolveImage(); await flush();
    expect(r.replies).toHaveBeenCalledWith(expect.objectContaining({ type: "glint:seeked" }), "*");
  });
  it("fails broken images instead of releasing them", async () => {
    const r = runtime();
    r.win.document.body.append(r.win.document.createElement("img"));
    r.send(1, 0); await flush();
    expect(r.replies).toHaveBeenCalledWith(expect.objectContaining({ type: "glint:seek-error", error: "HTML image failed to load" }), "*");
  });
  it("fails a declared font that could not load", async () => {
    const r = runtime();
    Object.defineProperty(r.win.document, "fonts", { value: {
      ready: Promise.resolve(), forEach: (callback: (font: { status: string }) => void) => callback({ status: "error" }),
    } });
    r.send(1, 0); await flush();
    expect(r.replies).toHaveBeenCalledWith(expect.objectContaining({ type: "glint:seek-error", error: "HTML font failed to load" }), "*");
  });
  it("ignores malformed commands and messages from other windows", async () => {
    const r = runtime();
    r.send(1, NaN); r.send(1, -1); r.send(1, 2, { generation: "old" });
    r.send(0, 0); r.send(1, 0, {}, null); r.send(1, 0, { type: "foreign" });
    await flush();
    expect(r.timeline.seek).not.toHaveBeenCalled(); expect(r.replies).not.toHaveBeenCalled();
  });
  it("acks only the latest request while resources are pending", async () => {
    const r = runtime();
    r.send(1, 1); r.send(2, 0); await flush();
    expect(r.replies).toHaveBeenCalledTimes(1);
    expect(r.replies).toHaveBeenCalledWith(expect.objectContaining({ type: "glint:seeked", requestId: 2, t: 0 }), "*");
  });
});
