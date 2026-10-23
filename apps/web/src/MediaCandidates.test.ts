// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { MediaCandidates } from "./MediaCandidates";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const project = parseProject({ schemaVersion: 1, id: "candidates", title: "Candidates", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "image", src: "assets/old.png", narration: { text: "Keep", durationMs: 1000 }, effects: [{ id: "mono", kind: "grayscale", value: 1 }] },
] });
async function mount(initial = project) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let current = initial; const changes: SceneScriptProject[] = [];
  function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(MediaCandidates, { project: value, sceneId: "one", onChange: next => { changes.push(next); setValue(next); } }); }
  await act(async () => root.render(createElement(Harness)));
  const click = async (label: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === label || button.textContent?.endsWith(label))!.click());
  const open = async () => act(async () => { const details = div.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  return { div, changes, current: () => current, click, open };
}
it("previews a candidate without editing, then explicitly replaces source preserving overlays and effects", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ assets: [{ name: "new.mp4" }, { name: "../bad.png" }, { name: "music.mp3" }] })); vi.stubGlobal("fetch", fetcher);
  const h = await mount(); expect(fetcher).not.toHaveBeenCalled(); await h.open();
  await h.click("new.mp4"); expect(h.changes).toHaveLength(0);
  expect(h.div.querySelector('video[aria-label="候选视频预览"]')?.getAttribute("src")).toBe("/api/media/assets/new.mp4");
  expect(h.div.textContent).not.toContain("../bad");
  await h.click("替换当前镜头素材");
  expect(h.current().scenes[0]).toMatchObject({ id: "one", kind: "video", src: "assets/new.mp4", narration: project.scenes[0]!.narration, effects: project.scenes[0]!.effects });
  expect(h.div.textContent).toContain("可撤销");
});
it("does not flatten structured scenes or mutate while reading fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ assets: [{ name: "new.png" }] })));
  const structured = parseProject({ ...project, scenes: [{ id: "one", kind: "title", title: "Keep title", narration: { text: "Keep", durationMs: 1000 } }] });
  const h = await mount(structured); await h.open(); await h.click("new.png");
  expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "替换当前镜头素材")!.disabled).toBe(true);
  await h.click("添加为新镜头"); expect(h.current().scenes).toHaveLength(2); expect(h.current().scenes[0]).toEqual(structured.scenes[0]);
});
