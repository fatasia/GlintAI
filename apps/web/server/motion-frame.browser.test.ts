import { openInspector, openRestoredProject } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ElementOverlay } from "../../../packages/video/src/components/ElementOverlay";
import { renderNative } from "../../studio/scripts/native-render";
const studioRequire = createRequire(new URL("../../studio/package.json", import.meta.url));
const puppeteer = studioRequire("puppeteer-core") as typeof import("../../studio/node_modules/puppeteer-core");

const enabled = process.env.GLINT_MOTION_BROWSER_TEST === "1";
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const root = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-02-")) : "";
const previousEnv = Object.fromEntries(["GLINT_DATA_DIR", "GLINT_SESSION_DIR", "GLINT_CACHE_DIR", "GLINT_STYLE_SAMPLE_DIR"].map(name => [name, process.env[name]]));
let server: Server;
let url: string;
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;

const fixture = (locked = false) => parseProject({
  schemaVersion: 1, id: "motion-browser-fixture", title: "逐帧测试", aspect: "16:9", fps: 30, knowledgeSources: [],
  scenes: [{ id: "one", kind: "title", title: "测试镜头", narration: { text: "测试", durationMs: 2000 }, locked,
    elements: [{ id: "box", kind: "rect", x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: "#112233" }],
    tracks: [{ elementId: "box", property: "x", keyframes: [{ atMs: 0, value: 0.2 }, { atMs: 33, value: 0.3 }, { atMs: 500, value: 0.8, easing: "ease-in" }, { atMs: 2000, value: 0.9 }] },
      { elementId: "box", property: "opacity", keyframes: [{ atMs: 500, value: 0.7, easing: "ease-out" }] }] }],
});

describe.skipIf(!enabled)("MOTION-02 isolated browser acceptance", () => {
  beforeAll(async () => {
    process.env.GLINT_DATA_DIR = path.join(root, "data");
    process.env.GLINT_SESSION_DIR = path.join(root, "sessions");
    process.env.GLINT_CACHE_DIR = path.join(root, "cache");
    process.env.GLINT_STYLE_SAMPLE_DIR = path.join(root, "samples");
    fs.mkdirSync(process.env.GLINT_STYLE_SAMPLE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.GLINT_STYLE_SAMPLE_DIR, "manifest.json"), JSON.stringify({ entries: [] }));
    fs.mkdirSync(process.env.GLINT_DATA_DIR, { recursive: true });
    await build({ configFile: false, root: webRoot, cacheDir: path.join(root, "vite-cache"), plugins: [react()], publicDir: path.join(webRoot, "public"), build: { outDir: path.join(root, "dist"), emptyOutDir: true } });
    const { createWebServer } = await import("./index.mjs");
    const { createMediaJobs } = await import("./media-jobs.mjs");
    server = createWebServer({ distDir: path.join(root, "dist"), mediaJobs: createMediaJobs(path.join(root, "media"), {}), sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }), requestLogDir: path.join(root, "logs"), composeCacheDir: path.join(root, "compose-cache") }) as Server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const samples = await fetch(`${url}/api/style-catalog/samples`);
    expect(samples.status).toBe(200);
    const catalog = await samples.json() as { entries: Array<{ status: string }> };
    expect(catalog.entries.length).toBeGreaterThan(0);
    expect(catalog.entries.every(entry => entry.status === "unavailable")).toBe(true);
    const browserTemp = path.join(root, "browser-temp");
    fs.mkdirSync(browserTemp, { recursive: true });
    browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true, userDataDir: path.join(root, "browser-profile"), env: { ...process.env, TEMP: browserTemp, TMP: browserTemp, TMPDIR: browserTemp }, args: [`--disk-cache-dir=${path.join(root, "browser-cache")}`, "--disable-background-networking", "--disable-component-update"], protocolTimeout: 60000 });
    console.log(`MOTION-02 evidence and isolated data: ${root}`);
  }, 240_000);
  afterAll(async () => {
    try {
      try { await browser?.close(); }
      finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    } finally { for (const [name, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  }, 30_000);

  for (const width of [1280, 390]) it(`moves, rejects collisions and boundaries, then restores at width ${width}`, async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors: string[] = [], failed: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("response", response => { if (response.status() >= 400 && new URL(response.url()).origin === url) failed.push(`${response.status()} ${response.url()}`); });
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    try {
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.evaluate(project => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", project })), fixture());
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector('[aria-label="共享工程编辑"]', { timeout: 20000 });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.waitForSelector('[aria-label="对象与关键帧"]', { visible: true });
      const panel = '[aria-label="对象与关键帧"]';
      const move = (direction: "前" | "后", property = "x") => page.locator(`${panel} button[aria-label="${property} 关键帧${direction}移一帧"]`).click();
      const jump = (time: string) => page.locator(`${panel} button[title="跳到 ${time}s"]`).click();
      const status = () => page.$eval(`${panel} [role="status"]`, el => el.textContent ?? "");
      const scene = () => page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[0]);
      const waitKeys = (times: number[]) => page.waitForFunction(expected => {
        const s = JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[0];
        return JSON.stringify(s?.tracks?.find((t: {property: string}) => t.property === "x")?.keyframes.map((k: {atMs: number}) => k.atMs)) === JSON.stringify(expected);
      }, { timeout: 15000 }, times);
      await move("前");
      expect(await status()).toContain("开始之前");
      await move("后");
      expect(await status()).toContain("已有同属性关键帧");
      await jump("2.00"); await move("后");
      expect(await status()).toContain("结束之后");
      expect((await scene()).tracks).toEqual(fixture().scenes[0]!.tracks);
      await jump("0.50"); await move("后");
      expect(await status()).toContain("0.533 秒");
      await waitKeys([0, 33, 533, 2000]);
      let saved = await scene();
      expect(saved.tracks[0].keyframes[2]).toEqual({ atMs: 533, value: 0.8, easing: "ease-in" });
      expect(saved.tracks[1].keyframes[0]).toEqual({ atMs: 500, value: 0.7, easing: "ease-out" });
      await page.screenshot({ path: path.join(root, `motion-${width}-moved.png`) });
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.waitForSelector(`${panel} button[title="跳到 0.53s"]`, { visible: true });
      await jump("0.53"); await move("前");
      expect(await status()).toContain("0.500 秒");
      await waitKeys([0, 33, 500, 2000]);
      saved = await scene(); expect(saved.tracks[0].keyframes[2]).toEqual({ atMs: 500, value: 0.8, easing: "ease-in" });
      await move("后", "opacity");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[0]?.tracks?.find((t: {property: string}) => t.property === "opacity")?.keyframes?.[0]?.atMs === 533, { timeout: 15000 });
      saved = await scene(); expect(saved.tracks[1].keyframes[0]).toEqual({ atMs: 533, value: 0.7, easing: "ease-out" });
      await jump("0.50");
      await page.$eval(`${panel} input[aria-label="水平位置"]`, input => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "65");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[0]?.tracks?.find((t: {property: string}) => t.property === "x")?.keyframes?.find((k: {atMs: number}) => k.atMs === 500)?.value === 0.65, { timeout: 15000 });
      saved = await scene();
      expect(saved.elements[0].y).toBe(0.5);
      expect(saved.tracks.find((t: {property: string}) => t.property === "opacity").keyframes[0].atMs).toBe(533);
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.waitForSelector(`${panel} button[title="跳到 0.50s"]`, { visible: true });
      await jump("0.50");
      expect(await page.$eval(`${panel} input[aria-label="水平位置"]`, (input: HTMLInputElement) => input.value)).toBe("65");
      const layout = await page.$eval(panel, el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(layout.scroll, `panel overflow ${JSON.stringify(layout)}`).toBeLessThanOrEqual(layout.client + 1);
      expect(errors).toEqual([]); expect(failed).toEqual([]);
    } finally {
      await page.screenshot({ path: path.join(root, `motion-${width}-final.png`) }).catch(() => {});
      await context.close();
    }
  }, 120_000);

  for (const width of [1280, 390]) it(`edits exact keyframe time with isolated browser at ${width}`, async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    const errors: string[] = [], failures: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("response", response => { if (response.status() >= 400 && new URL(response.url()).origin === url) failures.push(`${response.status()} ${response.url()}`); });
    try {
      await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "networkidle0" });
      const project = fixture();
      project.scenes[0]!.tracks = project.scenes[0]!.tracks!.filter(track => track.property === "x");
      await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "隔离测试", project: value })), project);
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      const panel = '[aria-label="对象与关键帧"]';
      await page.locator(`${panel} button[title="跳到 0.50s"]`).click();
      const input = '[aria-label="x 关键帧时间"]';
      await page.locator(input).fill("33");
      await page.locator(`${panel} form button::-p-text(移动到时间)`).click();
      expect(await page.$eval(`${panel} [role="status"]`, el => el.textContent)).toContain("已有同属性关键帧");
      await page.locator(input).fill("750");
      await page.locator(`${panel} form button::-p-text(移动到时间)`).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace")!).project.scenes[0].tracks[0].keyframes[2].atMs === 750);
      expect(await page.$eval(`${panel} [role="status"]`, el => el.textContent)).toContain("0.750 秒");
      await page.screenshot({ path: path.join(root, `exact-${width}.png`) });
      expect(await page.$eval(panel, el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.locator(`${panel} button[title="跳到 0.75s"]`).click();
      expect(await page.$eval(input, (el: HTMLInputElement) => el.value)).toBe("750");
      const saved = parseProject(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project));
      expect(saved.scenes[0]!.tracks![0]!.keyframes[2]).toEqual({ atMs: 750, value: 0.8, easing: "ease-in" });
      if (width === 1280) {
        const source = path.join(root, "exact-project.json"), output = path.join(root, "exact.mp4");
        fs.writeFileSync(source, JSON.stringify(saved));
        const result = await renderNative({ projectPath: source, output, fast: true, tts: "mock", music: "off", noCache: true });
        expect(result.metrics).toMatchObject({ backend: "native-svg", frames: 60 });
        const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_frames", "-of", "json", output], { encoding: "utf8", windowsHide: true });
        expect(probe.status, probe.stderr).toBe(0);
        expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({ codec_name: "h264", nb_frames: "60" });
        const images: string[] = [];
        for (const frame of [0, 23]) {
          const still = path.join(root, `exact-frame-${frame}.png`);
          const extract = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-vf", `select=eq(n\\,${frame})`, "-vsync", "0", "-frames:v", "1", still], { encoding: "utf8", windowsHide: true });
          expect(extract.status, extract.stderr).toBe(0);
          images.push(fs.readFileSync(still).toString("base64"));
        }
        const centers = await page.evaluate(async sources => Promise.all(sources.map(async source => {
          const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
          let count = 0, sum = 0;
          for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
            const i = (y * image.width + x) * 4;
            if (Math.abs(pixels[i]! - 17) < 8 && Math.abs(pixels[i + 1]! - 34) < 8 && Math.abs(pixels[i + 2]! - 51) < 8) { count++; sum += x; }
          }
          return { count, center: sum / count };
        })), images);
        expect(centers[0]!.count).toBeGreaterThan(1000); expect(centers[1]!.count).toBeGreaterThan(1000);
        expect(centers[1]!.center - centers[0]!.center).toBeGreaterThan(300);
      }
      expect(errors).toEqual([]); expect(failures).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);

  it("seeks the real preview when the object playhead jumps", async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.evaluate(project => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", project })), fixture());
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      const panel = '[aria-label="对象与关键帧"]';
      await page.waitForSelector(`${panel} button[title="跳到 0.50s"]`, { visible: true });
      const overlay = '[aria-label="作品工作区"] div[style*="background: rgb(17, 34, 51)"]';
      await page.waitForSelector(overlay);
      await page.locator(`${panel} button[title="跳到 0.00s"]`).click();
      await page.waitForFunction(selector => (document.querySelector(selector) as HTMLElement | null)?.style.left === "20%", {}, overlay);
      await page.screenshot({ path: path.join(root, "preview-seek-start.png") });
      await page.locator(`${panel} button[title="跳到 0.50s"]`).click();
      await page.waitForFunction(selector => (document.querySelector(selector) as HTMLElement | null)?.style.left === "80%", {}, overlay);
      await page.screenshot({ path: path.join(root, "preview-seek-keyframe.png") });
      await page.locator(`${panel} button[title="跳到 2.00s"]`).click();
      await page.waitForFunction(selector => {
        const left = parseFloat((document.querySelector(selector) as HTMLElement | null)?.style.left ?? "0");
        return left > 89 && left < 90;
      }, {}, overlay);
    } finally { await context.close(); }
  }, 60_000);

  it("edits path bounds and preserves morph preview, undo and reload", async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    const line = { id: "line", kind: "path" as const, x: .5, y: .5, w: 1, h: 1, d: "M0 0 L80 80", viewBox: [100, 100] as [number, number], stroke: "#ff0000", strokeWidth: 4 };
    const project = parseProject({ ...fixture(), id: "path-bounds-fixture", scenes: [
      { id: "one", kind: "title", title: "一", narration: { text: "一", durationMs: 2000 }, elements: [line] },
      { id: "two", kind: "title", title: "二", narration: { text: "二", durationMs: 2000 }, transition: { in: "shape-morph", durationMs: 600 }, elements: [{ ...line, d: "M10 10 L90 90", stroke: "#0000ff" }] },
    ] });
    const errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: "networkidle0" });
      await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "路径", project: value })), project);
      await page.reload({ waitUntil: "networkidle0" });
      await openRestoredProject(page); await page.locator('[aria-label="分镜时间线"] [role="tab"]:nth-of-type(2)').click();
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      const canvas = '[aria-label="镜头画布"]', object = `${canvas} [aria-label="对象 line"]`;
      await page.waitForSelector(object, { visible: true });
      expect(await page.$eval(`${object} path`, el => el.getAttribute("d"))).toBe("M0 0 L80 80");
      const slider = await page.$('input[aria-label="播放头"]'); await slider!.focus(); await page.keyboard.press("Home");
      for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => (document.querySelector('input[aria-label="播放头"]') as HTMLInputElement)?.value === "300");
      expect(await page.$eval(`${object} path`, el => el.getAttribute("d"))).toBe("M5 5 L85 85");
      await page.$eval('input[aria-label="路径宽度"]', input => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "50"); input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[1]?.elements?.[0]?.w === .5);
      await page.$eval('input[aria-label="路径高度"]', input => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "40"); input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[1]?.elements?.[0]?.h === .4);
      expect(await page.$eval(object, (el: SVGElement) => el.style.width)).toBe("75%");
      expect(await page.$eval(object, (el: SVGElement) => el.style.height)).toBe("70%");
      await page.screenshot({ path: path.join(process.env.GLINT_MOTION_EVIDENCE ?? root, "path-bounds-desktop.png") });
      await page.locator('button[aria-label="撤销"]').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[1]?.elements?.[0]?.h === 1);
      await page.locator('button[aria-label="撤销"]').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[1]?.elements?.[0]?.w === 1);
      await page.locator('button[aria-label="重做"]').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[1]?.elements?.[0]?.w === .5);
      await page.locator('button[aria-label="重做"]').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.scenes?.[1]?.elements?.[0]?.h === .4);
      await page.reload({ waitUntil: "networkidle0" });
      await openRestoredProject(page); await page.locator('[aria-label="分镜时间线"] [role="tab"]:nth-of-type(2)').click();
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.waitForSelector('input[aria-label="路径宽度"]');
      expect(await page.$eval('input[aria-label="路径宽度"]', (el: HTMLInputElement) => el.value)).toBe("50");
      expect(await page.$eval('input[aria-label="路径高度"]', (el: HTMLInputElement) => el.value)).toBe("40");
      const saved = parseProject(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project));
      const source = path.join(root, "edited-morph.json"), output = path.join(root, "edited-morph.mp4");
      fs.writeFileSync(source, JSON.stringify(saved, null, 2));
      const rendered = await renderNative({ projectPath: source, output, fast: true, tts: "mock", music: "off", noCache: true });
      expect(rendered.metrics).toMatchObject({ backend: "native-svg", width: 960, height: 540, frames: 120 });
      const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_frames", "-of", "json", output], { encoding: "utf8", windowsHide: true });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({ codec_name: "h264", width: 960, height: 540, nb_frames: "120" });
      const compare = await context.newPage(); await compare.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
      try {
        for (const [frame, time] of [[60, 0], [69, 300], [78, 600]] as const) {
          const still = path.join(root, `video-${time}.png`);
          const extract = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-vf", `select=eq(n\\,${frame})`, "-vsync", "0", "-frames:v", "1", still], { encoding: "utf8", windowsHide: true });
          expect(extract.status, extract.stderr).toBe(0); expect(fs.existsSync(still)).toBe(true);
          const overlay = renderToStaticMarkup(React.createElement(ElementOverlay, { scene: saved.scenes[1]!, previousScene: saved.scenes[0], timeMs: time, size: .5 }));
          await compare.setContent(`<body style="margin:0;background:white">${overlay}</body>`);
          const preview = await compare.screenshot({ encoding: "base64" });
          const video = fs.readFileSync(still).toString("base64");
          const bounds = await compare.evaluate(async images => {
            const read = async (encoded: string) => {
              const img = new Image(); img.src = `data:image/png;base64,${encoded}`; await img.decode();
              const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 540;
              const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
              const pixels = ctx.getImageData(0, 0, 960, 540).data;
              let minX = 960, minY = 540, maxX = -1, maxY = -1, count = 0;
              for (let y = 50; y < 480; y++) for (let x = 200; x < 760; x++) {
                const i = (y * 960 + x) * 4, r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
                if (Math.max(r, b) > 90 && Math.max(r, b) > g + 55) { minX = Math.min(x, minX); maxX = Math.max(x, maxX); minY = Math.min(y, minY); maxY = Math.max(y, maxY); count++; }
              }
              return { minX, maxX, minY, maxY, count };
            };
            return Promise.all(images.map(read));
          }, [preview, video]);
          expect(bounds[0]!.count).toBeGreaterThan(100); expect(bounds[1]!.count).toBeGreaterThan(100);
          for (const key of ["minX", "maxX", "minY", "maxY"] as const) expect(Math.abs(bounds[0]![key] - bounds[1]![key]), `${time}ms ${key}: ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(4);
          const evidence = process.env.GLINT_MOTION_EVIDENCE;
          if (evidence) { fs.writeFileSync(path.join(evidence, `preview-${time}.png`), Buffer.from(preview, "base64")); fs.copyFileSync(still, path.join(evidence, `video-${time}.png`)); }
        }
      } finally { await compare.close(); }
      if (process.env.GLINT_MOTION_EVIDENCE) for (const file of [source, output, `${output}.metrics.json`]) fs.copyFileSync(file, path.join(process.env.GLINT_MOTION_EVIDENCE, path.basename(file)));
      await page.setViewport({ width: 390, height: 844 });
      await page.$eval('input[aria-label="路径宽度"]', el => el.scrollIntoView({ block: "center" }));
      expect(await page.$eval('[aria-label="对象与关键帧"]', el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(process.env.GLINT_MOTION_EVIDENCE ?? root, "path-bounds-mobile.png") });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);

  it("keeps a stroke draft when it cannot finish within the shot", async () => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: "networkidle0" });
      const project = fixture();
      await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "路径验收", project: value })), project);
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.locator('summary::-p-text(手绘与逐笔动画)').click();
      await page.locator('[aria-label="新路径数据"]').fill("M0 0 L100 100");
      await page.locator('[aria-label="新路径绘制时长"]').fill("10000");
      await page.locator('button::-p-text(加入镜头)').click();
      await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent?.includes("超出镜头时长")));
      expect(await page.$eval('[aria-label="新路径数据"]', (el: HTMLTextAreaElement) => el.value)).toBe("M0 0 L100 100");
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project.scenes[0].elements.length)).toBe(1);
      await page.locator('[aria-label="新路径绘制时长"]').fill("1500");
      await page.locator('button::-p-text(加入镜头)').click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace")!).project.scenes[0].elements.length === 2);
      await page.reload({ waitUntil: "networkidle0" });
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace")!).project.scenes[0].elements[1].d)).toBe("M0 0 L100 100");
    } finally { await context.close(); }
  }, 60_000);

  it("prevents keyframe edits in a locked scene", async () => {
    const context = await browser.createBrowserContext(); const page = await context.newPage();
    try {
      await page.setViewport({ width: 1280, height: 900 }); await page.goto(url, { waitUntil: "networkidle0" });
      await page.evaluate(project => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", project })), fixture(true));
      await page.reload({ waitUntil: "networkidle0" });
      await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
      await page.waitForSelector('[aria-label="对象与关键帧"]');
      const disabled = await page.$eval('button[aria-label="x 关键帧后移一帧"]', (el: HTMLButtonElement) => el.matches(":disabled"));
      expect(disabled).toBe(true);
      await page.screenshot({ path: path.join(root, "motion-locked.png") });
    } finally { await context.close(); }
  }, 60_000);
});
