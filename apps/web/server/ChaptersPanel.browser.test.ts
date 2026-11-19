import { openInspector, openWorkspaceMenu } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { captureChapter, chaptersDocument, CHAPTERS_KEY, parseChaptersDocument } from "../src/ChaptersStore";
const isolationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapters-browser-server-"));
process.env.GLINT_DATA_DIR = path.join(isolationRoot, "data");
process.env.GLINT_SESSION_DIR = path.join(isolationRoot, "sessions");
process.env.GLINT_CACHE_DIR = path.join(isolationRoot, "cache");
// @ts-expect-error JavaScript server exercised over HTTP.
const { createWebServer } = await import("./index.mjs");
// @ts-expect-error JavaScript media library loaded after isolation.
const { createMediaJobs } = await import("./media-jobs.mjs");
let available = false; try { findSystemBrowser(); available = true; } catch { /* Never download a browser. */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("manages explicit chapter snapshots, safely switches the editor and round trips reference JSON at 1280/390", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapters-browser-")), media = path.join(root, "media"), downloads = path.join(root, "downloads"); fs.mkdirSync(media); fs.mkdirSync(downloads);
  const context = { mode: "source" as const, text: "第一章资料", template: "explainer", theme: "glint-dark", evidence: "第一章依据" };
  const makeProject = (id: string, title: string) => parseProject({ schemaVersion: 1, id, title, aspect: "16:9", theme: "glint-dark", knowledgeSources: [],
    assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", refs: ["assets/hero.png"] }],
    scenes: [{ id: "one", kind: "title", title, narration: { text: `${title}的旁白`, durationMs: 3000 } }, { id: "two", kind: "title", title: "转折", narration: { text: "下一句", durationMs: 2000 } }],
  });
  const first = makeProject("chapter-one", "雨夜来信"), second = makeProject("chapter-two", "旧街重逢"), importFile = path.join(root, "chapters.references.json");
  fs.writeFileSync(importFile, JSON.stringify(chaptersDocument([captureChapter(second, { ...context, text: "第二章资料", evidence: "第二章依据" })])));
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }), requestLogDir: path.join(root, "logs"), composeCacheDir: path.join(root, "compose-cache") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const cdp = await page.createCDPSession(); await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(({ project, context }) => localStorage.setItem("glint.workspace", JSON.stringify({ ...context, project, aspect: "16:9" })), { project: first, context });
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    const panel = '[aria-label="章节管理"]', list = `${panel} [aria-label="章节列表"]`, confirm = `${panel} [aria-label="确认章节操作"]`;
    const openPanel = async () => {
      if (await page.$eval('.home-more', element => Boolean(element.getClientRects().length))) await page.locator('.home-resume').click();
      if (await page.$eval('#workspace-tools', element => Boolean(element.getClientRects().length))) await page.locator('.workspace-tools-heading button').click();
      await openWorkspaceMenu(page, "更多创作选项");
      if (!await page.$eval(panel, element => (element as HTMLDetailsElement).open)) await page.locator(`${panel} > summary`).click();
      await page.waitForSelector(`${panel} .chapters-body`, {visible:true});
    };
    const openManage = async (index: number) => { const selector = `${list} > li:nth-child(${index}) .chapters-actions > details`; if (!await page.$eval(selector, element => (element as HTMLDetailsElement).open)) await page.locator(`${selector} > summary`).click(); };
    const consent = async () => { await page.locator(`${confirm} input[type="checkbox"]`).click(); };
    const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), CHAPTERS_KEY);
    const currentId = () => page.$eval('[aria-label="共享工程编辑"] code', element => element.textContent);
    await openPanel();
    expect(await page.$eval(`${panel} button::-p-text(导入含素材包)`, element => (element as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval(`${panel} button::-p-text(导出含素材包)`, element => (element as HTMLButtonElement).disabled)).toBe(true);
    expect(await page.$eval(`${panel} .chapters-toolbar`, element => element.textContent)).toContain("网页内含素材章节包暂不可用");
    expect(await page.$eval(`${panel} button::-p-text(导出含素材包)`, element => element.getAttribute("title"))).toContain("安全条件尚未满足");
    expect(await read()).toBeNull(); await page.locator(`${panel} button::-p-text(将当前工程加入章节)`).click();
    await page.waitForSelector(`${list} > li`); expect((await read()).chapters).toHaveLength(1);
    await (await page.$(`${panel} input[aria-label="章节 JSON 文件"]`))!.uploadFile(importFile); await page.waitForSelector(confirm);
    expect((await read()).chapters).toHaveLength(1); expect(await currentId()).toBe(first.id);
    await consent(); await page.locator(`${confirm} button::-p-text(确认添加章节)`).click(); await page.waitForFunction(selector => document.querySelectorAll(`${selector} > li`).length === 2, {}, list);
    expect(await page.$eval(`${panel} .chapters-totals`, element => element.textContent)).toContain("1 个跨章同版本资产 · 1 个引用相同路径");
    await openManage(2); await page.locator(`${list} > li:nth-child(2) button::-p-text(重命名)`).click();
    await page.locator(`${panel} input[aria-label="章节新名称"]`).fill("第二章 · 旧街重逢"); await page.locator(`${panel} button::-p-text(保存名称)`).click();
    await page.locator(`${panel} button[aria-label="上移 第二章 · 旧街重逢"]`).click();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? "null")?.chapters?.[0]?.project?.id === "chapter-two", {}, CHAPTERS_KEY);
    expect((await read()).chapters.map((chapter: { project: { id: string } }) => chapter.project.id)).toEqual([second.id, first.id]);
    await openManage(1); await page.locator(`${list} > li:nth-child(1) button::-p-text(移除)`).click();
    expect((await read()).chapters).toHaveLength(2); await page.locator(`${confirm} button::-p-text(取消操作)`).click();
    await page.locator(`${list} > li:nth-child(1) button::-p-text(载入编辑)`).click(); expect(await currentId()).toBe(first.id);
    expect(await page.$eval(`${confirm} button`, element => (element as HTMLButtonElement).disabled)).toBe(true);
    await consent(); await page.locator(`${confirm} button::-p-text(确认载入)`).click(); await page.waitForFunction(() => document.querySelector('[aria-label="共享工程编辑"] code')?.textContent === "chapter-two");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.projects")!)[0].project.id)).toBe(first.id);
    expect(await page.$eval('textarea[aria-label="创作资料"]', element => (element as HTMLTextAreaElement).value)).toBe("第二章资料");
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(声音)').click(); await page.locator('textarea[aria-label="旁白"]').fill("第二章修改过的旁白");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[0]?.narration?.text === "第二章修改过的旁白");
    expect((await read()).chapters[0].project.scenes[0].narration.text).toBe("旧街重逢的旁白");
    await openPanel(); await page.locator(`${panel} button::-p-text(更新当前章节快照)`).click(); await consent(); await page.locator(`${confirm} button::-p-text(确认更新快照)`).click();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? "null")?.chapters?.[0]?.project?.scenes?.[0]?.narration?.text === "第二章修改过的旁白", {}, CHAPTERS_KEY);
    expect((await read()).chapters[0].project.scenes[0].narration.text).toBe("第二章修改过的旁白");
    const saved = await read(); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(panel); await openPanel(); expect(await read()).toEqual(saved);
    if (process.env.GLINT_CHAPTERS_EVIDENCE) { fs.mkdirSync(process.env.GLINT_CHAPTERS_EVIDENCE, { recursive: true }); await (await page.$(panel))!.screenshot({ path: path.join(process.env.GLINT_CHAPTERS_EVIDENCE, "chapters-1280.png") }); }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const geometry = await page.$eval(panel, element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth })); expect(geometry.width).toBeLessThanOrEqual(390); expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    if (process.env.GLINT_CHAPTERS_EVIDENCE) await (await page.$(panel))!.screenshot({ path: path.join(process.env.GLINT_CHAPTERS_EVIDENCE, "chapters-390.png") });
    await page.locator(`${panel} button::-p-text(导出章节 JSON)`).click(); const exported = path.join(downloads, "glint-chapters.references.json");
    for (let attempt = 0; attempt < 60 && !fs.existsSync(exported); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(fs.existsSync(exported)).toBe(true); const roundtrip = parseChaptersDocument(JSON.parse(fs.readFileSync(exported, "utf8"))); expect(roundtrip).toEqual(saved); expect(fs.readdirSync(downloads)).toEqual(["glint-chapters.references.json"]);
    await (await page.$(`${panel} input[aria-label="章节 JSON 文件"]`))!.uploadFile(exported); await page.waitForSelector(`${panel} [role="alert"]`); expect(await page.$eval(`${panel} [role="alert"]`, element => element.textContent)).toContain("重复"); expect(await read()).toEqual(saved);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(key => { const original = Storage.prototype.setItem; (window as unknown as { restoreChapterStorage: () => void }).restoreChapterStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function (name, value) { if (name === key) throw new Error("quota"); return original.call(this, name, value); }; }, CHAPTERS_KEY);
    await openManage(1); await page.locator(`${panel} button[aria-label="下移 第二章 · 旧街重逢"]`).click(); expect(await read()).toEqual(saved);
    await page.waitForFunction(() => document.querySelector('[aria-label="章节管理"] [role="alert"]')?.textContent?.includes("未保存本次修改"));
    expect(await page.$eval(`${panel} [role="alert"]`, element => element.textContent)).toContain("未保存本次修改"); await page.evaluate(() => (window as unknown as { restoreChapterStorage: () => void }).restoreChapterStorage());
    await page.setRequestInterception(true); page.on("request", request => { if (request.url().endsWith("/api/make/idea-chapter-pending")) void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "idea-chapter-pending", status: "render", log: [] }) }); else void request.continue(); });
    await page.evaluate(() => localStorage.setItem("glint.last-job", "idea-chapter-pending")); await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector(panel); await openPanel();
    expect(await page.$eval(`${list} button`, element => (element as HTMLButtonElement).disabled)).toBe(true); expect(await read()).toEqual(saved); expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);

// 生产迁移服务关闭，保留测试以便安全条件满足后恢复。
it.skip("exports and re-imports an asset-embedded chapter bundle through the real library", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-chapter-bundle-ui-")), media = path.join(root, "media"), downloads = path.join(root, "downloads");
  fs.mkdirSync(media); fs.mkdirSync(downloads);
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true });
  expect(generated.status, String(generated.stderr)).toBe(0); const png = generated.stdout;
  const context = { mode: "source" as const, text: "资料", template: "explainer", theme: "glint-dark", evidence: "依据" };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }), requestLogDir: path.join(root, "logs"), composeCacheDir: path.join(root, "compose-cache") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const upload = await fetch(`${url}/api/media/import-image`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
    expect(upload.status).toBe(201); const { name } = await upload.json() as { name: string };
    const project = parseProject({ schemaVersion: 1, id: "bundle-one", title: "带素材章节", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "cover", kind: "image", src: `assets/${name}`, narration: { text: "封面", durationMs: 1500 } }] });
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    const cdp = await page.createCDPSession(); await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(({ project, context }) => localStorage.setItem("glint.workspace", JSON.stringify({ ...context, project, aspect: "16:9" })), { project, context });
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    const panel = '[aria-label="章节管理"]', list = `${panel} [aria-label="章节列表"]`, confirm = `${panel} [aria-label="确认章节操作"]`;
    await page.$eval(panel, element => { (element as HTMLDetailsElement).open = true; }); await page.waitForSelector(`${panel} .chapters-body`);
    await page.locator(`${panel} button::-p-text(将当前工程加入章节)`).click(); await page.waitForSelector(`${list} > li`);
    // 导出含素材包:真实 HTTP + 下载。
    const bundleResponse = page.waitForResponse(response => response.url().endsWith("/api/chapters/export-bundle"));
    await page.locator(`${panel} button::-p-text(导出含素材包)`).click();
    const response = await bundleResponse; expect(response.status()).toBe(200);
    const bundle = (await response.json()) as { format: string; chapters: Array<{ assets: Array<{ data: string }> }> };
    expect(bundle.format).toBe("glint-chapters-portable"); expect(bundle.chapters[0]!.assets[0]!.data.length).toBeGreaterThan(50);
    await page.waitForFunction(() => document.querySelector('[aria-label="章节管理"] [role="status"]')?.textContent?.includes("含素材的章节迁移包"));
    const bundleFile = path.join(downloads, "bundle.json"); fs.writeFileSync(bundleFile, JSON.stringify(bundle));
    // 移除章节后用迁移包恢复:素材已重写入素材库,refs 指向内容寻址新名。
    await page.$eval(`${list} > li:nth-child(1) .chapters-actions > details`, element => { (element as HTMLDetailsElement).open = true; });
    await page.locator(`${list} > li:nth-child(1) button::-p-text(移除)`).click();
    await page.locator(`${confirm} input[type="checkbox"]`).click(); await page.locator(`${confirm} button::-p-text(确认移除)`).click();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="章节管理"] [aria-label="章节列表"] > li').length === 0);
    await (await page.$(`${panel} input[aria-label="章节迁移包文件"]`))!.uploadFile(bundleFile);
    await page.waitForSelector(confirm);
    expect(fs.readdirSync(media)).toEqual([name]);
    expect(await page.$eval(`${confirm} button`, element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.evaluate(() => { Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); });
    await page.locator(`${confirm} input[type="checkbox"]`).click(); await page.locator(`${confirm} button::-p-text(确认添加章节)`).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="章节管理"] [role="alert"]')?.textContent?.includes("跨标签章节锁"));
    expect(fs.readdirSync(media)).toEqual([name]);
    await page.evaluate(() => { delete (navigator as unknown as { locks?: unknown }).locks; });
    await page.evaluate(key => { const original = Storage.prototype.setItem; (window as unknown as { restorePortableStorage: () => void }).restorePortableStorage = () => { Storage.prototype.setItem = original; }; Storage.prototype.setItem = function (name, value) { if (name === key) throw new Error("quota"); return original.call(this, name, value); }; }, CHAPTERS_KEY);
    await page.locator(`${confirm} button::-p-text(确认添加章节)`).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="章节管理"] [role="alert"]')?.textContent?.includes("保存失败"));
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null")?.chapters?.length ?? 0, CHAPTERS_KEY)).toBe(0);
    await page.evaluate(() => (window as unknown as { restorePortableStorage: () => void }).restorePortableStorage());
    await page.locator(`${confirm} button::-p-text(确认添加章节)`).click();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="章节管理"] [aria-label="章节列表"] > li').length === 1);
    const restoredSrc = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.chapters.references.v1") ?? "null")?.chapters?.[0]?.project?.scenes?.[0]?.src);
    expect(restoredSrc).toMatch(/^assets\/chapter-[0-9a-f]{64}\.png$/);
    const stored = await fetch(`${url}/api/media/assets/${restoredSrc!.slice("assets/".length)}`);
    expect(stored.status).toBe(200);
    expect(Buffer.from(await stored.arrayBuffer()).equals(png)).toBe(true);
    // 相同内容再次导入是幂等操作。
    await (await page.$(`${panel} input[aria-label="章节迁移包文件"]`))!.uploadFile(bundleFile);
    await page.waitForSelector(confirm);
    await page.locator(`${confirm} input[type="checkbox"]`).click(); await page.locator(`${confirm} button::-p-text(确认添加章节)`).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="章节管理"] [role="status"]')?.textContent?.includes("迁移完成"));
    expect(await page.$$eval(`${list} > li`, elements => elements.length)).toBe(1);
    if (process.env.GLINT_CHAPTERS_EVIDENCE) await (await page.$(panel))!.screenshot({ path: path.join(process.env.GLINT_CHAPTERS_EVIDENCE, "chapters-bundle.png") });
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
}, 90000);
