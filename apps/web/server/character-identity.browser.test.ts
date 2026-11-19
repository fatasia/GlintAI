import { openInspector } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JS server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("approves a character, binds its voice and persists the snapshot through reload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-character-browser-")), media = path.join(root, "media"); fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, "hero.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const sessionDir = path.join(root, "sessions"), server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? process.env.GLINT_TEST_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: createMediaJobs(media, {}), sessionStore: new FileSessionStore(sessionDir, value => { parseProject(value); }), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "character-browser", title: "角色测试", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "one", kind: "title", title: "第一镜", narration: { text: "第一句", durationMs: 1000 } },
      { id: "two", kind: "title", title: "第二镜", narration: { text: "第二句", durationMs: 1000 } },
    ] };
    await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "角色测试资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "角色测试资料" })), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]', { timeout: 30000 });
    await page.waitForFunction(() => /共享工程 · r\d+/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""));
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click();
    await page.locator('[aria-label="角色资产"] summary').click();
    await page.waitForSelector('[aria-label="角色参考图"] option[value="hero.png"]');
    await page.locator('input[aria-label="角色名称"]').fill("小雨");
    await page.locator('textarea[aria-label="角色外观"]').fill("短发，蓝色外套");
    await page.locator('input[aria-label="角色音色"]').fill("voice-a");
    await page.select('select[aria-label="角色参考图"]', "hero.png");
    await page.locator('button::-p-text(保存角色草稿)').click();
    await page.waitForSelector('button::-p-text(批准角色版本)', { visible: true });
    await page.locator('button::-p-text(批准角色版本)').click();
    await page.waitForSelector('button::-p-text(绑定当前镜头并设置音色)', { visible: true });
    await page.locator('button::-p-text(绑定当前镜头并设置音色)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="角色资产"]')?.textContent?.includes("已绑定当前镜头"));
    await page.waitForFunction(() => /已保存并回读/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""), { timeout: 20000 });
    await page.waitForFunction(() => { const saved = JSON.parse(localStorage.getItem("glint.workspace") ?? "null"); return Boolean(saved?.project?.assets?.[0]?.approval && saved?.project?.scenes?.[0]?.assetRefs?.length); }, { timeout: 10000 });
    const readSnapshot = async () => (await (await fetch(`${url}/api/session/snapshot?projectId=character-browser`)).json()).snapshot.document;
    const saved = await readSnapshot(); expect(saved.assets[0].approval).toMatchObject({ name: "小雨", voice: "voice-a" });
    expect(saved.assets[0].approval.refSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.assets[0].approval.refs[0]).toBe(`assets/approved-${saved.assets[0].approval.refSha256}.png`);
    expect(saved.scenes[0]).toMatchObject({ narration: { voice: "voice-a" }, assetRefs: [{ assetId: saved.assets[0].id, version: "v1" }] });
    expect(saved.scenes[1].narration.voice).toBeUndefined();
    await page.locator('button::-p-text(新建角色版本草稿)').click();
    await page.waitForFunction(() => /已保存并回读/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""), { timeout: 20000 });
    await page.locator('button::-p-text(批准角色版本)').click();
    await page.locator('button::-p-text(仅替换当前镜头的旧版本)').click();
    await page.waitForFunction(async () => { const data = await (await fetch("/api/session/snapshot?projectId=character-browser")).json(); const project = data.snapshot?.document; return project?.assets?.length === 2 && project?.scenes?.[0]?.assetRefs?.[0]?.assetId === project?.assets?.[1]?.id; }, { timeout: 20000 });
    const upgraded = await readSnapshot();
    expect(upgraded.assets).toHaveLength(2); expect(upgraded.assets[0]).toEqual(saved.assets[0]);
    expect(upgraded.assets[1].derivedFrom).toEqual({ assetId: saved.assets[0].id, version: "v1" });
    expect(upgraded.assets[1].approval.refSha256).toBe(saved.assets[0].approval.refSha256);
    expect(upgraded.scenes[0].assetRefs).toEqual([{ assetId: upgraded.assets[1].id, version: upgraded.assets[1].version }]);
    expect(upgraded.scenes[1]).toEqual(saved.scenes[1]);
    if (process.env.GLINT_CHARACTER_EVIDENCE) await (await page.$('[aria-label="角色资产"]'))!.screenshot({ path: path.join(process.env.GLINT_CHARACTER_EVIDENCE, "character-1280.png") });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="角色资产"]'), box = await panel!.boundingBox(); expect(box && box.width <= 390).toBe(true);
    if (process.env.GLINT_CHARACTER_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_CHARACTER_EVIDENCE, "character-390.png") });
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click(); await page.locator('[aria-label="角色资产"] summary').click();
    expect(await page.$eval('select[aria-label="选择角色资产"]', element => element.textContent)).toContain("小雨");
    expect((await readSnapshot()).assets[0].approval).toEqual(saved.assets[0].approval); expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available).each([1280, 390])("runs the product approval and reference candidate flow in Chromium at %ipx", async width => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-product-browser-")), media = path.join(root, "media");
  fs.mkdirSync(media);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(media, "product.png"), bytes); fs.writeFileSync(path.join(media, "old.png"), bytes);
  const client = { models: vi.fn(async () => [{ id: "edit", name: "本地替身", tags: ["图生图"] }]), submit: vi.fn(async () => "product-task"), status: vi.fn(async () => ({ task_id: "product-task", state: "success", is_final: true, result_url: "https://asset.invalid/test.png" })) };
  const jobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://gateway.invalid", GLINT_MEDIA_API_KEY: "local-test" }, { client, download: vi.fn(async () => ({ contentType: "image/png", bytes })) });
  const store = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); });
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? process.env.GLINT_TEST_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: jobs, sessionStore: store, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(width, width === 390 ? 844 : 900); const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", request => {
      const target = request.url();
      if (target.startsWith(`${url}/`) || target.startsWith("data:") || target.startsWith("blob:")) void request.continue();
      else void request.abort();
    });
    const project = { schemaVersion: 1, id: "product-browser", title: "商品测试", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "one", kind: "image", src: "assets/old.png", narration: { text: "商品介绍", voice: "voice-original", durationMs: 1000 } },
      { id: "two", kind: "title", title: "第二镜", narration: { text: "第二句", durationMs: 1000 } },
    ] };
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "商品资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "商品资料" })), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => /共享工程 · r\d+/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""), { timeout: 30000 });
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click();
    await page.locator('[aria-label="商品资产"] summary').click();
    await page.waitForSelector('[aria-label="商品参考图"] option[value="product.png"]');
    expect(await page.$eval('button::-p-text(保存商品草稿)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('input[aria-label="商品名称"]').fill("测试商品");
    await page.locator('textarea[aria-label="商品描述"]').fill("蓝色商品包装");
    await page.select('select[aria-label="商品参考图"]', "product.png");
    await page.locator('button::-p-text(保存商品草稿)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="商品资产"]')?.textContent?.includes("草稿，尚未批准"));
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('[aria-label="商品资产"] button')].find(x => x.textContent === "批准商品版本") as HTMLButtonElement | undefined; return button && !button.disabled; }, { timeout: 20000 });
    await page.locator('button::-p-text(批准商品版本)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="商品资产"]')?.textContent?.includes("已批准，编辑已锁定"));
    expect(await page.$eval('input[aria-label="商品名称"]', element => element.matches(":disabled"))).toBe(true);
    await page.locator('button::-p-text(绑定商品到当前镜头)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="商品资产"]')?.textContent?.includes("商品已绑定当前镜头"));
    expect(await page.$eval('button::-p-text(绑定商品到当前镜头)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.waitForFunction(async () => { const p = (await (await fetch('/api/session/snapshot?projectId=product-browser')).json()).snapshot?.document; return Boolean(p?.scenes?.[0]?.assetRefs?.length); }, { timeout: 20000 });
    const snapshot = () => store.snapshot(project.id).snapshot.document as any;
    const bound = snapshot(); const asset = bound.assets[0];
    expect(asset.approval.refSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bound.scenes[0].narration.voice).toBe("voice-original");
    expect(bound.scenes[0].assetRefs).toEqual([{ assetId: asset.id, version: "v1" }]);
    expect(bound.scenes[1]).toEqual(project.scenes[1]);
    await page.locator('[aria-label="为这个镜头生成素材"] summary').click();
    await page.waitForSelector(`select[aria-label="生成角色或商品参考图"] option[value="${asset.id}"]`);
    expect(await page.$eval('select[aria-label="生成角色或商品参考图"]', element => (element as HTMLSelectElement).value)).toBe("");
    expect(await page.$eval('button::-p-text(生成候选（可能计费）)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('select[aria-label="生成角色或商品参考图"]')?.disabled);
    await page.select('select[aria-label="生成角色或商品参考图"]', asset.id);
    await page.$eval('[aria-label="为这个镜头生成素材"] input[type="checkbox"]', element => (element as HTMLInputElement).click());
    await page.locator('button::-p-text(生成候选（可能计费）)').click();
    await page.waitForSelector('img[aria-label="候选生成图片"]', { timeout: 20000 });
    expect(client.submit).toHaveBeenCalledTimes(1);
    const params = (client.submit.mock.calls[0] as unknown as [string, string, { images: string[] }])[2];
    expect(params.images).toEqual([`data:image/png;base64,${bytes.toString("base64")}`]);
    expect(snapshot().scenes[0].src).toBe("assets/old.png");
    expect(await page.$eval('button::-p-text(生成候选（可能计费）)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('button::-p-text(用候选替换当前镜头)').click();
    await page.waitForFunction(async () => /^assets\/adopted-[a-f0-9]{64}\.png$/.test((await (await fetch('/api/session/snapshot?projectId=product-browser')).json()).snapshot?.document?.scenes?.[0]?.src ?? ''), { timeout: 20000 });
    const adoptedSrc = snapshot().scenes[0].src;
    expect(snapshot().scenes[0].narration.voice).toBe("voice-original");
    expect(client.submit).toHaveBeenCalledTimes(1);
    if (process.env.GLINT_PRODUCT_EVIDENCE) await (await page.$('[aria-label="为这个镜头生成素材"]'))!.screenshot({ path: path.join(process.env.GLINT_PRODUCT_EVIDENCE, `product-${width}-panel.png`) });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="商品资产"]'), box = await panel!.boundingBox(); expect(box && box.width <= 390).toBe(true);
    if (process.env.GLINT_PRODUCT_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_PRODUCT_EVIDENCE, `product-${width}-at-390-panel.png`) });
    await page.waitForFunction(() => /^assets\/adopted-[a-f0-9]{64}\.png$/.test(JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[0]?.src ?? ""), { timeout: 15000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => /共享工程 · r\d+/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""), { timeout: 30000 });
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click(); await page.locator('[aria-label="商品资产"] summary').click();
    expect(await page.$eval('select[aria-label="选择商品资产"]', element => element.textContent)).toContain("测试商品");
    await page.select('select[aria-label="选择商品资产"]', asset.id);
    expect(await page.$eval('button::-p-text(绑定商品到当前镜头)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('[aria-label="为这个镜头生成素材"] summary').click();
    await page.waitForSelector(`select[aria-label="生成角色或商品参考图"] option[value="${asset.id}"]`);
    await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('select[aria-label="生成角色或商品参考图"]')?.disabled);
    await page.select('select[aria-label="生成角色或商品参考图"]', asset.id);
    expect(await page.$eval('select[aria-label="生成角色或商品参考图"]', element => (element as HTMLSelectElement).value)).toBe(asset.id);
    expect(await page.$eval('button::-p-text(生成候选（可能计费）)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(snapshot().scenes[0].src).toBe(adoptedSrc); expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);
