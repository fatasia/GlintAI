// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { STYLE_PACKS } from "@glintai/design-tokens";
import { suggestStylePacks } from "./style-suggest";
import { StylePackPicker } from "./StylePackPicker";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
const project = (theme?: string) => parseProject({ schemaVersion: 1, id: "styled", title: "Styled", aspect: "16:9", knowledgeSources: [],
  ...(theme ? { theme } : {}),
  scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "一镜", durationMs: 2400 }, effects: [{ id: "mono", kind: "grayscale", value: 1 }] }] });
async function mount(initial = project(), analyze?: (file: File) => Promise<[number, number, number][]>) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), changes: SceneScriptProject[] = [];
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StylePackPicker, { project: initial, onChange: next => changes.push(next), ...(analyze ? { analyze } : {}) })));
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text))!.click());
  return { div, changes, click };
}
describe("style pack picker", () => {
  it("lists every pack with fonts, composition, pacing and sound", async () => {
    const h = await mount();
    expect(h.div.querySelectorAll('[aria-label="可选风格包"] button')).toHaveLength(STYLE_PACKS.length);
    expect(h.div.textContent).toContain("OFL-1.1");
    expect(h.div.textContent).toContain("LUFS");
    expect(h.div.textContent).toContain("ms/镜");
    expect(h.div.textContent).toContain("不打包字节");
  });
  it("applies only the theme, keeps scenes and effects byte-identical, and reports success", async () => {
    const initial = project(), snapshot = JSON.stringify(initial);
    const h = await mount(initial);
    await h.click("海报大字");
    expect(h.changes).toHaveLength(0);
    await h.click("应用「海报大字」");
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.theme).toBe("bold-poster");
    expect(h.changes[0]!.scenes).toEqual(initial.scenes);
    expect(h.changes[0]!.title).toBe(initial.title);
    expect(JSON.stringify(initial)).toBe(snapshot);
    expect(h.div.querySelector('[role="status"]')?.textContent).toContain("可撤销");
  });
  it("marks the current pack, disables re-applying, and treats unknown themes as custom", async () => {
    const h = await mount(project("bold-poster"));
    expect(h.div.querySelector('[aria-label="可选风格包"] button[aria-pressed="true"]')?.textContent).toContain("海报大字");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "当前已是这个风格")!.disabled).toBe(true);
    expect(h.div.textContent).toContain("当前：海报大字");
    await h.click("手绘笔记");
    await h.click("应用「手绘笔记」");
    expect(h.changes[0]!.theme).toBe("hand-note");
  });
  it("shows a custom-theme state and still allows choosing a pack", async () => {
    const h = await mount(project("brand-custom"));
    expect(h.div.textContent).toContain("当前：自定义主题");
    await h.click("工程蓝图");
    await h.click("应用「工程蓝图」");
    expect(h.changes[0]!.theme).toBe("blueprint");
  });
  it("suggests styles from a reference image without pretending to recognise it", async () => {
    const pixels: [number, number, number][] = Array.from({ length: 16 }, () => [18, 18, 24] as [number, number, number]);
    const expected = suggestStylePacks(pixels)[0]!;
    const h = await mount(project(), async () => pixels);
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="选择参考图"]')!;
    const file = { name: "ref.png", type: "image/png", size: 10 } as File;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(h.div.textContent).toContain("从参考图建议风格");
    expect(h.div.textContent).toContain("不识别物体");
    await h.click(`用「${expected.label}」`);
    await h.click(`应用「${expected.label}」`);
    expect(h.changes.at(-1)!.theme).toBe(expected.name);
  });
  it("rejects a non-image reference and keeps the current style", async () => {
    const h = await mount(project(), async () => [[0, 0, 0]]);
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="选择参考图"]')!;
    const file = { name: "notes.txt", type: "text/plain", size: 10 } as File;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("请选择一张图片");
    expect(h.changes).toHaveLength(0);
  });
});