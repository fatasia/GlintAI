// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { IdeaStudio } from "./IdeaStudio";
import { parseEditorProject } from "./editor-model";
import { captureChapter, readChapters, writeChapters, type ChapterContext } from "./ChaptersStore";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const context: ChapterContext = { mode: "source", text: "第一章资料", template: "explainer", theme: "glint-dark", evidence: "第一章依据" };
const project = (id: string) => parseEditorProject({ schemaVersion: 1, id, title: `章节 ${id}`, aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: id, narration: { text: id } }] });
async function mount(pendingJob = false) {
  localStorage.setItem("glint.workspace", JSON.stringify({ ...context, aspect: "9:16", project: project("one") }));
  if (pendingJob) localStorage.setItem("glint.last-job", "idea-pending");
  writeChapters([captureChapter(project("two"), { ...context, text: "第二章资料", evidence: "第二章依据" })]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/health") return Response.json({ voices: ["mock"] });
    if (url === "/api/media/library") return Response.json({ assets: [] });
    if (url === "/api/make/idea-pending") return Response.json({ id: "idea-pending", status: "render", log: [] });
    return Response.json({});
  }));
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node); dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(IdeaStudio, { cardStyle: {} })); });
  await act(async () => { await import("./SessionEditor"); });
  await act(async () => {
    const details = node.querySelector<HTMLDetailsElement>('[aria-label="章节管理"]')!;
    details.open = true; details.dispatchEvent(new Event("toggle"));
    await import("./ChaptersPanel");
  });
  return node;
}
function button(node: ParentNode, label: string) { return [...node.querySelectorAll("button")].find(item => item.textContent === label)!; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function confirm(node: ParentNode) { await click(node.querySelector<HTMLInputElement>('[aria-label="确认章节操作"] input')!); await click(button(node, "确认载入")); }
it("switches only after consent, preserves the current effective canvas in recent works, and restores chapter context", async () => {
  const node = await mount(), panel = node.querySelector('[aria-label="章节管理"]')!;
  await click(button(panel, "载入编辑")); expect(node.querySelector('[aria-label="共享工程编辑"] code')!.textContent).toBe("one");
  await confirm(panel);
  const saved = JSON.parse(localStorage.getItem("glint.projects")!)[0]; expect(saved.project.id).toBe("one"); expect(saved.project.aspect).toBe("9:16"); expect(saved.text).toBe("第一章资料");
  expect(node.querySelector('[aria-label="共享工程编辑"] code')!.textContent).toBe("two"); expect(node.querySelector<HTMLTextAreaElement>('[aria-label="创作资料"]')!.value).toBe("第二章资料");
  expect(readChapters()[0]!.project.id).toBe("two");
});
it("keeps the current editor when its backup fails", async () => {
  const node = await mount(), panel = node.querySelector('[aria-label="章节管理"]')!;
  await click(button(panel, "载入编辑")); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); }); await confirm(panel);
  expect(node.querySelector('[aria-label="共享工程编辑"] code')!.textContent).toBe("one"); expect(panel.textContent).toContain("当前工程备份失败");
});
it("never switches or updates chapters during an in-flight render", async () => {
  const node = await mount(true), panel = node.querySelector('[aria-label="章节管理"]')!;
  expect(button(panel, "载入编辑").disabled).toBe(true); expect(button(panel, "将当前工程加入章节").disabled).toBe(true);
  await click(button(panel, "载入编辑")); expect(node.querySelector('[aria-label="共享工程编辑"] code')!.textContent).toBe("one"); expect(readChapters()).toHaveLength(1);
});
