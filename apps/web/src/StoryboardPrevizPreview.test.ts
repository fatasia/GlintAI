// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import StoryboardPrevizPreview from "./StoryboardPrevizPreview";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
let resized: ResizeObserverCallback;
const disconnected = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      disconnect() {
        disconnected();
      }
    },
  );
});
afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const scene = () =>
  parseProject({
    schemaVersion: 1,
    id: "preview",
    title: "Geometry",
    aspect: "16:9",
    knowledgeSources: [],
    scenes: [
      {
        id: "geometry",
        kind: "html",
        animation: "three",
        html: "<script>window.__glintThree=function(){}</script>",
        narration: { text: "geometry", durationMs: 1000 },
      },
    ],
  }).scenes[0]!;
function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(createElement(StoryboardPrevizPreview, { scene: scene(), aspect: "9:16" })),
  );
  dispose = () => act(() => root.unmount());
  const iframe = host.querySelector("iframe")!,
    generation = /var GENERATION = "([^"]+)"/.exec(iframe.srcdoc)![1]!;
  return { host, iframe, generation };
}
it("only accepts the current isolated frame's matching ready and seek acknowledgement", () => {
  const { host, iframe, generation } = setup(),
    post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
  const message = (source: Window | null, data: Record<string, unknown>) =>
    act(() => window.dispatchEvent(new MessageEvent("message", { source, data })));
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(host.querySelector('[data-aspect="9:16"]')).not.toBeNull();
  expect(iframe.srcdoc).toContain("three.runtime.js");
  expect(iframe.srcdoc).toContain("connect-src 'none'");
  message(window, { type: "glint:ready", generation });
  message(iframe.contentWindow, { type: "glint:ready", generation: "stale" });
  expect(post).not.toHaveBeenCalled();
  message(iframe.contentWindow, { type: "glint:ready", generation });
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith({ type: "glint:seek", generation, requestId: 1, t: 0 }, "*");
  message(iframe.contentWindow, { type: "glint:seeked", generation, requestId: 2, t: 0 });
  expect(iframe.dataset.ready).toBe("false");
  message(iframe.contentWindow, { type: "glint:seeked", generation, requestId: 1, t: 0 });
  expect(iframe.dataset.ready).toBe("true");
  expect(host.querySelector('[role="status"]')).toBeNull();
});
it("reports readiness failure and removes the bounded timer on unmount", () => {
  vi.useFakeTimers();
  const { host } = setup();
  act(() => vi.advanceTimersByTime(10000));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("当前草稿仍保留");
  dispose();
  dispose = () => {};
  expect(vi.getTimerCount()).toBe(0);
});

it("recreates the isolated renderer on viewport resize and disconnects observation", () => {
  const { host, iframe, generation } = setup();
  act(() =>
    resized(
      [{ contentRect: { width: 390, height: 219 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  const replacement = host.querySelector("iframe")!;
  expect(replacement).not.toBe(iframe);
  expect(replacement.srcdoc).not.toContain(`var GENERATION = "${generation}"`);
  expect(replacement.dataset.ready).toBe("false");
  act(() =>
    resized(
      [{ contentRect: { width: 390, height: 219 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  expect(host.querySelector("iframe")).toBe(replacement);
  dispose();
  dispose = () => {};
  expect(disconnected).toHaveBeenCalled();
});
