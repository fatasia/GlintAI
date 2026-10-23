// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuickGif } from "./QuickGif";
import type { SavedProject } from "./project-history";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const saved: SavedProject = { id: "p1", name: "咖啡店开业", mode: "source", text: "", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: 1, project: { id: "video-1", title: "咖啡店开业", aspect: "16:9", scenes: [] } as never };
async function mount(projects: SavedProject[]) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(QuickGif, { projects })));
  return div;
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }

it("exports the selected saved project as a GIF", async () => {
  const fetcher = vi.fn((_input: RequestInfo | URL, _init: RequestInit = {}) => Promise.resolve(Response.json({ url: "/api/project/export/aabbccddeeff0011/aabbccddeeff0011.gif", file: "aabbccddeeff0011.gif", bytes: 2048 })));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const div = await mount([saved]);
  await act(async () => { [...div.querySelectorAll("button")].find(button => button.textContent?.includes("导出 GIF"))!.click(); });
  await flush();
  const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
  expect(body).toMatchObject({ format: "gif", frame: 0 });
  expect(body.project).toMatchObject({ id: "video-1" });
  expect(div.textContent).toContain("已导出 aabbccddeeff0011.gif · 2 KB");
});
it("asks for a video first when there is nothing to export", async () => {
  const div = await mount([]);
  expect(div.textContent).toContain("还没有作品");
  expect(div.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
});
