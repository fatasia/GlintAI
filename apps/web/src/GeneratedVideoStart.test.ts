// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GeneratedVideoStart } from "./GeneratedVideoStart";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
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
  else { expect(onCreated).not.toHaveBeenCalled(); expect(node.querySelector('[role="alert"]')?.textContent).toContain("无法读取视频时长"); }
});
