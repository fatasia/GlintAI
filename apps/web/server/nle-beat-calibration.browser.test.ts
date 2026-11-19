import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { makeBeatFixture } from "./beat-fixture";

let browserAvailable = false; try { findSystemBrowser(); browserAvailable = true; } catch { /* no downloads */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("isolates data and requires explicit selection, audition and application", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-calibration-ui-"));
  const old = { ...process.env };
  process.env.GLINT_DATA_DIR = path.join(root, "data");
  process.env.GLINT_SESSION_DIR = path.join(root, "sessions");
  process.env.GLINT_CACHE_DIR = path.join(root, "cache");
  process.env.GLINT_STYLE_SAMPLE_DIR = path.join(root, "samples");
  if (!process.env.GLINT_TEST_WEB_DIST || !path.isAbsolute(process.env.GLINT_TEST_WEB_DIST)) throw new Error("GLINT_TEST_WEB_DIST must point to an isolated build");
  const media = path.join(root, "media"); fs.mkdirSync(media); fs.writeFileSync(path.join(media, "clicks.wav"), makeBeatFixture());
  const { createWebServer } = await import("./index.mjs");
  const { createMediaJobs } = await import("./media-jobs.mjs");
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST, mediaJobs: createMediaJobs(media, {}), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 720); const page = opened.page;
    await page.evaluateOnNewDocument(() => {
      const original = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        const node = original.call(this), start = node.start.bind(node), context = this;
        node.start = (when = 0) => { ((window as any).__beatSchedule ??= []).push(when - context.currentTime); start(when); };
        return node;
      };
    });
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "calibration-test", title: "节拍测试", fps: 30, width: 1280, height: 720, tracks: [
      { id: "a1", kind: "audio", name: "音频", clips: [{ id: "music", kind: "audio", src: "assets/clicks.wav", startMs: 1000, durationMs: 4000, trimStartMs: 1000 }] },
      { id: "t1", kind: "text", name: "文字", clips: [{ id: "text", kind: "text", text: "文字", startMs: 0, durationMs: 1000 }] },
    ] };
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="多轨时间线"]'); await page.locator('summary::-p-text(节拍吸附)').click();
    await page.locator('input[aria-label="节拍 BPM"]').fill("97");
    await page.locator('input[aria-label="首拍偏移 ms"]').fill("333");
    const snap = 'input[aria-label="吸附"]';
    if (await page.$eval(snap, e => (e as HTMLInputElement).checked)) await page.locator(snap).click();
    expect(await page.$eval(snap, e => (e as HTMLInputElement).checked)).toBe(false);
    await page.locator('[aria-label="音频 music"]').click();
    const response = page.waitForResponse(result => result.url().endsWith("/api/nle/beats"));
    await page.locator('button::-p-text(分析选中音频)').click();
    const result = await (await response).json(); expect(result.calibration.candidates.length).toBeGreaterThan(0);
    await page.waitForSelector('[aria-label="节拍校准候选"]');
    expect(await page.$eval('input[aria-label="节拍 BPM"]', e => (e as HTMLInputElement).value)).toBe("97");
    expect(await page.$eval('input[aria-label="首拍偏移 ms"]', e => (e as HTMLInputElement).value)).toBe("333");
    expect(await page.$eval('button::-p-text(应用所选到手动网格)', e => (e as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('[name="beat-calibration"]').click();
    await page.locator('button::-p-text(试听所选候选)').click();
    await page.waitForFunction(() => document.body.innerText.includes("正在试听源音频与候选节拍") || document.body.innerText.includes("试听失败"));
    await page.waitForFunction(() => ((window as any).__beatSchedule?.length ?? 0) >= 2);
    expect(await page.evaluate(() => (window as any).__beatSchedule.some((lead: number) => lead > 0.005))).toBe(true);
    expect(await page.$eval('[aria-label="节拍校准候选"]', e => e.textContent)).toContain("长片、变速或复杂音乐可能逐渐偏离");
    expect(await page.$eval('[aria-label="节拍校准候选"]', e => e.textContent)).toContain("不是准确概率");
    const calibrationBounds = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === '节拍吸附')!;
      const timeline = document.querySelector('[aria-label="多轨时间线"]')!.getBoundingClientRect();
      const workspace = document.querySelector('.nle-body')!.getBoundingClientRect();
      const stage = document.querySelector('.nle-stage')!.getBoundingClientRect();
      return { panel: panel.getBoundingClientRect().toJSON(), timeline: timeline.toJSON(), workspace: workspace.toJSON(), stage: stage.toJSON(), scrollHeight: panel.querySelector(".nle-beat-body")!.scrollHeight, clientHeight: panel.querySelector(".nle-beat-body")!.clientHeight };
    });
    expect(calibrationBounds.panel.bottom).toBeLessThanOrEqual(calibrationBounds.timeline.top);
    expect(calibrationBounds.panel.top).toBeGreaterThanOrEqual(calibrationBounds.workspace.top);
    expect(calibrationBounds.stage.top).toBeGreaterThanOrEqual(calibrationBounds.workspace.top);
    expect(calibrationBounds.stage.height).toBeGreaterThan(40);
    expect(calibrationBounds.scrollHeight).toBeGreaterThan(calibrationBounds.clientHeight);
    expect(await page.$eval('.nle-beat-panel', panel => { const p = panel.getBoundingClientRect(); const summary = panel.querySelector('summary')!.getBoundingClientRect(); return summary.top >= p.top && summary.bottom <= p.bottom; })).toBe(true);
    console.log("calibration boundary", JSON.stringify(calibrationBounds), "evidence", root);
    await page.screenshot({ path: path.join(root, "calibration-1280.png") });
    await page.locator('button::-p-text(应用所选到手动网格)').click();
    await page.waitForFunction(() => document.body.innerText.includes("并开启吸附与节拍吸附"));
    expect(Number(await page.$eval('input[aria-label="节拍 BPM"]', e => (e as HTMLInputElement).value))).toBe(result.calibration.candidates[0].bpm);
    expect(Number(await page.$eval('input[aria-label="首拍偏移 ms"]', e => (e as HTMLInputElement).value))).toBe(1000 + result.calibration.candidates[0].offsetMs);
    expect(await page.$eval(snap, e => (e as HTMLInputElement).checked)).toBe(true);
    expect(await page.$eval('input[aria-label="启用节拍吸附"]', e => (e as HTMLInputElement).checked)).toBe(true);
    const target = Math.round(1000 + result.calibration.candidates[0].offsetMs);
    const textClip = await page.$('[aria-label="文字 text"]');
    const rect = await textClip?.boundingBox(); if (!rect) throw new Error("text clip bounds missing");
    await page.mouse.move(rect.x + 20, rect.y + rect.height / 2); await page.mouse.down();
    await page.mouse.move(rect.x + 20 + (target + 20) * 0.08, rect.y + rect.height / 2, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[1].clips[0].startMs === expected, {}, target);
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[1].clips[0].startMs === 0);
    await page.locator('[aria-label="音频 music"]').click();
    await page.locator('input[aria-label="节拍 BPM"]').fill("110");
    expect(await page.$eval('input[aria-label="节拍 BPM"]', e => (e as HTMLInputElement).value)).toBe("110");
    await page.locator('input[aria-label="起点 ms"]').fill("1500"); await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.waitForFunction(() => !document.querySelector('[aria-label="节拍校准候选"]'));
    await page.setRequestInterception(true);
    let pending: import("puppeteer-core").HTTPRequest | undefined;
    const intercept = (request: import("puppeteer-core").HTTPRequest) => {
      if (request.url().endsWith("/api/nle/beats")) pending = request;
      else void request.continue();
    };
    page.on("request", intercept);
    await page.locator('button::-p-text(分析选中音频)').click();
    await page.waitForFunction(() => document.body.innerText.includes("正在本地分析"));
    await page.locator('button::-p-text(取消分析)').click();
    await page.waitForFunction(() => document.body.innerText.includes("已取消本地分析"));
    if (pending) await pending.abort().catch(() => {}); pending = undefined;
    await page.locator('button::-p-text(分析选中音频)').click();
    await page.waitForFunction(() => document.body.innerText.includes("正在本地分析"));
    await page.locator('[aria-label="文字 text"]').click();
    await page.waitForFunction(() => document.body.innerText.includes("选择或工程已变化"));
    if (pending) await pending.abort().catch(() => {}); pending = undefined;
    page.off("request", intercept);
    page.on("request", request => { if (request.url().endsWith("/api/nle/beats")) void request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "音频分析服务不可用，请重试。" }) }); else void request.continue(); });
    await page.locator('[aria-label="音频 music"]').click();
    await page.locator('button::-p-text(分析选中音频)').click();
    await page.waitForFunction(() => document.body.innerText.includes("音频分析服务不可用"));
    expect(await page.$eval('input[aria-label="节拍 BPM"]', e => (e as HTMLInputElement).value)).toBe("110");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 }); await page.screenshot({ path: path.join(root, "calibration-390.png") });
    console.log(`Isolated browser evidence: ${root}`);
  } finally {
    await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of ["GLINT_DATA_DIR", "GLINT_SESSION_DIR", "GLINT_CACHE_DIR", "GLINT_STYLE_SAMPLE_DIR"]) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  }
}, 90_000);
