import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
let available = false; try { findSystemBrowser(); available = true; } catch { /* gated */ }

// Sign-off acceptance for matrix items 6/8/27 (36-item design matrix): the mobile
// prototype viewport, the HTML import isolation, and the compare/adopt flows —
// all through the real DesignEditor in Chromium.

const site = (projectId: string, documents: unknown[]) => ({ version: 1, projectId, activeId: documents[0] && (documents[0] as { id: string }).id, documents });
const page = (id: string, title: string, html: string) => ({ id, title, html: `<!doctype html><html><head><style>body{margin:0;background:white;font:24px sans-serif;padding:40px}</style></head><body><h1 data-design-id="h">${html}</h1></body></html>` });
const harness = (projectId: string, state: unknown) => `
import React from'react';import{createRoot}from'react-dom/client';import{DesignEditor}from'./DesignEditor';import'./app-theme.css';
if(!localStorage.getItem('glint.project-designs.v1:${projectId}'))localStorage.setItem('glint.project-designs.v1:${projectId}',${JSON.stringify(JSON.stringify(state))});
createRoot(document.getElementById('app')).render(<DesignEditor projectId="${projectId}"/>);`;

async function launchEditor(contents: string) {
  const bundle = await build({ stdin: { contents, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", outdir: "harness" });
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles.find(f => f.path.endsWith(".js"))!.text);
    if (req.url === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end(bundle.outputFiles.find(f => f.path.endsWith(".css"))!.text);
    // Only the planted probe paths count as egress; /favicon.ico and the root
    // document are browser noise, not requests from the sandboxed page.
    if ((req.url ?? "").includes("egress-probe") || (req.url ?? "").includes("/external")) requests++;
    res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end('<link rel="stylesheet" href="/app.css"><div id="app"></div><script src="/app.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
  const ui = await browser.newPage(); await ui.setViewport({ width: 1440, height: 960 }); await ui.goto(origin, { waitUntil: "networkidle0" });
  await ui.waitForSelector('[aria-label="设计文档编辑器"]');
  const stored = () => ui.evaluate((id: string) => JSON.parse(localStorage.getItem(`glint.project-designs.v1:${id}`)!), contents.match(/projectId="([^"]+)"/)![1]) as Promise<{ documents: Array<{ id: string; title: string; pages: Array<{ id: string }>; }> }>;
  const close = async () => { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { ui, requests: () => requests, stored, close };
}

it.skipIf(!available || process.env.GLINT_BROWSER_UI_TEST !== "1")("item 6: prototype editor switches to the 390x844 mobile viewport and back", async () => {
  const doc = { id: "app", title: "手机应用", kind: "prototype", activePageId: "one", updatedAt: 0, pages: [page("one", "首页", "移动端首屏")] };
  const editor = await launchEditor(harness("signoff-mobile", site("signoff-mobile", [doc])));
  try {
    const select = await editor.ui.waitForSelector('[aria-label="响应式预览尺寸"]');
    await select!.select("mobile");
    await editor.ui.waitForFunction(() => document.querySelector(".design-preview-caption")?.textContent?.includes("手机 · 390 × 844"));
    // The preview iframe itself is sized 390 CSS px (scaled to fit, not resized).
    expect(await editor.ui.evaluate(() => (document.querySelector('iframe[title="设计预览"]') as HTMLIFrameElement).style.width)).toBe("390px");
    await select!.select("desktop");
    await editor.ui.waitForFunction(() => document.querySelector(".design-preview-caption")?.textContent?.includes("桌面 · 1280 × 800"));
    expect(await editor.ui.evaluate(() => (document.querySelector('iframe[title="设计预览"]') as HTMLIFrameElement).style.width)).toBe("1280px");
  } finally { await editor.close(); }
}, 90_000);

it.skipIf(!available || process.env.GLINT_BROWSER_UI_TEST !== "1")("item 8: imported HTML becomes a page, scripts run sandboxed and egress never leaves", async () => {
  const doc = { id: "site", title: "落地页", kind: "page", activePageId: "one", updatedAt: 0, pages: [page("one", "原页", "原始页面")] };
  const editor = await launchEditor(harness("signoff-import", site("signoff-import", [doc])));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-import-"));
  try {
    const imported = path.join(dir, "外部来源.html");
    fs.writeFileSync(imported, `<!doctype html><html><head><style>h1{color:purple}</style></head><body><h1 data-design-id="imported">外部网页正文</h1>
<script>document.body.setAttribute('data-import-script-ran','yes');fetch('/egress-probe').catch(function(){});</script>
<a href="http://127.0.0.1:1/external">外链</a></body></html>`);
    const input = await editor.ui.waitForSelector('input[aria-label="导入本地 HTML"]');
    await input!.uploadFile(imported);
    await editor.ui.waitForFunction(() => document.body.textContent?.includes("HTML 已作为新页导入"));
    // Persistence debounces 650ms; wait for the write, not the notice.
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-import")!).documents[0].pages.length === count, { timeout: 8000 }, 2);
    const state = await editor.stored();
    expect(state.documents[0]!.pages).toHaveLength(2);
    // The rail names imported pages without the file extension.
    expect(state.documents[0]!.pages[1]!.title).toBe("外部来源");
    expect(state.documents[0]!.pages[1]!.html).toContain("外部网页正文");
    // The imported source is stored verbatim; user HTML is never rewritten.
    expect(state.documents[0]!.pages[1]!.html).toContain("<script>");
    // The script really executes inside the isolated preview (opaque origin), but
    // its network probe must never reach any server (connect-src 'none').
    await editor.ui.waitForFunction(() => {
      const frame = document.querySelector('iframe[title="设计预览"]') as HTMLIFrameElement | null;
      return frame !== null;
    });
    const inner = async () => {
      for (const frame of editor.ui.frames()) {
        try { if (await frame.evaluate(() => Boolean(document.querySelector('iframe[title="设计页面内容"]')))) return frame; } catch { /* navigating */ }
      }
      throw new Error("outer preview frame not found");
    };
    const outer = await inner();
    await outer.waitForSelector('iframe[title="设计页面内容"]');
    let ran: string | null = null;
    for (let attempt = 0; attempt < 40 && ran === null; attempt++) {
      for (const frame of editor.ui.frames()) {
        const value = await frame.evaluate(() => document.body?.getAttribute("data-import-script-ran") ?? null).catch(() => null);
        if (value) { ran = value; break; }
      }
      if (ran === null) await new Promise(resolve => setTimeout(resolve, 250));
    }
    // The imported inline script really executed inside the opaque sandbox.
    expect(ran).toBe("yes");
    expect(editor.requests()).toBe(0);
    // The external link cannot navigate the sandbox either.
    const sandboxFrames = [];
    for (const frame of editor.ui.frames()) {
      if (await frame.evaluate(() => Boolean(document.querySelector('a[href^="http"]'))).catch(() => false)) sandboxFrames.push(frame);
    }
    await sandboxFrames[sandboxFrames.length - 1]!.evaluate(() => { (document.querySelector('a[href^="http"]') as HTMLAnchorElement).click(); });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(editor.requests()).toBe(0);
    // One undo removes the imported page entirely.
    await editor.ui.evaluate(() => { const b = [...document.querySelectorAll(".design-toolbar button")].find(x => x.textContent === "撤销") as HTMLButtonElement; b.click(); });
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-import")!).documents[0].pages.length === count, { timeout: 8000 }, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); await editor.close(); }
}, 120_000);

it.skipIf(!available || process.env.GLINT_BROWSER_UI_TEST !== "1")("item 27: compare grid shows every direction, adoption switches and duplicates persist", async () => {
  const first = { id: "alpha", title: "方向甲", kind: "page", activePageId: "one", updatedAt: 0, pages: [page("one", "甲页", "方向甲正文")] };
  const second = { id: "beta", title: "方向乙", kind: "page", activePageId: "one", updatedAt: 0, pages: [page("one", "乙页", "方向乙正文")] };
  const editor = await launchEditor(harness("signoff-compare", site("signoff-compare", [first, second])));
  try {
    await editor.ui.click(".design-compare-toggle");
    const grid = await editor.ui.waitForSelector('[aria-label="方案比较"]');
    const cards = await grid!.$$(".design-compare-card");
    expect(cards).toHaveLength(2);
    // Both directions render live thumbnails in the compare grid.
    await editor.ui.waitForFunction(() => document.querySelectorAll('[aria-label="方案比较"] iframe').length >= 2);
    expect((await editor.stored()).documents).toHaveLength(2);
    // Adopting the non-active direction switches activeId and closes the compare view.
    await editor.ui.evaluate(() => { const card = [...document.querySelectorAll(".design-compare-card")].find(node => node.getAttribute("data-active") !== "true")!; [...card.querySelectorAll("button")].find(b => b.textContent === "继续这个方向")!.click(); });
    await editor.ui.waitForFunction(() => document.body.textContent?.includes("已切换到该方向"));
    await editor.ui.waitForFunction(() => !document.querySelector('[aria-label="方案比较"]'));
    // The debounce persists a moment later; wait for the write.
    await editor.ui.waitForFunction(() => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-compare")!).activeId === "beta", { timeout: 8000 });
    // Re-open compare, duplicate the adopted direction; the list grows and persists through a reload.
    await editor.ui.click(".design-compare-toggle");
    await editor.ui.waitForSelector('[aria-label="方案比较"]');
    await editor.ui.evaluate(() => { const card = [...document.querySelectorAll(".design-compare-card")].find(node => node.getAttribute("data-active") === "true")!; [...card.querySelectorAll("button")].find(b => b.textContent === "复制成新方向")!.click(); });
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-compare")!).documents.length === count, { timeout: 8000 }, 3);
    await editor.ui.reload({ waitUntil: "networkidle0" });
    await editor.ui.waitForSelector('[aria-label="设计文档编辑器"]');
    expect((await editor.stored()).documents).toHaveLength(3);
  } finally { await editor.close(); }
}, 120_000);

it.skipIf(!available || process.env.GLINT_BROWSER_UI_TEST !== "1")("item 25: the page rail adds, duplicates, reorders and deletes pages with undo", async () => {
  const doc = { id: "site", title: "多页站点", kind: "page", activePageId: "one", updatedAt: 0, pages: [page("one", "第一页", "第一页正文"), page("two", "第二页", "第二页正文")] };
  const editor = await launchEditor(harness("signoff-pages", site("signoff-pages", [doc])));
  try {
    const titles = () => editor.ui.evaluate(() => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-pages")!).documents[0].pages.map((entry: { title: string }) => entry.title)) as Promise<string[]>;
    // Add: a blank page joins after the active page and becomes active.
    await (await editor.ui.waitForSelector('[aria-label="设计页面列表"]'))!;
    await editor.ui.evaluate(() => { [...document.querySelectorAll(".design-page-tools button")].find(b => b.textContent === "新增页")!.click(); });
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-pages")!).documents[0].pages.length === count, { timeout: 8000 }, 3);
    // A new page joins right after the ACTIVE page, not at the end.
    expect(await titles()).toEqual(["第一页", "新页面 3", "第二页"]);
    // Duplicate the active page; its title carries 副本.
    await editor.ui.evaluate(() => { [...document.querySelectorAll(".design-page-tools button")].find(b => b.textContent === "复制页")!.click(); });
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-pages")!).documents[0].pages.length === count, { timeout: 8000 }, 4);
    expect((await titles())[2]).toContain("副本");
    // Reorder: move the duplicate up and verify the persisted order.
    await editor.ui.evaluate(() => { [...document.querySelectorAll(".design-page-tools button")].find(b => b.textContent === "上移")!.click(); });
    await editor.ui.waitForFunction((order: string[]) => { const titles = JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-pages")!).documents[0].pages.map((entry: { title: string }) => entry.title); return JSON.stringify(titles) === JSON.stringify(order); }, { timeout: 8000 }, ["第一页", "新页面 3 副本", "新页面 3", "第二页"]);
    // Delete the still-active duplicate with its confirmation step, then undo restores it.
    await editor.ui.evaluate(() => { [...document.querySelectorAll(".design-page-tools button")].find(b => b.textContent === "删除页")!.click(); });
    await (await editor.ui.waitForSelector('[aria-label="确认删除页面"]'))!;
    await editor.ui.evaluate(() => { [...document.querySelectorAll('[aria-label="确认删除页面"] button')].find(b => b.textContent === "确认删除页")!.click(); });
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-pages")!).documents[0].pages.length === count, { timeout: 8000 }, 3);
    await editor.ui.evaluate(() => { const b = [...document.querySelectorAll(".design-toolbar button")].find(x => x.textContent === "撤销") as HTMLButtonElement; b.click(); });
    await editor.ui.waitForFunction((count: number) => JSON.parse(localStorage.getItem("glint.project-designs.v1:signoff-pages")!).documents[0].pages.length === count, { timeout: 8000 }, 4);
  } finally { await editor.close(); }
}, 120_000);
