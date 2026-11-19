// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createProjectDesignDocuments, designDocumentsKey, DesignHistory, readProjectDesignDocuments, reorderDesignPages, saveProjectDesignDocuments } from "./design-artifacts";
import { applyDesignGesture, describeDesignNode, normalizeDesignHtml, parseDesignHtml, patchDesignNodes } from "./design-editor-dom";
import { buildDesignPreview, DESIGN_BRIDGE, readDesignBridgeMessage } from "./design-editor-bridge";
function storage() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
describe("design sidecar persistence and history", () => {
  it("seeds independent editable pages, interactive prototype and three actual slides", () => {
    const state = createProjectDesignDocuments("p", "中文设计");
    expect(state.documents.map(doc => doc.kind)).toEqual(["page", "prototype", "slides"]);
    expect(state.documents[2]!.pages).toHaveLength(3);
    expect(state.documents[1]!.pages[0]!.html).toContain("addEventListener");
    expect(state.documents.every(doc => doc.pages.every(page => page.html.includes("<main")))).toBe(true);
  });
  it("round trips active page, source, notes and project isolation", () => {
    const target = storage(), state = createProjectDesignDocuments("a");
    state.documents[2]!.pages[1]!.notes = "中文讲述\n保留空白  "; state.activeId = state.documents[2]!.id;
    state.documents[2]!.activePageId = state.documents[2]!.pages[1]!.id;
    saveProjectDesignDocuments(state, target, null); expect(readProjectDesignDocuments("a", target)).toEqual(state);
    expect(readProjectDesignDocuments("b", target).documents).toEqual([]);
  });
  it("refuses corrupt, foreign, unknown schema and conflicting old data without replacement", () => {
    const target = storage(), key = designDocumentsKey("p"), state = createProjectDesignDocuments("p");
    for (const raw of ["{broken", JSON.stringify({ ...state, version: 99 }), JSON.stringify({ ...state, projectId: "foreign" })]) {
      target.setItem(key, raw); expect(() => saveProjectDesignDocuments(state, target, raw)).toThrow("旧存储未覆盖"); expect(target.getItem(key)).toBe(raw);
    }
    target.values.clear(); saveProjectDesignDocuments(state, target, null); const before = target.getItem(key);
    expect(() => saveProjectDesignDocuments(state, target, null)).toThrow("其他窗口"); expect(target.getItem(key)).toBe(before);
  });
  it("reports quota and read-denial while preserving existing bytes", () => {
    const target = storage(), state = createProjectDesignDocuments("p"); saveProjectDesignDocuments(state, target, null); const raw = target.getItem(designDocumentsKey("p"));
    expect(() => saveProjectDesignDocuments(state, { ...target, setItem: () => { throw Error("quota"); } }, raw)).toThrow("空间不足");
    expect(target.getItem(designDocumentsKey("p"))).toBe(raw);
    expect(() => readProjectDesignDocuments("p", { getItem: () => { throw Error("denied"); } })).toThrow("读取失败");
  });
  it("reorders without losing notes and uses a single undo stack for sources and pages", () => {
    const before = createProjectDesignDocuments("p"), doc = before.documents[2]!;
    const next = { ...before, documents: before.documents.map(item => item.id === doc.id ? reorderDesignPages(doc, 0, 2) : item) };
    const history = new DesignHistory(); history.record(before, next); expect(next.documents[2]!.pages[2]!.id).toBe(doc.pages[0]!.id);
    expect(history.move(next, "undo")).toEqual(before); expect(history.move(before, "redo")).toEqual(next);
    expect(() => reorderDesignPages(doc, -1, 0)).toThrow("无效");
  });
});
describe("static DOM editing", () => {
  const html = '<h1 data-design-id="title">原稿</h1><div data-design-id="group"><p>正文</p></div><script data-design-id="evil">window.x=1</script>';
  it("keeps IDs stable and excludes scripts from selection edits", () => {
    const normalized = normalizeDesignHtml(html); expect(normalizeDesignHtml(normalized)).toBe(normalized);
    expect(describeDesignNode(html, "evil")).toBeUndefined(); expect(() => patchDesignNodes(html, ["evil"], { text: "unsafe" })).toThrow("静态源码");
    expect(describeDesignNode(html, 'title"] script')).toBeUndefined();
  });
  it("writes text as text, whitelisted CSS only and never serializes preview glue", () => {
    const result = patchDesignNodes(html, ["title"], { text: '<img src=x onerror="alert(1)">中文', fontSize: "32px", color: "#ff0000" });
    const element = parseDesignHtml(result).querySelector('[data-design-id="title"]')!;
    expect(element.textContent).toBe('<img src=x onerror="alert(1)">中文'); expect(element.querySelector("img")).toBeNull(); expect(result).not.toContain("data-design-overlay");
    expect(() => patchDesignNodes(html, ["title"], { backgroundColor: "url(https://evil.test/x)" })).toThrow("属性值无效");
    expect(() => patchDesignNodes(html, ["group"], { text: "would erase children" })).toThrow("包含子节点");
  });
  it("supports move, resize, multi-node patch and locked family exclusion", () => {
    const moved = applyDesignGesture(html, ["title"], { dx: 25, dy: -8 }); expect(describeDesignNode(moved, "title")!.style).toMatchObject({ left: "25px", top: "-8px", position: "relative" });
    const resized = applyDesignGesture(moved, ["title"], { dx: 0, dy: 0, width: 300, height: 90 }); expect(describeDesignNode(resized, "title")!.style.width).toBe("300px");
    const locked = patchDesignNodes(resized, ["group"], { locked: true });
    expect(patchDesignNodes(locked, ["group"], { color: "red" })).toBe(locked);
    const changed = patchDesignNodes(html, ["title", "group"], { color: "blue" }); expect(describeDesignNode(changed, "group")!.style.color).toBe("blue");
  });
});
describe("opaque preview protocol", () => {
  it("rejects wrong source/generation/type/gesture; accepts exact iframe source only", () => {
    const source = window as Window, data = { type: DESIGN_BRIDGE, generation: "g", action: "select", nodeId: "title", nodeIds: ["title"] };
    expect(readDesignBridgeMessage(new MessageEvent("message", { data, source }), source, "g")?.nodeId).toBe("title");
    expect(readDesignBridgeMessage(new MessageEvent("message", { data, source: null }), source, "g")).toBeUndefined();
    expect(readDesignBridgeMessage(new MessageEvent("message", { data, source }), source, "stale")).toBeUndefined();
    expect(readDesignBridgeMessage(new MessageEvent("message", { data: { ...data, action: "eval", code: "bad" }, source }), source, "g")).toBeUndefined();
    expect(readDesignBridgeMessage(new MessageEvent("message", { data: { ...data, action: "gesture", dx: Infinity, dy: 0 }, source }), source, "g")).toBeUndefined();
  });
  it("puts CSP before untrusted source and bridge before user scripts, restricts navigation via outer frame", () => {
    const original = '<h1 data-design-id="title">你好</h1><script>window.localDemo=true</script><iframe src="https://evil.test"></iframe>';
    const output = buildDesignPreview(original, "g", false, { "--accent": "#ff5c35" });
    const outer = new DOMParser().parseFromString(output, "text/html"), frame = outer.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); expect(output).not.toContain("allow-same-origin");
    expect(outer.querySelector("meta")!.content).toContain("frame-src 'self'");
    const child = new DOMParser().parseFromString(frame.getAttribute("srcdoc")!, "text/html");
    expect(child.querySelector("meta")!.content).toContain("connect-src 'none'"); expect(child.querySelector("iframe")).toBeNull();
    const scripts = child.querySelectorAll("script"); expect(scripts[0]!.textContent).toContain("data-design-overlay"); expect(scripts[1]!.textContent).toContain("window.localDemo=true");
    expect(original).not.toContain("data-design-overlay");
  });
});
