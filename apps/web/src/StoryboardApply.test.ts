// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SceneScriptProject } from "@glintai/scenescript";
import { buildSeries, setShotEngine } from "@glintai/composer/drama-series";
import { StoryboardApply } from "./StoryboardApply";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("requires real media and confirmation before one atomic project change", async () => {
  const project = SceneScriptProject.parse({ schemaVersion: 1, id: "board", title: "旧工程", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "old", kind: "title", title: "旧", narration: { text: "旧" } }] });
  const base = buildSeries("第一场 茶馆 内 日\n老陈擦柜台。\n老陈：新茶到了。", { engine: "mg", id: "board", title: "茶馆", aspect: "16:9" });
  const series = setShotEngine(base, base.episodes[0]!.scenes[0]!.shots[0]!.id, "aigc");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ assets: [{ name: "tea.mp4" }, { name: "../bad.mp4" }] })));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true), onApply = vi.fn();
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StoryboardApply, { project, series, episodeId: series.episodes[0]!.id, documentId: "doc", onApply })));
  const apply = [...node.querySelectorAll("button")].find(button => button.textContent === "应用本集到工程")!;
  await act(async () => apply.click()); expect(onApply).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("尚未选择真实素材");
  const select = node.querySelector("select")!; expect(select.textContent).not.toContain("bad.mp4");
  await act(async () => { select.value = "tea.mp4"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => apply.click()); expect(confirm).toHaveBeenCalledOnce(); expect(onApply).toHaveBeenCalledOnce();
  expect(onApply.mock.calls[0]![0].scenes[0]).toMatchObject({ kind: "video", src: "assets/tea.mp4" }); expect(project.scenes[0]!.id).toBe("old");
});
