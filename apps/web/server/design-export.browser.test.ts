import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { createDesignExporter } from "./design-export.mjs";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
let root: string;
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "glint-design-render-")); });
afterAll(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=";
const document = { id: "test", title: "中文演示", kind: "slides", pages: [
  { id: "one", title: "一", notes: "讲稿 中文备注", html: `<style>body{margin:0;background:#fff}.box{position:absolute;left:80px;top:120px;width:300px;height:160px;background:#336699;border:2px solid #222;border-radius:12px}h1{position:absolute;left:80px;top:30px;font-size:40px;color:#122334}</style><h1>你好，中文设计</h1><div class="box"></div><img style="position:absolute;left:450px;top:120px;width:120px;height:120px" src="${image}">` },
  { id: "two", title: "二", html: '<h2 style="font-size:48px;color:rgb(255,0,0)">第二页</h2><div style="width:160px;height:120px;background:linear-gradient(red,blue)">复杂效果</div>' },
], activePageId: "one", updatedAt: 1 };
it("creates a real 1280x720 PNG of the active page, a 2-page PDF, editable text/shapes/images PPTX", async () => {
  const exporter = createDesignExporter({ outputDir: root });
  const png = await exporter.run({ document, format: "png" });
  const bytes = await fs.readFile(png.path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBe(1280); expect(bytes.readUInt32BE(20)).toBe(720);
  expect(png.warnings.join(" ")).toContain("当前页面");
  const pdf = await exporter.run({ document, format: "pdf" });
  const pdfBytes = await fs.readFile(pdf.path), source = pdfBytes.toString("latin1");
  expect(source.startsWith("%PDF-")).toBe(true);
  expect(source.match(/\/Type\s*\/Page\b/g)?.length).toBe(2);
  const pptx = await exporter.run({ document, format: "pptx" });
  const files = unzipSync(await fs.readFile(pptx.path)), slide = strFromU8(files["ppt/slides/slide1.xml"]!);
  expect(slide).toContain("你好，中文设计"); expect(slide).toContain("<p:sp>"); expect(slide).toContain("<a:prstGeom"); expect(slide).toContain("<p:pic>");
  expect(slide).toContain('val="336699"'); expect(Object.keys(files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
  expect(strFromU8(files["ppt/notesSlides/notesSlide1.xml"]!)).toContain("讲稿 中文备注");
  expect(pptx.editableElements).toBeGreaterThanOrEqual(4); expect(pptx.warnings.join(" ")).toContain("局部栅格化");
  expect((await fs.readdir(root)).some(name => name.endsWith(".part"))).toBe(false);
}, 120_000);
it("renders export-copy brand colors consistently in PNG, PDF, PPTX and HTML", async () => {
  const source = { ...document, pages: [{ ...document.pages[0], html: '<html><head><style>:root{--accent:#336699}</style><style data-glint-export-brand="true">:root{--brand-accent:#e0533d;--brand-bg:#ffffff;--brand-text:#121212;--accent:#e0533d}</style></head><body><div style="position:absolute;left:0;top:0;width:400px;height:400px;background:var(--accent)"></div><h1 style="position:absolute;left:500px;top:20px;color:var(--brand-text)">品牌导出</h1></body></html>' }] };
  const before = JSON.stringify(source), exporter = createDesignExporter({ outputDir: root });
  const png = await exporter.run({ document: source, format: "png" });
  const pngBytes = await fs.readFile(png.path);
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
  try {
    const page = await browser.newPage();
    const pixel = await page.evaluate(async (src: string) => {
      const img = new Image(); img.src = src; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const context = canvas.getContext("2d")!; context.drawImage(img, 0, 0);
      return [...context.getImageData(100, 100, 1, 1).data];
    }, `data:image/png;base64,${pngBytes.toString("base64")}`);
    expect(pixel).toEqual([224, 83, 61, 255]);
    const html = await exporter.run({ document: source, format: "html" });
    const output = await fs.readFile(html.path, "utf8");
    expect(output).toContain("data-glint-export-brand");
    await page.setContent(output);
    const frame = page.frames().find((item: any) => item.parentFrame());
    await frame.waitForSelector("h1");
    expect(await frame.$eval("div", (node: Element) => getComputedStyle(node).backgroundColor)).toBe("rgb(224, 83, 61)");
  } finally { await browser.close(); }
  const pdf = await exporter.run({ document: source, format: "pdf" });
  expect((await fs.readFile(pdf.path)).subarray(0, 5).toString()).toBe("%PDF-");
  const pptx = await exporter.run({ document: source, format: "pptx" });
  const archive = unzipSync(await fs.readFile(pptx.path));
  expect(strFromU8(archive["ppt/slides/slide1.xml"]!)).toContain('val="E0533D"');
  expect(JSON.stringify(source)).toBe(before);
}, 120_000);
it("captures untrusted scripts, SVG and CSS without any outbound request or local file disclosure", async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("UNSAFE_NETWORK_CONTENT"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/secret`;
  try {
    const html = `<h1>安全捕获</h1><script>document.body.textContent='SCRIPT_EXECUTED';fetch('${url}')</script><style>@import '${url}';body{background:url('${url}')}</style><svg><image href="${url}"/></svg><img src="${url}"><a href="${url}">外链</a>`;
    const result = await createDesignExporter({ outputDir: root }).run({ document: { ...document, pages: [{ ...document.pages[0], html }] }, format: "pptx" });
    expect(requests).toBe(0); const files = unzipSync(await fs.readFile(result.path));
    const slide = strFromU8(files["ppt/slides/slide1.xml"]!);
    expect(slide).toContain("安全捕获"); expect(slide).not.toContain("SCRIPT_EXECUTED"); expect(slide).not.toContain("UNSAFE_NETWORK_CONTENT");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
it("rejects script-only static captures, cancels its own browser and recovers", async () => {
  const exporter = createDesignExporter({ outputDir: root });
  await expect(exporter.run({ document: { ...document, pages: [{ ...document.pages[0], html: '<script>document.body.textContent="动态内容"</script>' }] }, format: "png" })).rejects.toThrow("静态捕获中为空白");
  const controller = new AbortController();
  const task = exporter.run({ document, format: "pdf", signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await expect(task).rejects.toThrow("取消");
  const recovered = await exporter.run({ document, format: "html" }); expect(recovered.bytes).toBeGreaterThan(0);
}, 60_000);
it("HTML export really clicks through pages and runs inline prototype interaction only in opaque sandbox", async () => {
  const exporter = createDesignExporter({ outputDir: root });
  const source = { ...document, kind: "prototype", pages: [{ ...document.pages[0], html: '<button id="reserve">预约</button><a href="#two">下一页</a><script>document.getElementById("reserve").onclick=()=>document.getElementById("reserve").textContent="已预约"</script>' }, { ...document.pages[1], html: "<h1>原型第二页</h1>" }] };
  const result = await exporter.run({ document: source, format: "html" });
  const html = await fs.readFile(result.path, "utf8");
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html;charset=utf-8"); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.waitForFunction(() => document.querySelector("iframe")?.getAttribute("srcdoc"));
    let frame = page.frames().find((f: any) => f.parentFrame());
    await frame.waitForSelector("#reserve"); await frame.click("#reserve");
    expect(await frame.$eval("#reserve", (el: Element) => el.textContent)).toBe("已预约");
    expect(await frame.evaluate(() => { try { return Boolean(parent.document.body); } catch { return false; } })).toBe(false);
    await frame.click("a");
    await page.waitForFunction(() => document.querySelector('[data-page="1"]')?.hasAttribute("disabled"));
    frame = page.frames().find((f: any) => f.parentFrame()); await frame.waitForSelector("h1");
    expect(await frame.$eval("h1", (el: Element) => el.textContent)).toBe("原型第二页");
    await page.screenshot({ path: path.join(root, "prototype-proof.png") });
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);

it("keeps a tall slide footer in the PNG used by contain-fit video scenes",async()=>{
 const source={...document,pages:[{id:"one",title:"Tall slide",html:'<style>html,body{width:1280px;min-height:720px;margin:0}main{height:1000px;position:relative;background:white}footer{position:absolute;bottom:0;width:100%;height:80px;background:rgb(224,83,61)}</style><main>Long slide<footer>Footer remains visible</footer></main>'}]};
 const result=await createDesignExporter({outputDir:root}).run({document:source,format:"png"}),bytes=await fs.readFile(result.path);
 expect(bytes.readUInt32BE(16)).toBe(1280);expect(bytes.readUInt32BE(20)).toBe(1000);
 const browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});
 try{
  const page=await browser.newPage();
  const pixel=await page.evaluate(async(src:string)=>{const img=new Image();img.src=src;await img.decode();const canvas=document.createElement("canvas");canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext("2d")!;ctx.drawImage(img,0,0);return [...ctx.getImageData(600,950,1,1).data];},`data:image/png;base64,${bytes.toString("base64")}`);
  expect(pixel).toEqual([224,83,61,255]);
 }finally{await browser.close();}
},30000);
