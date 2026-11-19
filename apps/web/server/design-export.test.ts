import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { createDesignExporter } from "./design-export.mjs";
import { prepareDesign } from "./design-export-html.mjs";
import { injectSlideTransitions } from "./design-export-pptx.mjs";
import { validateDesignRequest } from "./design-export-contract.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=", "base64");
const doc = (html = '<h1>你好，中文设计</h1><a href="#page-2">下一页</a>') => ({ id: "opaque/../not-a-path", title: "导出测试 中文", kind: "prototype", pages: [{ id: "page-1", title: "首页", html }, { id: "page-2", title: "第二页", html: "<h2>第二页内容</h2>" }], activePageId: "page-1", updatedAt: 1 });
let root: string, outputDir: string, asset: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "glint-design-export-")); outputDir = path.join(root, "exports"); asset = path.join(root, "photo.png"); await fs.writeFile(asset, png); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("design source exports", () => {
  it("produces portable HTML with navigation, original source and inline prototype script", async () => {
    const document = doc('<button id="go">交互</button><script>document.getElementById("go").onclick=()=>document.getElementById("go").textContent="完成"</script><a href="#page-2">下一页</a>');
    const result = await createDesignExporter({ outputDir }).run({ document, format: "html" });
    const html = await fs.readFile(result.path, "utf8");
    expect(result.file).toMatch(/^design-[a-f\d-]+\.html$/); expect(result.bytes).toBe(Buffer.byteLength(html));
    expect(html).toContain('sandbox="allow-scripts"'); expect(html).toContain('data-page="1"'); expect(html).toContain("data-export-page"); expect(html).toContain('id="design-source"'); expect(html).toContain("完成"); expect(result.warnings.join(" ")).toContain("静态布局");
  });
  it("ZIP includes actual raw source, portable pages and only referenced managed assets", async () => {
    const document = doc('<h1>原始源码 中文</h1><img src="assets/photo.png"><div style="background-image:url(/api/media/assets/photo.png)">图片</div>');
    const requested: string[] = [];
    const result = await createDesignExporter({ outputDir, mediaAsset: (name: string) => { requested.push(name); return name === "photo.png" ? asset : undefined; } }).run({ document, format: "zip" });
    const archive = unzipSync(await fs.readFile(result.path));
    expect(strFromU8(archive["source/page-1.html"]!)).toBe(document.pages[0]!.html);
    expect(strFromU8(archive["document.json"]!)).toContain("原始源码 中文");
    expect(Buffer.from(archive["assets/photo.png"]!)).toEqual(png);
    expect(strFromU8(archive["pages/page-1.html"]!)).toContain("data:image/png;base64,");
    expect(strFromU8(archive["index.html"]!)).toContain("第二页");
    expect(requested).toEqual(["photo.png"]);
    expect(JSON.parse(strFromU8(archive["export-manifest.json"]!)).assets[0].sha256).toMatch(/^[a-f\d]{64}$/);
  });
  it("does not fetch external CSS, SVG href, nested frames or remote HTML links", async () => {
    const document = doc('<h1>外链</h1><style>@import "https://bad.invalid/a.css";.a{background:url(https://bad.invalid/a.png)}</style><svg><image href="https://bad.invalid/a.svg"/></svg><img src="https://bad.invalid/a.png"><iframe src="file:///etc/passwd"></iframe><a href="https://bad.invalid">外站</a>');
    const requested: string[] = [];
    const prepared = await prepareDesign(document, { mediaAsset: (name: string) => { requested.push(name); throw new Error("must not call"); } });
    expect(requested).toEqual([]);
    expect(prepared.pages[0].staticHtml).not.toContain("https://bad.invalid");
    expect(prepared.pages[0].staticHtml).not.toContain("file:///");
    expect([...prepared.warnings].join(" ")).toContain("未获取外部");
    expect([...prepared.warnings].join(" ")).toContain("@import");
  });
  it.each(["file:///C:/Windows/win.ini", "assets/../secret.png", "assets/%2e%2e%2fsecret.png", "C:\\Windows\\win.ini", "javascript:alert(1)"])("rejects unsafe resource %s", async value => {
    await expect(createDesignExporter({ outputDir }).run({ document: doc(`<p>安全</p><img src="${value}">`), format: "html" })).rejects.toThrow(/拒绝/);
  });
  it("rejects SVG data resources and disables all static active content", async () => {
    const prepared = await prepareDesign(doc('<h1 onclick="fetch(1)">你好</h1><script>throw new Error("bad")</script><img src="data:image/svg+xml;base64,PHN2Zy8+"><form action="https://bad.invalid"><button>提交</button></form>'));
    expect(prepared.pages[0].staticHtml).not.toContain("onclick"); expect(prepared.pages[0].staticHtml).not.toContain("<script"); expect(prepared.pages[0].staticHtml).not.toContain("data:image/svg"); expect(prepared.pages[0].staticHtml).not.toContain('action=');
    expect([...prepared.warnings].join(" ")).toContain("SVG");
  });
  it("preserves inline GIF images under the existing data-only CSP", async () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    const prepared = await prepareDesign(doc(`<h1>GIF</h1><img src="${gif}">`));
    expect(prepared.pages[0].portable).toContain(gif); expect(prepared.pages[0].staticHtml).toContain(gif);
    expect(prepared.pages[0].portable).toContain("img-src data:");
    expect([...prepared.warnings].join(" ")).not.toContain("非位图");
  });
  it("keeps export-copy brand variables in portable and static pages without widening CSP", async () => {
    const html = '<html><head><style>:root{--accent:#000000}</style><style data-glint-export-brand="true">:root{--brand-accent:#e0533d;--brand-bg:#ffffff;--brand-text:#121212;--brand-font:Arial;--accent:#e0533d}</style></head><body><h1 style="color:var(--accent)">品牌</h1></body></html>';
    const prepared = await prepareDesign(doc(html));
    for (const value of [prepared.pages[0].portable, prepared.pages[0].staticHtml]) {
      expect(value).toContain("--accent:#e0533d"); expect(value).toContain("data-glint-export-brand"); expect(value).toContain("connect-src 'none'");
      expect(value.indexOf("--accent:#e0533d")).toBeGreaterThan(value.indexOf("--accent:#000000"));
    }
  });
  it("rejects missing managed assets instead of generating a fake result", async () => {
    await expect(createDesignExporter({ outputDir }).run({ document: doc('<p>素材</p><img src="/api/media/assets/missing.png">'), format: "zip" })).rejects.toThrow("不在服务管理");
  });
  it("rejects blank/oversized/duplicate documents and unsupported formats", async () => {
    await expect(createDesignExporter({ outputDir }).run({ document: doc("<html><body> </body></html>"), format: "html" })).rejects.toThrow("空白");
    expect(() => validateDesignRequest({ document: doc("中".repeat(800_000)), format: "html" })).toThrow("2MB");
    expect(() => validateDesignRequest({ document: { ...doc(), pages: Array.from({ length: 31 }, (_, i) => ({ id: `p${i}`, title: "p", html: "<p>text</p>" })) }, format: "html" })).toThrow("30");
    const duplicate = doc(); duplicate.pages[1]!.id = duplicate.pages[0]!.id;
    const huge = { ...doc(), pages: Array.from({ length: 5 }, (_, i) => ({ id: i ? `p${i}` : "page-1", title: "p", html: `<p>${"a".repeat(1_800_000)}</p>` })) };
    expect(() => validateDesignRequest({ document: huge, format: "html" })).toThrow("8MB");
    expect(() => validateDesignRequest({ document: duplicate, format: "html" })).toThrow("重复");
    expect(() => validateDesignRequest({ document: doc(), format: "mov" })).toThrow("导出格式");
  });
  it("rejects cancelled work and concurrent requests, recovers for another export", async () => {
    const exporter = createDesignExporter({ outputDir });
    const controller = new AbortController(); controller.abort();
    await expect(exporter.run({ document: doc(), format: "html", signal: controller.signal })).rejects.toThrow("取消");
    const first = exporter.run({ document: doc(), format: "html" });
    await expect(exporter.run({ document: doc(), format: "html" })).rejects.toMatchObject({ status: 429 });
    await first;
    const next = await exporter.run({ document: doc(), format: "zip" }); expect(next.bytes).toBeGreaterThan(0);
    expect((await fs.readdir(outputDir)).some(name => name.endsWith(".part"))).toBe(false);
  });
  it("wires explicit page transitions and step reveal into the exported deck, leaves unset pages instant", async () => {
    const document = doc();
    document.pages[1] = { ...document.pages[1]!, transition: { type: "wipe", durationMs: 800 } };
    document.pages[0] = { ...document.pages[0]!, stepReveal: true };
    const result = await createDesignExporter({ outputDir }).run({ document, format: "html" });
    const html = await fs.readFile(result.path, "utf8");
    expect(html).toContain("@keyframes glint-page-wipe-in");
    expect(html).toContain('"type":"wipe","durationMs":800');
    expect(html).toContain("animationPlayState='paused'");
    expect(html).not.toContain("@keyframes glint-page-fade-in");
    const plain = await createDesignExporter({ outputDir }).run({ document: doc(), format: "html" });
    expect(await fs.readFile(plain.path, "utf8")).toContain("transitions=[null,null]");
  });
  it("injects native slide transitions into pptx slide xml with a legacy fallback", () => {
    const slide = (_: number) => `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/><p:clrMapOvr><a:masterClrMapping xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></p:clrMapOvr></p:sld>`;
    const fake = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/slides/slide1.xml": strToU8(slide(1)), "ppt/slides/slide2.xml": strToU8(slide(2)) }, { level: 6 });
    const { buffer, injected } = injectSlideTransitions(fake, [{ transition: { type: "push", durationMs: 500 } } as never, {} as never]);
    expect(injected).toBe(1);
    const archive = unzipSync(new Uint8Array(buffer));
    const text = strFromU8(archive["ppt/slides/slide1.xml"]!);
    expect(text).toContain('Requires="p14"');
    expect(text).toContain('p14:dur="500"');
    expect(text).toContain('<p:push dir="l"/>');
    expect(text).toContain("<mc:Fallback>");
    expect(text.indexOf("mc:AlternateContent")).toBeGreaterThan(text.indexOf("</p:clrMapOvr>"));
    expect(strFromU8(archive["ppt/slides/slide2.xml"]!)).not.toContain("p:transition");
  });
});
