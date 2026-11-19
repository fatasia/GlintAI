// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandTokens } from "./design-brand";
import { exportDesignDocument } from "./design-export-client";
import type { DesignDocument } from "./design-artifacts";
const document: DesignDocument = { id: "a", title: "中文", kind: "page", pages: [{ id: "p", title: "页", html: "<h1>你好</h1>" }], activePageId: "p", updatedAt: 1 };
const payload = { file: "design-1234-abcd.pptx", bytes: 100, path: "D:/exports/result.pptx", warnings: ["复杂效果局部栅格化"], editableElements: 4, url: "https://evil.invalid/file" };
afterEach(() => vi.unstubAllGlobals());
describe("design export client", () => {
  it("posts the full document and derives a local download route, not untrusted response URL", async () => {
    const mock = vi.fn().mockResolvedValue(Response.json(payload)); vi.stubGlobal("fetch", mock);
    const result = await exportDesignDocument(document, "pptx");
    expect(mock.mock.calls[0]![0]).toBe("/api/design/export");
    expect(JSON.parse(mock.mock.calls[0]![1].body)).toEqual({ document, format: "pptx" });
    expect(result.url).toBe("/api/design/exports/design-1234-abcd.pptx"); expect(result.editableElements).toBe(4); expect(result.warnings).toEqual(payload.warnings);
  });
  it.each(["html", "png", "pdf", "pptx", "zip"] as const)("sends a branded copy through the unchanged %s route contract", async format => {
    const brand = { name: "品牌", accent: "#123456", bg: "#ffffff", text: "#111111", displayFont: '"Noto Sans SC", sans-serif' };
    const before = JSON.stringify(document), mock = vi.fn().mockResolvedValue(Response.json(payload)); vi.stubGlobal("fetch", mock);
    await exportDesignDocument(document, format, undefined, brand);
    const request = JSON.parse(mock.mock.calls[0]![1].body);
    expect(Object.keys(request).sort()).toEqual(["document", "format"]); expect(request.format).toBe(format);
    const page = new DOMParser().parseFromString(request.document.pages[0].html, "text/html");
    const css = page.querySelector("[data-glint-export-brand]")?.textContent;
    for (const [key, value] of Object.entries(brandTokens(brand))) expect(css).toContain(`${key}:${value}`);
    expect(JSON.stringify(document)).toBe(before);
  });
  it("失败后重试导出只对每次副本加品牌，保留多页、批注、图片和原始文档", async () => {
    const source: DesignDocument = { ...document, kind: "slides", pages: [
      { id: "p", title: "第一页", html: '<main><img data-design-id="photo" src="data:image/png;base64,AQID"><h1>品牌页面</h1></main>', notes: "讲稿", annotations: [{ id: "mark", x: 25, y: 50, text: "保留批注", nodeId: "photo", createdAt: 1 }] },
      { id: "p2", title: "第二页", html: '<style>:root{--accent:#000000}</style><main>第二页</main>' },
    ] };
    const brand = { name: "项目品牌", accent: "#123456", bg: "#ffffff", text: "#111111" }, before = JSON.stringify(source);
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ error: "导出暂不可用" }, { status: 503 })).mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal("fetch", mock);
    await expect(exportDesignDocument(source, "pptx", undefined, brand)).rejects.toMatchObject({ status: 503 });
    expect(JSON.stringify(source)).toBe(before);
    await exportDesignDocument(source, "pptx", undefined, brand);
    expect(mock).toHaveBeenCalledTimes(2);
    for (const call of mock.mock.calls) {
      expect(call[0]).toBe("/api/design/export");
      const request = JSON.parse(call[1].body);
      expect(Object.keys(request).sort()).toEqual(["document", "format"]);
      expect(request.document).toMatchObject({ id: source.id, kind: "slides", activePageId: "p", updatedAt: 1 });
      expect(request.document.pages).toHaveLength(2);
      expect(request.document.pages[0]).toMatchObject({ notes: "讲稿", annotations: source.pages[0]!.annotations });
      expect(request.document.pages[0].html).toContain("data:image/png;base64,AQID");
      for (const page of request.document.pages) {
        const html = new DOMParser().parseFromString(page.html, "text/html");
        expect(html.querySelectorAll("[data-glint-export-brand]")).toHaveLength(1);
        expect(html.head.lastElementChild?.textContent).toContain("--accent:#123456");
      }
    }
    expect(JSON.stringify(source)).toBe(before);
  });
  it("rejects unsafe brand before starting a request", async () => {
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(exportDesignDocument(document, "html", undefined, { name: "品牌", accent: "red;display:none", bg: "#ffffff", text: "#000000" })).rejects.toThrow(/品牌变量无效/);
    expect(mock).not.toHaveBeenCalled();
  });
  it("passes cancellation and exposes meaningful server rejection", async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ error: "已有设计正在导出" }, { status: 429 })); vi.stubGlobal("fetch", mock);
    await expect(exportDesignDocument(document, "png")).rejects.toMatchObject({ message: "已有设计正在导出", status: 429 });
    const controller = new AbortController(); controller.abort();
    mock.mockImplementation((_url, init) => { expect(init.signal.aborted).toBe(true); return Promise.reject(new DOMException("已取消", "AbortError")); });
    await expect(exportDesignDocument(document, "png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([null, { ...payload, file: "../../secret" }, { ...payload, bytes: 0 }, { ...payload, warnings: [4] }, { ...payload, editableElements: -1 }])("rejects invalid success payload %j", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
    await expect(exportDesignDocument(document, "html")).rejects.toThrow("结果无效");
  });
  it("reports invalid server JSON and null errors without a TypeError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 502 })));
    await expect(exportDesignDocument(document, "html")).rejects.toThrow("响应无效 (502)");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null, { status: 500 })));
    await expect(exportDesignDocument(document, "html")).rejects.toThrow("设计导出失败 (500)");
  });
});
