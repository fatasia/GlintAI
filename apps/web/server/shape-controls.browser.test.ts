import { openInspector } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit download */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("edits animated shape parameters in the built editor and restores the draft", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build web before running this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-shape-controls-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const project = parseProject({ schemaVersion: 1, id: "shape-ui", title: "Shape", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "形状", narration: { text: "形状", durationMs: 2000 }, elements: [{ id: "box", kind: "rect", x: 0.5, y: 0.5, w: 0.3, h: 0.2, fill: "#112233" }] }] });
    await page.evaluateOnNewDocument(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", project: value })), project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('[aria-label="对象与关键帧"] input[aria-label="色块宽度"]', { visible: true });
    const change = async (label: string, value: string) => page.$eval(`input[aria-label="${label}"]`, (element, next) => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(element, next); element.dispatchEvent(new Event("input", { bubbles: true })); }, value);
    await change("色块宽度", "60"); await change("对象旋转", "45"); await change("对象缩放", "1.5");
    await page.waitForFunction(() => { const element = document.querySelector<HTMLElement>('[aria-label="对象 box"]'); return Boolean(element && element.style.width === "60%" && element.style.transform.includes("rotate(45deg)") && element.style.transform.includes("scale(1.5)")); });
    await page.waitForFunction(() => { const scene = JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.scenes?.[0]; return scene?.elements?.[0]?.w === 0.6 && scene?.tracks?.some((t: { property: string }) => t.property === "rotate"); }, { timeout: 15000 });
    if (process.env.GLINT_SHAPE_EVIDENCE) {
      await page.$eval('[aria-label="镜头画布"]', el => el.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(process.env.GLINT_SHAPE_EVIDENCE, "desktop.png") });
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="对象与关键帧"]');
    const layout = await panel!.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, offenders: [...el.querySelectorAll<HTMLElement>("*")].filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).slice(0, 6).map(child => ({ text: child.textContent?.slice(0, 40), html: child.outerHTML.slice(0, 200), width: child.getBoundingClientRect().width })) }));
    expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width + 1);
    if (process.env.GLINT_SHAPE_EVIDENCE) { await page.$eval('[aria-label="对象与关键帧"]', el => el.scrollIntoView({ block: "start" })); await page.screenshot({ path: path.join(process.env.GLINT_SHAPE_EVIDENCE, "mobile.png") }); }
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
