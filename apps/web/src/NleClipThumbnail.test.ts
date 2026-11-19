// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NleClipThumbnail, thumbnailTimes } from "./NleClipThumbnail";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {}; afterEach(() => { cleanup(); cleanup = () => {}; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("limits concurrent image loads and releases a slot when an image loads", async () => {
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement("div", null, ...Array.from({ length: 6 }, (_, i) => createElement(NleClipThumbnail, { key: i, src: `/assets/${i}.png`, kind: "image" })))));
  expect(div.querySelectorAll("img")).toHaveLength(4);
  await act(async () => div.querySelector("img")!.dispatchEvent(new Event("load")));
  expect(div.querySelectorAll("img")).toHaveLength(5);
  await act(async () => div.querySelectorAll("img")[1]!.dispatchEvent(new Event("error")));
  expect(div.querySelectorAll("img")).toHaveLength(6);
});
it("samples the same source clock as playback, including trims and ramps", () => {
  expect(thumbnailTimes({ durationMs: 2000, trimStartMs: 1000, speed: 2 }, 2)).toEqual([1, 3]);
  expect(thumbnailTimes({ durationMs: 2000, trimStartMs: 1000, speedCurve: "in" }, 2)).toEqual([1, 1.75]);
});
it("bounds active video decoders and releases each after sequential capture", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as never);
  const original = document.createElement.bind(document), videos: HTMLVideoElement[] = [];
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = original(tag, options); if (tag === "video") { Object.defineProperty(element, "duration", { configurable: true, value: 4 }); Object.defineProperty(element, "readyState", { configurable: true, value: 2 }); videos.push(element as HTMLVideoElement); } return element;
  }) as typeof document.createElement);
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement("div", null, ...Array.from({ length: 6 }, (_, i) => createElement(NleClipThumbnail, { key: i, src: `/assets/${i}.mp4`, kind: "video", trimStartMs: 1000, durationMs: 2000, widthPx: 144 })))));
  expect(videos).toHaveLength(4); expect(div.querySelectorAll("canvas")).toHaveLength(12);
  await act(async () => { videos[0]!.dispatchEvent(new Event("loadedmetadata")); expect(videos[0]!.currentTime).toBe(1); videos[0]!.dispatchEvent(new Event("seeked")); expect(videos[0]!.currentTime).toBe(2); videos[0]!.dispatchEvent(new Event("seeked")); });
  expect(videos).toHaveLength(5); expect(videos[0]!.getAttribute("src")).toBeNull();
  expect([...div.querySelectorAll("canvas")].slice(0, 2).map(canvas => canvas.dataset.sourceTime)).toEqual(["1", "2"]);
  cleanup(); cleanup = () => {}; expect(load).toHaveBeenCalled(); expect(videos.every(video => video.getAttribute("src") === null)).toBe(true);
});
it("bounds retained canvas memory across visible clips", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as never);
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement("div", null, ...Array.from({ length: 20 }, (_, i) => createElement(NleClipThumbnail, { key: i, src: `/assets/${i}.mp4`, kind: "video", durationMs: 4000, widthPx: 1000 })))));
  expect(div.querySelectorAll("canvas")).toHaveLength(128);
  await act(async () => root.render(createElement(NleClipThumbnail, { src: "/assets/new.mp4", kind: "video", durationMs: 4000, widthPx: 1000 })));
  expect(div.querySelectorAll("canvas")).toHaveLength(8);
});
it("clears old samples on source changes and releases all frames when offscreen", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as never);
  let observe!: (visible: boolean) => void;
  class FakeObserver {
    constructor(callback: IntersectionObserverCallback) { observe = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  const original = document.createElement.bind(document), videos: HTMLVideoElement[] = [];
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = original(tag, options); if (tag === "video") { Object.defineProperty(element, "duration", { configurable: true, value: 1 }); Object.defineProperty(element, "readyState", { configurable: true, value: 2 }); videos.push(element as HTMLVideoElement); } return element;
  }) as typeof document.createElement);
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div); cleanup = () => act(() => root.unmount());
  const render = async (src: string) => act(async () => root.render(createElement(NleClipThumbnail, { src, kind: "video", trimStartMs: 2000, durationMs: 3000, widthPx: 144 })));
  await render("/assets/old.mp4"); await act(async () => observe(true));
  const old = videos[0]!; await act(async () => { old.dispatchEvent(new Event("loadedmetadata")); expect(old.currentTime).toBeCloseTo(.95); old.dispatchEvent(new Event("seeked")); });
  expect(div.querySelector("canvas")!.dataset.sourceTime).toBeDefined();
  await render("/assets/new.mp4");
  expect(old.getAttribute("src")).toBeNull(); expect(div.querySelector("canvas")!.dataset.sourceTime).toBeUndefined();
  await act(async () => old.dispatchEvent(new Event("seeked"))); expect(div.querySelector("canvas")!.dataset.sourceTime).toBeUndefined();
  await act(async () => observe(false)); expect(div.querySelectorAll("canvas")).toHaveLength(0); expect(videos.at(-1)!.getAttribute("src")).toBeNull();
});
