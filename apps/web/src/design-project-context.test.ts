// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_DRAFT_KEY, brandExportDocument, brandTokens, clearProjectBrand, pinBrandToProject, projectBrandKey, readBrandTheme, type BrandTheme } from "./design-brand";
import { projectAssetsKey, readProjectAssets, rememberProjectAsset, type LibraryAsset } from "./design-assets";
import { createProjectDesignDocuments, designDocumentsKey, saveProjectDesignDocuments } from "./design-artifacts";

const brand: BrandTheme = { name: "山茶", accent: "#e0533d", bg: "#12100e", text: "#f4f1ea", logoText: "山茶" };
const asset: LibraryAsset = { name: "cup.png", url: "/api/media/assets/cup.png", bytes: 2048 };

beforeEach(() => { localStorage.clear(); vi.stubGlobal("location", { origin: "http://localhost:3000" }); });
afterEach(() => vi.unstubAllGlobals());

describe("project brand", () => {
  it("pins a brand to one project without touching the studio draft", () => {
    localStorage.setItem(BRAND_DRAFT_KEY, JSON.stringify({ name: "全局", colors: { accent: "#336699", bg: "#000000", text: "#ffffff" } }));
    pinBrandToProject("p1", brand);
    expect(readBrandTheme("p1")).toMatchObject({ source: "project", theme: { name: "山茶", accent: "#e0533d" } });
    expect(readBrandTheme("p2")).toMatchObject({ source: "studio", theme: { name: "全局" } });
    expect(localStorage.getItem(projectBrandKey("p1"))).toContain("山茶");
  });

  it("falls back to the studio draft after clearing the project pin", () => {
    localStorage.setItem(BRAND_DRAFT_KEY, JSON.stringify({ name: "全局", colors: { accent: "#336699", bg: "#000000", text: "#ffffff" } }));
    pinBrandToProject("p1", brand);
    clearProjectBrand("p1");
    expect(readBrandTheme("p1").source).toBe("studio");
  });

  it("reports no brand at all when nothing is configured", () => {
    expect(readBrandTheme("p1")).toEqual({ theme: null, source: "none" });
  });

  it("validates stored brand fields and refuses active CSS font payloads", () => {
    const bad = { ...brand, displayFont: 'Arial;}</style><img src="https://evil.invalid">' };
    expect(brandTokens(bad)).toEqual({});
    expect(() => pinBrandToProject("p1", bad)).toThrow(/不安全/);
    localStorage.setItem(projectBrandKey("p1"), JSON.stringify({ name: "恶意", colors: { accent: "#123456" }, fonts: { display: bad.displayFont } }));
    expect(readBrandTheme("p1").source).toBe("none");
    localStorage.setItem(projectBrandKey("p1"), JSON.stringify({ name: "a".repeat(61), colors: { accent: "#123456" } }));
    expect(readBrandTheme("p1").source).toBe("none");
  });

  it("injects exactly the preview brand tokens into a copy of every export page", () => {
    const source = { id: "doc", title: "设计", kind: "slides" as const, activePageId: "p1", updatedAt: 1, pages: [
      { id: "p1", title: "一", html: '<style>:root{--accent:#000000}</style><h1 style="color:var(--accent)">品牌</h1>', notes: "讲稿" },
      { id: "p2", title: "二", html: '<main style="background:var(--brand-bg)">第二页</main>' },
    ] };
    const before = JSON.stringify(source), theme = { ...brand, displayFont: '"Noto Sans SC", sans-serif' };
    const exported = brandExportDocument(source, theme);
    expect(JSON.stringify(source)).toBe(before); expect(exported).not.toBe(source);
    for (const page of exported.pages) {
      const doc = new DOMParser().parseFromString(page.html, "text/html"), style = doc.head.lastElementChild;
      expect(style?.getAttribute("data-glint-export-brand")).toBe("true");
      for (const [key, value] of Object.entries(brandTokens(theme))) expect(style?.textContent).toContain(`${key}:${value}`);
    }
    expect(exported.pages[0]?.notes).toBe("讲稿"); expect(brandExportDocument(source, null)).toBe(source);
  });

  it("仅在导出副本应用本地项目品牌，不回写源码、保存字节或其他项目品牌", () => {
    const state = createProjectDesignDocuments("p1"), source = state.documents[0]!;
    source.pages[0]!.html = '<main><img data-design-id="photo" src="data:image/png;base64,AQID"><h1 style="color:var(--accent)">原稿</h1></main>';
    pinBrandToProject("p1", brand);
    const otherBrand = { ...brand, name: "另一项目", accent: "#336699" };
    pinBrandToProject("p2", otherBrand); saveProjectDesignDocuments(state);
    const before = JSON.stringify(state), stored = localStorage.getItem(designDocumentsKey("p1"));
    const ownBrandBytes = localStorage.getItem(projectBrandKey("p1")), otherBrandBytes = localStorage.getItem(projectBrandKey("p2"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const exported = brandExportDocument(source, readBrandTheme("p1").theme);
    expect(exported).toMatchObject({ id: source.id, kind: source.kind, activePageId: source.activePageId, updatedAt: source.updatedAt });
    for (const [index, page] of exported.pages.entries()) {
      expect(page).not.toBe(source.pages[index]);
      const html = new DOMParser().parseFromString(page.html, "text/html");
      expect(html.querySelectorAll("[data-glint-export-brand]")).toHaveLength(1);
      expect(html.querySelector("[data-glint-export-brand]")?.textContent).toContain(`--accent:${brand.accent}`);
    }
    expect(exported.pages[0]!.html).toContain("data:image/png;base64,AQID");
    expect(JSON.stringify(state)).toBe(before); expect(localStorage.getItem(designDocumentsKey("p1"))).toBe(stored);
    expect(localStorage.getItem(projectBrandKey("p1"))).toBe(ownBrandBytes);
    expect(localStorage.getItem(projectBrandKey("p2"))).toBe(otherBrandBytes);
    expect(readBrandTheme("p2").theme).toEqual(otherBrand); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("project assets", () => {
  it("remembers picks per project, newest first, without duplicates", () => {
    rememberProjectAsset("p1", asset);
    rememberProjectAsset("p1", { name: "table.webp", url: "/api/media/assets/table.webp", bytes: 1024 });
    rememberProjectAsset("p1", asset);
    const own = readProjectAssets("p1");
    expect(own.map(item => item.name)).toEqual(["cup.png", "table.webp"]);
    expect(readProjectAssets("p2")).toEqual([]);
    expect(localStorage.getItem(projectAssetsKey("p1"))).toContain("cup.png");
  });

  it("ignores corrupt storage instead of throwing", () => {
    localStorage.setItem(projectAssetsKey("p1"), "{not json");
    expect(readProjectAssets("p1")).toEqual([]);
  });

  it.each([null, { ...asset, url: "https://evil.invalid/cup.png" }, { ...asset, url: "/api/media/assets/other.png" }, { ...asset, url: "/api/media/assets/%63up.png" }, { ...asset, bytes: "2048" }, { ...asset, bytes: 0 }, { ...asset, bytes: -1 }, { ...asset, bytes: 524289 }, { ...asset, name: "../cup.png" }])("validates stored and incoming project refs %j", value => {
    localStorage.setItem(projectAssetsKey("p1"), JSON.stringify([value, asset]));
    expect(readProjectAssets("p1")).toEqual([asset]);
    const before = localStorage.getItem(projectAssetsKey("p1"));
    expect(() => rememberProjectAsset("p1", value as LibraryAsset)).toThrow(/无效/);
    expect(localStorage.getItem(projectAssetsKey("p1"))).toBe(before);
  });

  it("bounds stored recency lists and normalizes only schema fields", () => {
    rememberProjectAsset("p1", { ...asset, extra: "不持久化" } as LibraryAsset);
    expect(JSON.parse(localStorage.getItem(projectAssetsKey("p1"))!)).toEqual([asset]);
    localStorage.setItem(projectAssetsKey("p1"), JSON.stringify(Array(41).fill(asset)));
    expect(readProjectAssets("p1")).toEqual([]);
  });
});
