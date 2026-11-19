import { openInspector } from "./browser-workspace-helpers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false; try { findSystemBrowser(); browserAvailable = true; } catch { /* no browser download */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("plays historical video with real controls and a direct media page", async () => {
  const root = process.env.GLINT_DATA_DIR;
  if (!root || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_CACHE_DIR || !process.env.GLINT_STYLE_SAMPLE_DIR) throw new Error("Explicit isolated directories are required");
  const evidence = process.env.GLINT_STYLE_HISTORY_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const { createWebServer } = await import("./index.mjs");
  const runner = { submit() { throw new Error("Unexpected job"); }, get() { return null; }, findRequest() { return null; }, cancel() { return false; }, videoFile() { return null; } };
  const server = createWebServer({ distDir: dist, makeRunner: runner, sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }) }) as Server;
  const project = parseProject({ schemaVersion: 1, id: "isolated-history-playback", title: "隔离测试", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "测试工程", narration: { text: "测试旁白", durationMs: 2000 } }] });
  let browser: Awaited<ReturnType<typeof openCaptureBrowser>>["browser"] | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
    console.log("浏览器", await browser!.version());
    const page = await browser!.newPage(), errors: string[] = [], requests: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("response", response => { if (response.url().includes("/api/style-catalog/samples/")) requests.push(`${response.status()} ${response.request().headers().range ?? "no-range"}`); });
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "隔离测试", project: value })), project);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.locator('[aria-label="风格包"] summary').click();
    const catalog = '[aria-label="主题样片与版本"]';
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("播放历史样片"), {}, catalog);
    await page.locator(`${catalog} button::-p-text(播放历史样片)`).click();
    const video = '[aria-label="历史风格样片"]';
    await page.waitForFunction(selector => (document.querySelector(selector) as HTMLVideoElement)?.readyState >= 2, {}, video);
    const state = () => page.$eval(video, e => { const v = e as HTMLVideoElement; return { time: v.currentTime, paused: v.paused, ready: v.readyState, duration: v.duration, error: v.error?.code, src: v.currentSrc }; });
    await page.$eval(video, element => element.scrollIntoView({ block: "center" }));
    const box = await (await page.$(video))!.boundingBox();
    if (!box) throw new Error("历史视频不在视口中");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const playing = await state();
    console.log("嵌入视频", JSON.stringify(playing), requests);
    expect(playing.time).toBeGreaterThan(0.5); expect(playing.paused).toBe(false);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const paused = await state(); expect(paused.paused).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect((await state()).time - paused.time).toBeLessThan(0.1);
    const direct = await browser!.newPage();
    await direct.goto(playing.src, { waitUntil: "load" });
    await direct.waitForSelector("video");
    await direct.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement).readyState >= 2);
    const directBox = await (await direct.$("video"))!.boundingBox();
    if (!directBox) throw new Error("直接视频页面没有可见视频");
    const initial = await direct.$eval("video", e => ({ time: (e as HTMLVideoElement).currentTime, paused: (e as HTMLVideoElement).paused }));
    if (initial.paused) await direct.mouse.click(directBox.x + directBox.width / 2, directBox.y + directBox.height / 2);
    const before = await direct.$eval("video", e => (e as HTMLVideoElement).currentTime);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const directState = await direct.$eval("video", e => { const v = e as HTMLVideoElement; return { time: v.currentTime, paused: v.paused, ready: v.readyState, error: v.error?.code }; });
    console.log("直接视频", JSON.stringify({ before, ...directState }));
    expect(directState.time).toBeGreaterThan(before + 0.5); expect(directState.paused).toBe(false);
    await page.bringToFront(); await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.$eval(catalog, e => e.scrollIntoView({ block: "start" }));
    expect(await page.$eval(catalog, e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    if (evidence) await page.screenshot({ path: path.join(evidence, "history-dark-390.png") });
    await page.locator('.rail-button[aria-label="帮助"]').click(); await page.locator('button[aria-label="切换浅色主题"]').click(); await page.keyboard.press("Escape");
    expect(await page.$eval("html", e => e.getAttribute("data-theme"))).toBe("light");
    await page.$eval(catalog, e => e.scrollIntoView({ block: "start" }));
    if (evidence) await page.screenshot({ path: path.join(evidence, "history-light-390.png") });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace") || "null").project)).toEqual(project);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("recovers a style trial without resubmitting or changing the project", async () => {
  const root = process.env.GLINT_DATA_DIR;
  if (!root || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_CACHE_DIR) throw new Error("Explicit isolated DATA, SESSION and CACHE directories are required");
  const { createWebServer } = await import("./index.mjs");
  let submissions = 0, status = "running", requestId = "", lastInput: any;
  const runner = {
    submit(input: any) { submissions++; lastInput = input; requestId = input.requestId; status = "running"; return { jobId: `idea-${submissions}` }; },
    findRequest(id: string) { return id === requestId ? this.get(`idea-${submissions}`) : null; },
    get(id: string) { return { id, status, log: [], ...(status === "failed" ? { error: "本地渲染失败" } : {}) }; },
    cancel() { status = "cancelled"; return true; }, videoFile() { return null; },
  };
  const server = createWebServer({ distDir: dist, makeRunner: runner, sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const project = parseProject({ schemaVersion: 1, id: "style-trial-browser", title: "隔离测试", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "原有工程", narration: { text: "原有旁白", durationMs: 2000 } }] });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    await page.evaluateOnNewDocument(value => { if (!localStorage.getItem("glint.workspace")) localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "隔离测试", project: value })); }, project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    const openStyle = async () => {
      await page.waitForSelector('[aria-label="共享工程编辑"]');
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.locator('[aria-label="风格包"] summary').click();
      await page.waitForSelector('[aria-label="当前工程风格试片"]');
    };
    await openStyle();
    await page.locator('[aria-label="当前工程风格试片"] button::-p-text(生成当前工程试片)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("渲染中"));
    expect(submissions).toBe(1); expect(lastInput.tts).toBe("mock"); expect(lastInput.music).toBe("off"); expect(lastInput.project).toEqual(project);
    await page.reload({ waitUntil: "networkidle0" }); await openStyle();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("渲染中"));
    expect(submissions).toBe(1);
    await page.$eval('[aria-label="当前工程风格试片"]', element => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(root, "style-trial-recovered.png") });
    await page.locator('[aria-label="当前工程风格试片"] button::-p-text(取消试片)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("已取消"));
    await page.reload({ waitUntil: "networkidle0" }); await openStyle();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("已取消"));
    expect(submissions).toBe(1);
    await page.locator('[aria-label="当前工程风格试片"] button::-p-text(生成当前工程试片)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("渲染中"));
    status = "failed";
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("本地渲染失败"), { timeout: 10000 });
    await page.reload({ waitUntil: "networkidle0" }); await openStyle();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("本地渲染失败"));
    expect(submissions).toBe(2);
    await page.locator('[aria-label="当前工程风格试片"] button::-p-text(生成当前工程试片)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"]')?.textContent?.includes("渲染中"));
    status = "done";
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"] video') !== null, { timeout: 10000 });
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(内容)').click();
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"] video') !== null, { timeout: 10000 });
    await page.reload({ waitUntil: "networkidle0" }); await openStyle();
    await page.waitForFunction(() => document.querySelector('[aria-label="当前工程风格试片"] video') !== null, { timeout: 10000 });
    expect(submissions).toBe(3);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace") || "null").project)).toEqual(project);
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("reads real historical samples and saves and restores readable theme versions in isolation", async () => {
  const root = process.env.GLINT_DATA_DIR;
  if (!root || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_CACHE_DIR) throw new Error("Explicit isolated DATA, SESSION and CACHE directories are required");
  const { createWebServer } = await import("./index.mjs");
  const runner = { submit() { throw new Error("Unexpected job"); }, get() { return null; }, findRequest() { return null; }, cancel() { return false; }, videoFile() { return null; } };
  const server = createWebServer({ distDir: dist, makeRunner: runner, sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }) }) as Server;
  const project = parseProject({ schemaVersion: 1, id: `catalog-${Date.now()}`, title: "隔离测试", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "原有工程", narration: { text: "原有旁白", durationMs: 2000 } }] });
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    let failSample = true, failHistory = true;
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/api/style-catalog/samples" && failSample) { failSample = false; void request.respond({ status: 503, contentType: "application/json", body: '{"error":"不可用"}' }); }
      else if (url.pathname === "/api/style-catalog/history" && request.method() === "GET" && failHistory) { failHistory = false; void request.respond({ status: 503, contentType: "application/json", body: '{"error":"不可用"}' }); }
      else void request.continue();
    });
    await page.evaluateOnNewDocument(value => { if (!localStorage.getItem("glint.workspace")) localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "隔离测试", project: value })); }, project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.locator('[aria-label="风格包"] summary').click();
    const catalog = '[aria-label="主题样片与版本"]';
    await page.waitForFunction(selector => { const text = document.querySelector(selector)?.textContent ?? ""; return text.includes("无法读取样片目录") && text.includes("无法读取主题版本"); }, {}, catalog);
    expect(await page.$eval(catalog, el => el.textContent)).not.toContain("暂无保存的主题版本");
    await page.locator(`${catalog} button::-p-text(重试)`).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("播放历史样片"), {}, catalog);
    await page.locator(`${catalog} button::-p-text(播放历史样片)`).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="历史风格样片"]') as HTMLVideoElement)?.readyState >= 1);
    await page.locator(`${catalog} button::-p-text(保存当前主题版本)`).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("已保存当前主题版本"), {}, catalog);
    await page.locator(`${catalog} summary::-p-text(查看主题参数)`).click();
    expect(await page.$eval(`${catalog} pre`, el => el.textContent)).toContain("glint-dark");
    await page.locator('[aria-label="可选风格包"] button::-p-text(海报大字)').click();
    await page.locator('[aria-label="风格详情"] button[aria-label="应用风格 海报大字"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.theme === "bold-poster");
    page.once("dialog", dialog => void dialog.accept());
    await page.locator(`${catalog} button::-p-text(恢复此版本)`).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.theme === "glint-dark");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace") || "null").project);
    expect(saved.scenes).toEqual(project.scenes);
    await page.$eval(catalog, element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(root, "style-catalog-desktop.png") });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    expect(await page.$eval(catalog, el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: path.join(root, "style-catalog-mobile.png") });
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);
