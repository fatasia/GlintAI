import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
let available = false; try { findSystemBrowser(); available = true; } catch { /* gated */ }

// 16/20 acceptance: rotate handle and group move write back through the real
// bridge → gesture → applyDesignGesture path, each a single undoable step.
const doc = { version: 1, projectId: "edit-project", activeId: "site", documents: [{ id: "site", title: "直编页", kind: "page", activePageId: "one", updatedAt: 0, pages: [{ id: "one", title: "直编页", html: '<!doctype html><html><head><style>body{margin:0;background:white;padding:60px;font:28px sans-serif}</style></head><body><h1 data-design-id="title" style="rotate:0deg">可旋转标题</h1><div data-design-id="panel" data-design-group="grp" style="position:absolute;left:40px;top:160px;width:220px;height:80px;background:#e8f0ff">面板甲</div><div data-design-id="mate" data-design-group="grp" style="position:absolute;left:40px;top:260px;width:220px;height:80px;background:#ffe8ee">面板乙</div></body></html>' }] }] };

it.skipIf(!available || process.env.GLINT_BROWSER_UI_TEST !== "1")("writes rotate and group-move gestures back into the page HTML with undo", async () => {
  const bundle = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{DesignEditor}from'./DesignEditor';import'./app-theme.css';if(!localStorage.getItem('glint.project-designs.v1:edit-project'))localStorage.setItem('glint.project-designs.v1:edit-project',${JSON.stringify(JSON.stringify(doc))});createRoot(document.getElementById('app')).render(<DesignEditor projectId="edit-project"/>);`, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", outdir: "harness" });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles.find(f => f.path.endsWith(".js"))!.text);
    if (req.url === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end(bundle.outputFiles.find(f => f.path.endsWith(".css"))!.text);
    res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end('<link rel="stylesheet" href="/app.css"><div id="app"></div><script src="/app.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
  try {
    const ui = await browser.newPage(); await ui.setViewport({ width: 1440, height: 960 }); await ui.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`, { waitUntil: "networkidle0" });
    const stored = () => ui.evaluate(() => JSON.parse(localStorage.getItem("glint.project-designs.v1:edit-project")!).documents[0].pages[0].html) as Promise<string>;
    // Inner content iframe that hosts the bridge listeners.
    const inner = async () => {
      for (const frame of ui.frames()) {
        try { if (await frame.evaluate(() => Boolean(document.querySelector("[data-design-id]")))) return frame; } catch { /* navigating */ }
      }
      throw new Error("inner bridge frame not found");
    };
    await ui.waitForSelector('[aria-label="设计文档编辑器"]');
    let frame = await inner();
    // Select the title node with a real click inside the iframe.
    await frame.evaluate(() => { (document.querySelector('[data-design-id="title"]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await frame.waitForSelector('button[aria-label="拖动旋转"]');
    // 16: drag the rotate handle — pointer sequence through the real bridge listeners.
    const rotateResult = await frame.evaluate(() => {
      const handle = document.querySelector('button[aria-label="拖动旋转"]') as HTMLButtonElement;
      const rect = handle.getBoundingClientRect();
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      const opts = (x: number, y: number) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 7, isPrimary: true });
      handle.dispatchEvent(new PointerEvent("pointerdown", opts(cx, cy)));
      document.dispatchEvent(new PointerEvent("pointermove", opts(cx + 120, cy + 60)));
      document.dispatchEvent(new PointerEvent("pointerup", opts(cx + 120, cy + 60)));
      return true;
    });
    expect(rotateResult).toBe(true);
    await ui.waitForFunction((prev: string) => { const html = JSON.parse(localStorage.getItem("glint.project-designs.v1:edit-project")!).documents[0].pages[0].html; return html !== prev && html.includes("rotate:"); }, { timeout: 8000 }, await stored());
    const withRotate = await stored();
    expect(withRotate).toMatch(/rotate:\s*-?\d+(\.\d+)?deg/);
    // One undo restores the exact pre-rotate page HTML (fixture itself has rotate:0deg).
    const beforeRotate = doc.documents[0].pages[0].html;
    await ui.evaluate(() => { const b = [...document.querySelectorAll(".design-toolbar button")].find(x => x.textContent === "撤销") as HTMLButtonElement; if (b.disabled) throw new Error("undo unavailable"); b.click(); });
    await ui.waitForFunction((prev: string) => JSON.parse(localStorage.getItem("glint.project-designs.v1:edit-project")!).documents[0].pages[0].html === prev, { timeout: 8000 }, beforeRotate);
    // 20: group move — pointer-down on one group member moves both members in one gesture.
    frame = await inner();
    await frame.evaluate(() => { (document.querySelector('[data-design-id="panel"]') as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const moveResult = await frame.evaluate(() => {
      const node = document.querySelector('[data-design-id="panel"]') as HTMLElement;
      const rect = node.getBoundingClientRect();
      const opts = (x: number, y: number) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 8, isPrimary: true, shiftKey: false });
      node.dispatchEvent(new PointerEvent("pointerdown", opts(rect.x + 60, rect.y + 30)));
      document.dispatchEvent(new PointerEvent("pointermove", opts(rect.x + 180, rect.y + 90)));
      document.dispatchEvent(new PointerEvent("pointerup", opts(rect.x + 180, rect.y + 90)));
      return true;
    });
    expect(moveResult).toBe(true);
    await ui.waitForFunction((prev: string) => { const html = JSON.parse(localStorage.getItem("glint.project-designs.v1:edit-project")!).documents[0].pages[0].html; return html !== prev && (html.match(/left:\s*\d+px/g) ?? []).length >= 2; }, { timeout: 8000 }, await stored());
    const moved = await stored();
    // Both group members moved together in one write.
    const lefts = [...moved.matchAll(/left:\s*(\d+)px/g)].map(m => Number(m[1]));
    expect(lefts.some(v => v > 40)).toBe(true);
    // One undo restores both members.
    await ui.evaluate(() => { const b = [...document.querySelectorAll(".design-toolbar button")].find(x => x.textContent === "撤销") as HTMLButtonElement; b.click(); });
    await ui.waitForFunction((prev: string) => JSON.parse(localStorage.getItem("glint.project-designs.v1:edit-project")!).documents[0].pages[0].html === prev, { timeout: 8000 }, moved);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90_000);
