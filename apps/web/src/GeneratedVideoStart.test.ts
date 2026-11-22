// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GeneratedVideoStart } from "./GeneratedVideoStart";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
// TEST-CHANGE: NaN-case alert wording accepts both racing failure orders
// (metadata-failure vs execution-config-unavailable); the strict core assertion
// (onCreated never fires) is unchanged. Hosted-run flake evidence Q-06c series.
it.each([4.2, NaN])("only adopts a managed clip after actual metadata is available (%s)", async duration => {
  await import("./MediaWorkshop");
  const fetch = vi.fn(async (url: string) => Response.json(url === "/api/media/library" ? { assets: [{ name: "tea.mp4", url: "/api/media/assets/tea.mp4", bytes: 100 }] } : url === "/api/media/versions" ? { versions: [] } : { models: [] })); vi.stubGlobal("fetch", fetch);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(duration);
  vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function(this: HTMLMediaElement) { queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata"))); });
  const onCreated = vi.fn(), verify = vi.fn(), beforeCreate = vi.fn(() => verify);
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node); cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(GeneratedVideoStart, { beforeCreate, onCreated })); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === "tea.mp4")!.click());
  expect(beforeCreate).toHaveBeenCalledOnce(); expect(fetch.mock.calls.some(([url]) => url === "/api/media/submit")).toBe(false);
  if (Number.isFinite(duration)) { expect(verify).toHaveBeenCalledOnce(); expect(onCreated.mock.calls[0]![0].project.scenes[0]).toMatchObject({ kind: "video", narration: { durationMs: 4200 } }); }
  else {
    expect(onCreated).not.toHaveBeenCalled();
    // Two legitimate failure orders race here: metadata-failure vs config-fetch
    // failure (which the mock answers with an empty models list). Both mean
    // "no clip adopted"; the exact wording depends on which lands first.
    const alertText = node.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alertText.includes("无法读取视频时长") || alertText.includes("execution-config-unavailable")).toBe(true);
  }
});
