import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { runMediaProcess } from "../../studio/scripts/native-process";
import { createRequire } from "node:module";
const studioRequire = createRequire(new URL("../../studio/package.json", import.meta.url));
const { build } = studioRequire("esbuild") as { build: typeof import("esbuild").build };
// @ts-expect-error JavaScript server exercised through HTTP; env must be set before this import.
const loadServer = async () => (await import("./index.mjs")).createWebServer as (options: Record<string, unknown>) => Server;
import { createMediaJobs } from "./media-jobs.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("paints a mask, quotes, approves, adopts the masked candidate and restores with undo through the real pipeline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-mask-browser-"));
  const library = path.join(root, "media"); fs.mkdirSync(library);
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir, { recursive: true });
  process.env.GLINT_DATA_DIR = dataDir;

  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined, server: Server | undefined;
  try {
    const red = path.join(root, "red.png"), blue = path.join(root, "blue.png");
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=1", "-frames:v", "1", "-threads", "1", red]);
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=1", "-frames:v", "1", "-threads", "1", blue]);
    const redBytes = fs.readFileSync(red);
    let failing = false, currentTask = "mask-task-1";
    const client = {
      models: vi.fn(async () => [{ id: "fixture-model", name: "Fixture Image", tags: ["图生图", "参考图"] }]),
      pricing: vi.fn(async () => ({ channel_groups: [{ is_active: true, billing_method: "按次", base_price: 0.01 }] })),
      submit: vi.fn(async () => { currentTask = failing ? "mask-task-2" : "mask-task-1"; return currentTask; }),
      status: vi.fn(async () => currentTask === "mask-task-2" && failing
        ? { task_id: currentTask, state: "failed", is_final: true, cost: 0.01 }
        : { task_id: currentTask, state: "success", is_final: true, cost: 0.01, result_url: "https://mock.invalid/out.png" }),
    };
    process.env.GLINT_MEDIA_BASE_URL = "https://mock.invalid"; process.env.GLINT_MEDIA_API_KEY = "test";
    const jobs = createMediaJobs(library, { GLINT_MEDIA_BASE_URL: "https://mock.invalid", GLINT_MEDIA_API_KEY: "test" }, { client, download: async () => ({ contentType: "image/png", bytes: fs.readFileSync(blue) }) });
    const redDataUrl = `data:image/png;base64,${redBytes.toString("base64")}`;
    const pageHtml = `<!doctype html><html><head><style>body{margin:0;background:white;padding:40px;font:24px sans-serif}</style></head><body><h1 data-design-id="head">掩膜演示</h1><img data-design-id="hero" src="${redDataUrl}" alt="页面图片"></body></html>`;
    const doc = { version: 1, projectId: "mask-project", activeId: "site", documents: [{ id: "site", title: "掩膜页", kind: "page", activePageId: "one", updatedAt: 0, pages: [{ id: "one", title: "掩膜页", html: pageHtml }] }] };
    // The server caches index.html at startup: the harness entry files must exist before it starts.
    const distDir = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
    const bundle = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{DesignEditor}from'./DesignEditor';import'./app-theme.css';if(!localStorage.getItem('glint.project-designs.v1:mask-project'))localStorage.setItem('glint.project-designs.v1:mask-project',${JSON.stringify(JSON.stringify(doc))});createRoot(document.getElementById('app')).render(<DesignEditor projectId="mask-project"/>);`, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", outdir: "harness" });
    for (const file of bundle.outputFiles) {
      const name = file.path.endsWith(".css") ? "harness.css" : "harness.js";
      fs.writeFileSync(path.join(distDir, name), file.text);
    }
    const appCss = bundle.outputFiles.find(file => file.path.endsWith(".css"));
    fs.writeFileSync(path.join(distDir, "index.html"), `<!doctype html><html lang="zh"><head><meta charset="utf-8">${appCss ? '<link rel="stylesheet" href="/harness.css">' : ""}<title>mask harness</title></head><body><div id="app"></div><script src="/harness.js"></script></body></html>`);
    // Precompressed variants of the shipped index would shadow the harness entry.
    for (const variant of ["index.html.br", "index.html.gz"]) fs.rmSync(path.join(distDir, variant), { force: true });
    const createServer = await loadServer();
    server = createServer({ distDir, mediaJobs: jobs, requestLogDir: path.join(root, "logs") }) as Server;
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registry = await (await fetch(base + "/api/settings/model-registry")).json();
    const saved = await fetch(base + "/api/settings/model-registry", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ registry: { models: [{ id: "host-fixture", name: "Fixture Image", provider: "fixture", kind: "image", capabilities: ["reference-image"], pricing: { basis: "per-call", amountCny: 0.01 }, adapter: { type: "skills-gateway", model: "fixture-model" }, source: "user" }] }, baseDigest: registry.digest }) });
    const bound = await fetch(base + "/api/media/execution/bindings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "fixture-binding", modelId: "host-fixture", accountId: "gateway" }) });
    if (saved.status !== 200) throw new Error(`registry PUT ${saved.status}: ${await saved.text()}`);
    if (bound.status !== 200) throw new Error(`bindings POST ${bound.status}: ${await bound.text()}`);
    opened = await openCaptureBrowser(1440, 960);
    const ui = opened.page;
    await ui.goto(base, { waitUntil: "networkidle0" });
    // AC1: selecting the image layer offers both entries with distinct explanations.
    // Headless actionability flake: arm-then-evaluate-click beats locator stability waits.
    const clickText = async (text: string) => {
      await ui.waitForFunction((t: string) => { const b = [...document.querySelectorAll("button")].find(x => x.textContent === t); return Boolean(b && !(b as HTMLButtonElement).disabled); }, { timeout: 20000 }, text).catch(() => { throw new Error(`clickText('${text}') never armed`); });
      await ui.evaluate((t: string) => { const b = [...document.querySelectorAll("button")].find(x => x.textContent === t) as HTMLButtonElement; b.click(); }, text);
    };
    const bootErrors: string[] = [];
    ui.on("pageerror", error => bootErrors.push(String(error)));
    try { await ui.waitForSelector("button::-p-text(属性)", { timeout: 10000 }); }
    catch {
      const app = await ui.evaluate(() => document.getElementById("app")?.innerHTML.slice(0, 200) ?? "empty");
      throw new Error(`editor did not boot; app=${JSON.stringify(app)} pageErrors=${JSON.stringify(bootErrors)}`);
    }
    await clickText("属性");
    try { await ui.waitForSelector('[data-design-layer="hero"] input[type="checkbox"]', { timeout: 8000 }); }
    catch {
      const layers = await ui.evaluate(() => [...document.querySelectorAll("[data-design-layer]")].map(n => n.getAttribute("data-design-layer")));
      const selected = await ui.evaluate(() => [...document.querySelectorAll("button")].filter(b => b.textContent?.includes("选中")).map(b => b.textContent));
      throw new Error(`hero layer missing; layers=${JSON.stringify(layers)} selectedButtons=${JSON.stringify(selected)}`);
    }
    await ui.locator('[data-design-layer="hero"] input[type="checkbox"]').click();
    await ui.waitForSelector("button::-p-text(局部修改（掩膜）)", { timeout: 8000 });
    expect((await ui.$$("button::-p-text(整图重生)")).length).toBeGreaterThan(0);
    expect(await ui.evaluate(() => document.body.textContent!.includes("其余像素保持不变") && document.body.textContent!.includes("重新生成整张图片"))).toBe(true);
    // AC2: brush tools, per-stroke undo, empty mask cannot reach a quote.
    await clickText("局部修改（掩膜）");
    await ui.waitForSelector('[aria-label="局部修改（掩膜）"]');
    await ui.waitForFunction(() => !document.querySelector('[aria-label="局部修改（掩膜）"]')?.textContent?.includes("正在读取原图"), { timeout: 15000 });
    const brushButtons = await ui.$$eval('[aria-label="笔刷大小"] button', nodes => nodes.map(node => (node as HTMLButtonElement).textContent));
    expect(brushButtons).toEqual(["8px", "24px", "48px", "橡皮", "撤销笔画", "清空"]);
    expect(await ui.$eval('[aria-label="掩膜画布"]', canvas => (canvas as HTMLCanvasElement).width)).toBe(64);
    const undo = await ui.$('button::-p-text(撤销笔画)');
    const undoDisabled = () => undo!.evaluate(element => (element as HTMLButtonElement).disabled);
    expect(await undoDisabled()).toBe(true);
    const canvasBox = await (await ui.$('[aria-label="掩膜画布"]'))!.boundingBox();
    const paintStroke = async () => {
      await ui.mouse.move(canvasBox!.x + canvasBox!.width * 0.4, canvasBox!.y + canvasBox!.height * 0.4);
      await ui.mouse.down();
      await ui.mouse.move(canvasBox!.x + canvasBox!.width * 0.6, canvasBox!.y + canvasBox!.height * 0.6, { steps: 6 });
      await ui.mouse.up();
    };
    await paintStroke();
    expect(await undoDisabled()).toBe(false);
    await undo!.click(); expect(await undoDisabled()).toBe(true);
    // Fast pointer sequences can lose a stroke in headless; repaint until the mask holds one.
    await paintStroke();
    for (let attempt = 0; await undoDisabled() && attempt < 3; attempt++) await paintStroke();
    if (await undoDisabled()) throw new Error("mask stroke never registered");
    // AC3+AC4: quote, cap confirm, submit, success download, masked comparison, adopt, undo restore.
    await ui.type('[aria-label="修改描述"]', "把中间区域换成蓝色");
    // The bindings fetch lands asynchronously; wait for the quote button to arm itself.
    await ui.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent === "获取报价"); return Boolean(b && !(b as HTMLButtonElement).disabled); }, { timeout: 15000 }).catch(async () => {
      const why = await ui.evaluate(async () => { const prompt = document.querySelector('[aria-label="修改描述"]') as HTMLTextAreaElement | null; const sel = document.querySelector('[aria-label="模型绑定"]') as HTMLSelectElement | null; const buttons = [...document.querySelectorAll("button")].filter(x => x.textContent === "获取报价"); const raw = await (await fetch("/api/media/execution/bindings")).json(); return { count: buttons.length, disabled: buttons.map(b => b.disabled), prompt: prompt?.value ?? null, binding: sel?.value ?? null, options: sel ? [...sel.options].map(o => o.value) : null, raw }; });
      throw new Error(`quote button never armed: ${JSON.stringify(why)}`);
    });
    const quoteBtn = await ui.$('button::-p-text(获取报价)');
    await quoteBtn!.click();
    await ui.waitForSelector('[aria-label="费用确认"]');
    expect(await ui.evaluate(() => document.querySelector('[aria-label="费用确认"]')?.textContent?.includes("0.0100"))).toBe(true);
    expect(await ui.$eval('[aria-label="费用上限"]', element => (element as HTMLInputElement).value)).toBe("0.01");
    await ui.click('[aria-label="确认费用"]');
    await ui.locator("button::-p-text(批准并提交)").click();
    try { await ui.waitForSelector('[aria-label="候选对比"]', { timeout: 20000 }); }
    catch { const alerts = await ui.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent)); throw new Error(`compare never appeared; alerts=${JSON.stringify(alerts)}`); }
    const stats = await ui.evaluate(() => document.querySelector('[aria-label="候选对比"] small')?.textContent ?? "");
    expect(stats).toContain("掩膜外 0 /");
    // ffmpeg YUV conversion shifts absolute channels; assert relationships, not exact sRGB values.
    // The authoritative exactness claim is the stats line: outside-mask changed pixels must be 0.
    const pixels = await ui.evaluate(async () => {
      const candidate = document.querySelector('img[alt="掩膜合成候选"]') as HTMLImageElement;
      const original = document.querySelector('img[alt="原图"]') as HTMLImageElement;
      for (const image of [candidate, original]) if (!image.complete) await new Promise<void>(resolve => { image.onload = () => resolve(); });
      const read = (image: HTMLImageElement) => { const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0); const at = (x: number, y: number) => { const d = context.getImageData(x, y, 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; }; return { corner: at(2, 2), center: at(32, 32) }; };
      return { candidate: read(candidate), original: read(original) };
    });
    expect(pixels.candidate.corner).toBe(pixels.original.corner);
    const [cr, cg, cb] = pixels.candidate.center.split(",").map(Number);
    expect(cb).toBeGreaterThan(200); expect(cr).toBeLessThan(60); expect(cg).toBeLessThan(60);
    // The page image lives inside the preview iframe: adopt, then verify pixels through the frame.
    const heroFrame = async () => {
      for (const frame of ui.frames()) { try { if (await frame.evaluate(() => Boolean(document.querySelector('[data-design-id="hero"]')))) return frame; } catch {} }
      return null;
    };
    const heroSrc = async () => { const frame = await heroFrame(); return frame ? frame.evaluate(() => (document.querySelector('[data-design-id="hero"]') as HTMLImageElement).src) : null; };
    const pageImgBefore = await heroSrc();
    const adoptBtn = await ui.$('button::-p-text(采纳并替换页面图片)');
    await adoptBtn!.evaluate(el => (el as HTMLButtonElement).scrollIntoView({ block: "center" }));
    await new Promise(r => setTimeout(r, 200));
    const adoptCover = await adoptBtn!.evaluate(el => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { disabled: (el as HTMLButtonElement).disabled, topAt: at ? `${at.tagName}.${String(at.className).slice(0, 40)}` : null }; });
    await adoptBtn!.evaluate(el => (el as HTMLButtonElement).click());
    const adoptDeadline = Date.now() + 15000; let adoptedSrc: string | null = null;
    while (Date.now() < adoptDeadline) { adoptedSrc = await heroSrc(); if (adoptedSrc && adoptedSrc.startsWith("data:image") && adoptedSrc !== pageImgBefore) break; await new Promise(r => setTimeout(r, 200)); }
    expect(adoptedSrc ?? "").toContain("data:image/png");
    // Adopted pixels: outside the mask the original red survives verbatim; inside it turned blue.
    const adoptedFrame = await heroFrame(); expect(adoptedFrame).not.toBeNull();
    const adopted = await adoptedFrame!.evaluate(async () => {
      const image = document.querySelector('[data-design-id="hero"]') as HTMLImageElement;
      if (!image.complete) await new Promise<void>(resolve => { image.onload = () => resolve(); });
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const at = (x: number, y: number) => { const d = context.getImageData(x, y, 1, 1).data; return `${d[0]},${d[1]},${d[2]}`; };
      return { corner: at(2, 2), center: at(32, 32) };
    });
    expect(adopted.corner).toBe(pixels.candidate.corner);
    const [ar, ag, ab] = adopted.center.split(",").map(Number);
    expect(ab).toBeGreaterThan(200); expect(ar).toBeLessThan(60); expect(ag).toBeLessThan(60);
    // One undo restores the original page image; the library asset bytes never changed.
    // Adoption already dismissed the dialog in this flow; close it only if it is still up.
    await ui.evaluate(() => { const dialog = document.querySelector('[aria-label="局部修改（掩膜）"]'); const button = [...(dialog?.querySelectorAll("button") ?? [])].find(b => b.textContent === "关闭"); if (button) (button as HTMLButtonElement).click(); });
    const undoState = await ui.evaluate(() => [...document.querySelectorAll(".design-toolbar button")].map(x => ({ t: x.textContent, title: x.title, disabled: (x as HTMLButtonElement).disabled })));
    await ui.evaluate(() => { const b = [...document.querySelectorAll(".design-toolbar button")].find(x => x.textContent === "撤销") as HTMLButtonElement | undefined; if (!b || b.disabled) throw new Error("undo unavailable at click time"); b.click(); });
    const undoDeadline = Date.now() + 8000; let restoredSrc: string | null = null;
    while (Date.now() < undoDeadline) { restoredSrc = await heroSrc(); if (restoredSrc === pageImgBefore) break; await new Promise(r => setTimeout(r, 200)); }
    expect(restoredSrc).toBe(pageImgBefore);
    expect(fs.readdirSync(library).some(name => { try { return fs.readFileSync(path.join(library, name)).equals(redBytes); } catch { return false; } })).toBe(true);
    // AC-ERR1: a failing provider reports clearly and leaves the page untouched.
    failing = true;
    // A reload restores the exact round-one entry conditions (panel closed, hero selectable).
    await ui.reload({ waitUntil: "networkidle0" });
    await clickText("属性");
    await ui.waitForSelector('[data-design-layer="hero"] input[type="checkbox"]', { timeout: 10000 });
    await ui.locator('[data-design-layer="hero"] input[type="checkbox"]').click();
    await clickText("局部修改（掩膜）");
    try { await ui.waitForSelector('[aria-label="局部修改（掩膜）"]', { timeout: 10000 }); }
    catch { throw new Error(`re-open: dialog missing; url=${await ui.evaluate(() => location.hash)} layers=${JSON.stringify(await ui.evaluate(() => [...document.querySelectorAll("[data-design-layer]")].map(n => n.getAttribute("data-design-layer"))))}`); }
    await ui.waitForFunction(() => !document.querySelector('[aria-label="局部修改（掩膜）"]')?.textContent?.includes("正在读取原图"), { timeout: 15000 });
    const untouched = await (async () => { const frame = await heroFrame(); if (!frame) throw new Error("re-open: hero frame missing"); return frame.evaluate(() => (document.querySelector('[data-design-id="hero"]') as HTMLImageElement).src); })();
    const box = await (await ui.$('[aria-label="掩膜画布"]'))!.boundingBox();
    await ui.mouse.move(box!.x + box!.width * 0.45, box!.y + box!.height * 0.45);
    await ui.mouse.down(); await ui.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.55, { steps: 4 }); await ui.mouse.up();
    await ui.type('[aria-label="修改描述"]', "再次尝试");
    await ui.locator("button::-p-text(获取报价)").click();
    await ui.waitForSelector('[aria-label="费用确认"]');
    // Round one already spent the default cap's worth: raise the cap so the ledger stays honest.
    await ui.evaluate(() => { const cap = document.querySelector('[aria-label="费用上限"]') as HTMLInputElement; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(cap, "5"); cap.dispatchEvent(new Event("input", { bubbles: true })); });
    await ui.click('[aria-label="确认费用"]');
    await clickText("批准并提交");
    await ui.waitForFunction(() => document.querySelector('[role="alert"].design-mask-error')?.textContent?.includes("任务失败"), { timeout: 20000 });
    const touched = await (async () => { const frame = await heroFrame(); if (!frame) throw new Error("re-open: hero frame missing after failure"); return frame.evaluate(() => (document.querySelector('[data-design-id="hero"]') as HTMLImageElement).src); })();
    expect(touched).toBe(untouched);
  } finally {
    await opened?.browser.close(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    const realRoot = fs.realpathSync(root), realTemp = fs.realpathSync(os.tmpdir());
    if (path.dirname(realRoot) !== realTemp || !path.basename(realRoot).startsWith("glint-mask-browser-")) throw new Error("Unexpected temporary test directory");
    fs.rmSync(realRoot, { recursive: true, force: true });
    delete process.env.GLINT_DATA_DIR;
  }
}, 120_000);
