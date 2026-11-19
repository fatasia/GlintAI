// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { resolveTheme, STYLE_PACKS, themes } from "@glintai/design-tokens";
import { captureStyleTokens, readStyleSnapshot } from "./style-snapshot";
import { suggestStylePacks } from "./style-suggest";
import { StylePackPicker } from "./StylePackPicker";
vi.mock("./StylePackSample", () => ({ default: ({ theme }: { theme: string }) => createElement("div", { "data-sample-theme": theme }, `样片 ${theme}`) }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("samples") ? { entries: [] } : url.includes("history?") ? { entries: [] } : { id: "saved" } }))); });
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const project = (theme?: string) => parseProject({ schemaVersion: 1, id: "styled", title: "Styled", aspect: "16:9", knowledgeSources: [],
  ...(theme ? { theme } : {}),
  scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "一镜", durationMs: 2400 }, effects: [{ id: "mono", kind: "grayscale", value: 1 }] }] });
async function mount(initial = project(), analyze?: (file: File) => Promise<[number, number, number][]>) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), changes: SceneScriptProject[] = [];
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StylePackPicker, { project: initial, onChange: next => changes.push(next), ...(analyze ? { analyze } : {}) })));
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text))!.click());
  const waitForChange = async () => { await act(async () => { await vi.waitFor(() => expect(changes).toHaveLength(1)); }); };
  return { div, changes, click, waitForChange };
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
  it("opens, changes and closes the sample without changing the project", async () => {
    const h = await mount(project("glint-dark"));
    await h.click("查看风格样片");
    expect(h.div.querySelector('[data-sample-theme="glint-dark"]')).toBeTruthy();
    await h.click("海报大字");
    expect(h.div.querySelector('[data-sample-theme="bold-poster"]')).toBeTruthy();
    expect(h.changes).toHaveLength(0);
    await h.click("关闭样片");
    expect(h.div.querySelector('[aria-label="风格样片"]')).toBeNull();
  });
  it("applies only the theme, keeps scenes and effects byte-identical, and reports success", async () => {
    const initial = project(), snapshot = JSON.stringify(initial);
    const h = await mount(initial);
    await h.click("海报大字");
    expect(h.changes).toHaveLength(0);
    await h.click("应用「海报大字」");
    await h.waitForChange();
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.theme).toBe("bold-poster");
    expect(h.changes[0]!.scenes).toEqual(initial.scenes);
    expect(h.changes[0]!.title).toBe(initial.title);
    expect(JSON.stringify(initial)).toBe(snapshot);
    expect(h.div.querySelector('[role="status"]')?.textContent).toContain("可撤销");
  });
  it("applies the selected style only after a delayed archive succeeds", async () => {
    let resolveArchive!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { resolveArchive = resolve; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/style-catalog/history" && init?.method === "POST") return await pending;
      return { ok: true, json: async () => ({ entries: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const initial = project("glint-dark"), h = await mount(initial);
    await h.click("海报大字"); await h.click("应用「海报大字」");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/style-catalog/history" && init?.method === "POST")).toBe(true));
    expect(h.changes).toHaveLength(0);
    expect(h.div.textContent).toContain("正在保存原主题版本");
    await act(async () => { resolveArchive({ ok: true, json: async () => ({ id: "saved" }) }); });
    await h.waitForChange();
    expect(h.changes[0]).toMatchObject({ theme: "bold-poster", scenes: initial.scenes });
    expect(h.div.textContent).toContain("原主题已保存，可撤销");
  });
  it("waits for archival before applying, and reports archival failures without changing the project", async () => {
    let resolveArchive!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { resolveArchive = resolve; });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/style-catalog/history" && init?.method === "POST") return await pending;
      return { ok: true, json: async () => ({ entries: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = await mount(project("glint-dark"));
    await h.click("海报大字"); await h.click("应用「海报大字」");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/style-catalog/history" && init?.method === "POST")).toBe(true));
    expect(h.changes).toHaveLength(0);
    expect(h.div.textContent).toContain("正在保存原主题版本");
    await act(async () => { resolveArchive({ ok: false, json: async () => ({ error: "storage unavailable" }) }); });
    await vi.waitFor(() => expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("风格未应用"));
    expect(h.changes).toHaveLength(0);
  });
  it("explicitly freezes a named theme without changing scenes", async () => {
    const initial = project("bold-poster"), h = await mount(initial);
    await h.click("固定当前风格参数");
    const next = h.changes[0]!;
    expect(readStyleSnapshot(next.theme)).toMatchObject({ name: "bold-poster", version: "1.0.0", modified: false });
    expect(resolveTheme(next.theme)).toEqual(themes["bold-poster"]);
    expect(next.scenes).toEqual(initial.scenes); expect(initial.theme).toBe("bold-poster");
  });
  it("marks the current pack, disables re-applying, and treats unknown themes as custom", async () => {
    const h = await mount(project("bold-poster"));
    expect(h.div.querySelector('[aria-label="可选风格包"] button[aria-pressed="true"]')?.textContent).toContain("海报大字");
    expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "当前已是这个风格")!.disabled).toBe(true);
    expect(h.div.textContent).toContain("当前：海报大字");
    await h.click("手绘笔记");
    await h.click("应用「手绘笔记」");
    await h.waitForChange();
    expect(h.changes[0]!.theme).toBe("hand-note");
  });
  it("shows a custom-theme state and still allows choosing a pack", async () => {
    const h = await mount(project("brand-custom"));
    expect(h.div.textContent).toContain("当前：自定义主题");
    await h.click("工程蓝图");
    await h.click("应用「工程蓝图」");
    await h.waitForChange();
    expect(h.changes[0]!.theme).toBe("blueprint");
  });
  it("warns and preserves unknown snapshots until the user confirms replacement", async () => {
    const theme = captureStyleTokens("bold-poster");
    (theme.glintStyleSnapshot as Record<string, unknown>).version = "9.0.0";
    const initial = parseProject({ ...project(), theme });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const h = await mount(initial);
      expect(h.div.textContent).toContain("无法识别的风格快照版本或格式已保留");
      await h.click("手绘笔记"); await h.click("应用「手绘笔记」");
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("替换"));
      expect(h.changes).toHaveLength(0); expect(initial.theme).toEqual(theme);
      confirm.mockReturnValue(true);
      await h.click("应用「手绘笔记」");
      await h.waitForChange();
      expect(h.changes[0]!.theme).toBe("hand-note");
    } finally { confirm.mockRestore(); }
  });
  it("confirms before replacing a recognized snapshot with a different pack", async () => {
    const initial = parseProject({ ...project(), theme: captureStyleTokens("bold-poster") });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const h = await mount(initial); await h.click("手绘笔记"); await h.click("应用「手绘笔记」");
      expect(confirm).toHaveBeenCalled(); expect(h.changes).toHaveLength(0);
    } finally { confirm.mockRestore(); }
  });
  it("submits a free draft of the selected style without changing the project", async () => {
    const initial = project("glint-dark");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url === "/api/make" ? { jobId: "idea-trial-123" } : url.includes("/api/make/") ? { id: "idea-trial-123", status: "done", log: [] } : url.includes("samples") ? { entries: [] } : { entries: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const h = await mount(initial);
    await h.click("白板马克笔");
    await h.click("生成当前工程试片");
    const submission = fetchMock.mock.calls.find(call => call[0] === "/api/make");
    expect(submission).toBeTruthy();
    const body = JSON.parse(String(submission![1]?.body));
    expect(body).toMatchObject({ project: { theme: "whiteboard", scenes: initial.scenes }, tts: "mock", music: "off", encoding: "draft" });
    expect(h.changes).toHaveLength(0);
    expect(initial.theme).toBe("glint-dark");
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
    await h.waitForChange();
    expect(h.changes.at(-1)!.theme).toBe(expected.name);
  });
  it("keeps the newest reference when an older analysis finishes later", async () => {
    let resolveOld!: (pixels: [number, number, number][]) => void;
    const old = new Promise<[number, number, number][]>(resolve => { resolveOld = resolve; });
    const h = await mount(project(), file => file.name === "old.png" ? old : Promise.resolve([[240, 240, 240]]));
    const input = h.div.querySelector<HTMLInputElement>('input[aria-label="选择参考图"]')!;
    const choose = async (name: string, type = "image/png") => {
      Object.defineProperty(input, "files", { configurable: true, value: [{ name, type, size: 10 }] });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    };
    await choose("old.png");
    await choose("new.png");
    expect(h.div.textContent).toContain("参考：new.png");
    await act(async () => resolveOld([[10, 10, 10]]));
    expect(h.div.textContent).toContain("参考：new.png");
    expect(h.div.textContent).not.toContain("参考：old.png");
    await choose("invalid.txt", "text/plain");
    expect(h.div.textContent).not.toContain("参考：new.png");
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("请选择一张图片");
    expect(h.changes).toHaveLength(0);
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