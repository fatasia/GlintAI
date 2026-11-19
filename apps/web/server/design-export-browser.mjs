import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host.ts";
import { checkDesignAbort, designError } from "./design-export-contract.mjs";
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
export const DESIGN_VIEWPORT = { width: 1280, height: 720 };

// This function executes only inside a script-disabled, opaque-origin static iframe.
function readLayout() {
  const items = [], complex = [], root = document.documentElement;
  const color = value => { const m = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/); return m ? { hex: m.slice(1, 4).map(v => Number(v).toString(16).padStart(2, "0")).join(""), alpha: m[4] === undefined ? 1 : Number(m[4]) } : null; };
  let index = 0;
  for (const element of document.querySelectorAll("body,body *")) {
    const css = getComputedStyle(element), rect = element.getBoundingClientRect(), id = `export-${index++}`;
    if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0 || !rect.width || !rect.height || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName) || element.parentElement?.closest("[data-export-complex]")) continue;
    element.setAttribute("data-export-element", id);
    const box = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    const opacity = Number(css.opacity), fill = color(css.backgroundColor), line = color(css.borderTopColor);
    const unsupported = css.backgroundImage !== "none" || css.boxShadow !== "none" || css.filter !== "none" || css.transform !== "none" || ["SVG", "CANVAS", "VIDEO"].includes(element.tagName.toUpperCase());
    if (unsupported) {
      const backgroundOnly = ["BODY", "HTML"].includes(element.tagName);
      complex.push({ ...box, id, backgroundOnly }); items.push({ ...box, id, type: "complex" });
      if (!backgroundOnly) { element.setAttribute("data-export-complex", ""); continue; }
    }
    if (!unsupported && (fill?.alpha || (line?.alpha && parseFloat(css.borderTopWidth))) && rect.width > 1 && rect.height > 1) items.push({ ...box, type: "shape", fill, line, lineWidth: parseFloat(css.borderTopWidth), radius: parseFloat(css.borderTopLeftRadius), opacity });
    if (element.tagName === "IMG" && element.src.startsWith("data:image/")) items.push({ ...box, type: "image", data: element.src, opacity });
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node); const bounds = range.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      items.push({ type: "text", x: bounds.x, y: bounds.y, w: bounds.width + 3, h: bounds.height + 3, text: node.textContent.replace(/\s+/g, " ").trim(), color: color(css.color), fontSize: parseFloat(css.fontSize), fontFace: css.fontFamily.split(",")[0].replace(/["']/g, ""), bold: Number(css.fontWeight) >= 600 || css.fontWeight === "bold", italic: css.fontStyle === "italic", align: css.textAlign, opacity });
    }
  }
  return { width: Math.max(1280, root.scrollWidth), height: Math.max(720, root.scrollHeight), items, complex };
}
export async function captureDesign(prepared, document, format, { signal } = {}) {
  checkDesignAbort(signal);
  const token = randomUUID(), pages = prepared.pages, prefix = `/${token}/`;
  const host = `<!doctype html><html><head><style>*{box-sizing:border-box}html,body{margin:0;background:white}section{width:1280px;height:720px;overflow:hidden;break-after:page;position:relative}section:last-child{break-after:auto}iframe{border:0;width:1280px;height:720px;transform-origin:top left}@page{size:1280px 720px;margin:0}</style></head><body>${pages.map((_, i) => `<section><iframe sandbox="" src="${prefix}${i}" title="静态设计页"></iframe></section>`).join("")}</body></html>`;
  const server = createServer((req, res) => {
    const index = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : "";
    const content = index === "host" ? host : /^\d+$/.test(index) ? pages[Number(index)]?.staticHtml : undefined;
    if (req.method !== "GET" || content === undefined) { res.writeHead(404).end(); return; }
    const policy = index === "host" ? "default-src 'none';frame-src 'self';style-src 'unsafe-inline';script-src 'none';base-uri 'none'" : "default-src 'none';img-src data:;font-src data:;style-src 'unsafe-inline';script-src 'none';connect-src 'none';frame-src 'none';object-src 'none';base-uri 'none';form-action 'none'";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": policy, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(content);
  });
  let browser, profile;
  const abort = () => { if (browser) void browser.close().catch(() => {}); };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "glint-design-browser-"));
    browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true, userDataDir: profile, timeout: 20_000, protocolTimeout: 30_000, args: ["--disable-background-networking", "--disable-component-update", "--disable-extensions", "--no-first-run"] });
    signal?.addEventListener("abort", abort, { once: true }); checkDesignAbort(signal);
    const page = await browser.newPage();
    await page.setViewport({ ...DESIGN_VIEWPORT, deviceScaleFactor: 1 });
    await page.setBypassServiceWorker(true); await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      const allowed = url === `${origin}${prefix}host` || pages.some((_, i) => url === `${origin}${prefix}${i}`) || /^data:image\/(png|jpeg|webp);base64,/i.test(url);
      void (allowed ? request.continue() : request.abort("blockedbyclient")).catch(() => {});
    });
    await page.goto(`${origin}${prefix}host`, { waitUntil: "networkidle0", timeout: 30_000 });
    const layouts = [];
    for (let i = 0; i < pages.length; i++) {
      checkDesignAbort(signal);
      const frame = page.frames().find(frame => frame.url() === `${origin}${prefix}${i}`);
      if (!frame) throw designError("静态设计沙箱未就绪，请检查页面后重试。", 422);
      await frame.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
      const layout = await frame.evaluate(readLayout);
      if (!layout.items.length && !layout.complex.length) throw designError(`页面“${pages[i].title}”在静态捕获中为空白；请将脚本生成内容改为静态 HTML 后导出。`, 422);
      if (layout.width > DESIGN_VIEWPORT.width) throw designError(`页面“${pages[i].title}”横向超出 1280px 画布，请修正横向溢出或缩小布局后导出。`, 422);
      if (layout.height > 8192 || layout.items.length > 8000 || layout.complex.length > 100) throw designError("页面布局过大或复杂元素过多，请拆分页后导出。", 413);
      if (layout.height > DESIGN_VIEWPORT.height && ["pdf", "pptx"].includes(format)) prepared.warnings.add(`页面“${pages[i].title}”超过 720px，已等比缩小以保持每页一个画面。`);
      await page.evaluate(({ i, height }) => { document.querySelectorAll("iframe")[i].style.height = `${height}px`; }, { i, height: layout.height });
      if (format === "pptx") {
        for (const complex of layout.complex) {
          const element = await frame.$(`[data-export-element="${complex.id}"]`);
          if (!element) continue;
          if (complex.backgroundOnly) await frame.evaluate(() => { const style = document.createElement("style"); style.id = "export-background-only"; style.textContent = "body>*{visibility:hidden!important}body{color:transparent!important}"; document.head.append(style); });
          const png = await element.screenshot({ type: "png" });
          if (complex.backgroundOnly) await frame.evaluate(() => document.getElementById("export-background-only")?.remove());
          layout.items = layout.items.map(item => item.type === "complex" && item.id === complex.id ? { ...complex, type: "raster", data: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } : item);
          prepared.warnings.add(`页面“${pages[i].title}”的复杂 CSS/SVG/画布已局部栅格化，该区域不可编辑。`);
        }
      }
      layouts.push(layout);
    }
    let buffer;
    if (format === "png") {
      const index = pages.findIndex(p => p.id === document.activePageId), height = layouts[index].height;
      await page.evaluate(({ index, height }) => { document.querySelectorAll("section").forEach((section, i) => { section.style.display = i === index ? "block" : "none"; section.style.height = `${height}px`; }); }, { index, height });
      buffer = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: DESIGN_VIEWPORT.width, height }, captureBeyondViewport: true }));
      if (pages.length > 1) prepared.warnings.add("PNG 仅导出当前页面；全部页面请使用 PDF 或 PPTX。");
    } else if (format === "pdf") {
      await page.evaluate(heights => { document.querySelectorAll("iframe").forEach((frame, i) => { const scale = Math.min(1, 720 / heights[i]); frame.style.transform = `scale(${scale})`; }); }, layouts.map(layout => layout.height));
      buffer = Buffer.from(await page.pdf({ printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, timeout: 30_000 }));
    }
    return { buffer, layouts };
  } catch (error) {
    checkDesignAbort(signal);
    if (error.status) throw error;
    throw designError(`本地静态设计捕获失败：${error.message?.slice(0, 240)}。请安装 Chrome/Edge 或检查页面布局后重试。`, 422);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}
