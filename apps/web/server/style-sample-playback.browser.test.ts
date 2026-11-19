import { openInspector } from "./browser-workspace-helpers";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { STYLE_PACKS } from "@glintai/design-tokens";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { browserIdentity, findSystemBrowser } from "../../studio/scripts/direct-browser/host";

const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
const dist = process.env.GLINT_TEST_WEB_DIST ?? "";
let browserAvailable = false; try { findSystemBrowser(); browserAvailable = true; } catch { /* no browser */ }

/**
 * SKILL-02: every theme in the historical sample catalog must be browsable and
 * its sample must really play through the product UI — HTTP 206 range delivery
 * plus observed playback progress — in one unique-profile system Edge per run.
 */
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("plays every historical theme sample in one unique-profile system Edge", async () => {
  if (!process.env.GLINT_DATA_DIR || !process.env.GLINT_SESSION_DIR || !process.env.GLINT_CACHE_DIR || !process.env.GLINT_STYLE_SAMPLE_DIR) throw new Error("Explicit isolated directories are required");
  const evidence = process.env.GLINT_STYLE_HISTORY_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const executablePath = findSystemBrowser();
  const userDataDir = fs.mkdtempSync(path.join(process.env.TMP ?? process.env.TEMP ?? process.env.GLINT_DATA_DIR, "edge-profile-"));
  const { createWebServer } = await import("./index.mjs");
  const runner = { submit() { throw new Error("Unexpected job"); }, get() { return null; }, findRequest() { return null; }, cancel() { return false; }, videoFile() { return null; } };
  const server = createWebServer({ distDir: dist, makeRunner: runner, sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }) }) as Server;
  const project = parseProject({ schemaVersion: 1, id: `all-themes-playback-${Date.now()}`, title: "隔离测试", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "测试工程", narration: { text: "测试旁白", durationMs: 2000 } }] });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  const report: Record<string, string>[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await puppeteer.launch({ executablePath, headless: true, userDataDir, protocolTimeout: 120000 });
    console.log("浏览器可执行文件", executablePath);
    console.log("浏览器身份", browserIdentity()?.slice(0, 16));
    console.log("浏览器版本", await browser.version(), "唯一 profile", userDataDir);
    const page = await browser.newPage(), errors: string[] = [];
    const ranges: Record<string, string[]> = {};
    page.on("pageerror", error => errors.push(String(error)));
    page.on("response", response => {
      const url = response.url();
      const match = url.match(/\/api\/style-catalog\/samples\/([a-z0-9-]+)$/);
      if (match) (ranges[match[1]!] ??= []).push(`${response.status()} ${response.request().headers().range ?? "no-range"}`);
    });
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "隔离测试", project: value })), project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.locator('[aria-label="风格包"] summary').click();
    const packs = '[aria-label="可选风格包"]', catalog = '[aria-label="主题样片与版本"]';
    const video = '[aria-label="历史风格样片"]';
    const videoState = () => page.$eval(video, element => { const v = element as HTMLVideoElement; return { time: v.currentTime, paused: v.paused, ready: v.readyState, duration: v.duration, src: v.currentSrc, error: v.error?.code }; });
    for (const pack of STYLE_PACKS) {
      await page.locator(`${packs} button::-p-text(${pack.label})`).click();
      await page.waitForFunction(selector => {
        const text = document.querySelector(selector)?.textContent ?? "";
        return text.includes("播放历史样片") || text.includes("历史样片不可用") || text.includes("暂无历史样片");
      }, {}, catalog);
      const catalogText = await page.$eval(catalog, element => element.textContent ?? "");
      if (!catalogText.includes("播放历史样片")) { report.push({ theme: pack.name, catalog: "unavailable", detail: catalogText.slice(0, 80) }); continue; }
      const integrity = catalogText.match(/文件校验：([^·]*)/)?.[1]?.trim() ?? "";
      await page.locator(`${catalog} button::-p-text(播放历史样片)`).click();
      await page.waitForFunction(selector => (document.querySelector(selector) as HTMLVideoElement)?.readyState >= 2, {}, video);
      const opened = await videoState();
      expect(opened.src, pack.name).toContain(`/api/style-catalog/samples/${pack.name}`);
      await page.$eval(video, element => element.scrollIntoView({ block: "center" }));
      const box = await (await page.$(video))!.boundingBox();
      if (!box) throw new Error(`${pack.name} 历史视频不在视口中`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      let playing = await videoState();
      for (let attempt = 0; playing.paused && attempt < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await new Promise(resolve => setTimeout(resolve, 1300));
        playing = await videoState();
      }
      await new Promise(resolve => setTimeout(resolve, 1100));
      const advanced = await videoState();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const paused = await videoState();
      const themeRanges = ranges[pack.name] ?? [];
      const got206 = themeRanges.some(entry => entry.startsWith("206 "));
      report.push({ theme: pack.name, catalog: "available", integrity, duration: String(opened.duration), src: opened.src.replace(/^http:\/\/[^/]+/, ""), ranges: themeRanges.join(" | "), played: `${playing.time.toFixed(2)}s→${advanced.time.toFixed(2)}s paused=${String(advanced.paused)}`, pauseHeld: paused.paused && advanced.time - paused.time < 0.1 ? "yes" : "no" });
      expect(got206, `${pack.name} 未收到 HTTP 206 Range 响应：${themeRanges.join(",")}`).toBe(true);
      expect(playing.paused, `${pack.name} 未处于播放状态`).toBe(false);
      expect(playing.time, `${pack.name} 播放进度未推进`).toBeGreaterThan(0.3);
      expect(advanced.time, `${pack.name} 播放进度未继续推进`).toBeGreaterThan(playing.time + 0.3);
      expect(paused.paused, `${pack.name} 暂停未生效`).toBe(true);
      await page.locator(`${catalog} button::-p-text(关闭历史样片)`).click();
      expect(await page.$(video)).toBeNull();
    }
    console.log("CATALOG_REPORT", JSON.stringify(report, null, 2));
    expect(report.filter(entry => entry.catalog === "available").length, "十个主题必须全部可用且可播放").toBe(STYLE_PACKS.length);
    expect(errors).toEqual([]);
    // Systematic 1280/390 review in both app themes with a playing sample on screen.
    const first = STYLE_PACKS[0]!;
    await page.locator(`${packs} button::-p-text(${first.label})`).click();
    await page.locator(`${catalog} button::-p-text(播放历史样片)`).click();
    await page.waitForFunction(selector => (document.querySelector(selector) as HTMLVideoElement)?.readyState >= 2, {}, video);
    const styleAreas = ["风格包", "主题样片与版本", "可选风格包", "风格详情"].map(label => `[aria-label="${label}"]`).join(",");
    const sweep = () => page.$$eval(styleAreas, elements => {
      const luminance = (color: number[]) => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
      const parse = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      const backgroundOf = (element: Element): number[] => { for (let node: Element | null = element; node; node = node.parentElement) { const background = getComputedStyle(node).backgroundColor; if (background && !background.startsWith("rgba(0, 0, 0, 0)")) return parse(background); } return [255, 255, 255]; };
      const violations: string[] = [];
      for (const element of elements) {
        for (const node of [element, ...element.querySelectorAll("*")]) {
          const style = getComputedStyle(node);
          const own = Array.from(node.childNodes).some(item => item.nodeType === Node.TEXT_NODE && item.textContent?.trim());
          if (!own || style.visibility === "hidden" || style.display === "none") continue;
          const foreground = luminance(parse(style.color)), background = luminance(backgroundOf(node));
          const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
          const threshold = large ? 3 : 4.5;
          if (contrast < threshold && Number(style.opacity) === 1 && !node.querySelector("*")) violations.push(`${(node as HTMLElement).tagName}:${(node.textContent ?? "").trim().slice(0, 18)}=${contrast.toFixed(2)}<${threshold}`);
        }
      }
      return violations;
    });
    for (const theme of ["dark", "light"] as const) {
      if (theme === "light") { await page.locator('.rail-button[aria-label="帮助"]').click(); await page.locator('button[aria-label="切换浅色主题"]').click(); await page.keyboard.press("Escape"); }
      for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.$eval(catalog, element => element.scrollIntoView({ block: "start" }));
        const overflow = await page.$$eval(styleAreas, elements => elements.map(element => {
          const scrollable = ["auto", "scroll"].includes(getComputedStyle(element).overflowX);
          return { label: element.getAttribute("aria-label"), overflow: !scrollable && element.scrollWidth > element.clientWidth + 1 };
        })).then(entries => entries.filter(entry => entry.overflow));
        expect(overflow, `${theme}/${name} 非滚动容器横向溢出：${JSON.stringify(overflow)}`).toEqual([]);
        const pageOverflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
        expect(pageOverflow.document, `${theme}/${name} 页面出现横向滚动：${JSON.stringify(pageOverflow)}`).toBeLessThanOrEqual(pageOverflow.viewport + 1);
        const violations = await sweep();
        if (violations.length) console.log("CONTRAST_VIOLATIONS", theme, name, JSON.stringify(violations));
        expect(violations, `${theme}/${name} 对比度不足`).toEqual([]);
        if (evidence) await page.screenshot({ path: path.join(evidence, `systematic-${theme}-${name}.png`) });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    for (let attempt = 0; attempt < 8; attempt++) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 420000);
