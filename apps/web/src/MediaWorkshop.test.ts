// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MediaWorkshop } from "./MediaWorkshop";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it("recovers a lost media receipt with GET only and shows the saved asset", async () => {
  localStorage.setItem("glint.media-task", JSON.stringify({ requestId: "request-lost" }));
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.includes("/request/") ? { taskId: "task-123" } : url.includes("/status/") ? { taskId: "task-123", state: "success", isFinal: true, assetUrl: "/api/media/assets/task-123.png" } : { models: [] }));
  vi.stubGlobal("fetch", fetch);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => { act(() => root.unmount()); div.remove(); };
  await act(async () => { root.render(createElement(MediaWorkshop)); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(fetch.mock.calls.some(([url]) => url === "/api/media/request/request-lost")).toBe(true);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(div.querySelector("img")?.getAttribute("src")).toBe("/api/media/assets/task-123.png");
  expect(JSON.parse(localStorage.getItem("glint.media-task")!).taskId).toBe("task-123");
});
