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

let available = false; try { findSystemBrowser(); available = true; } catch { /* no download */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("freezes a named style, reloads it from storage, and keeps tokens through later editing", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build web before running this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-style-freeze-ui-")), mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir);
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page, errors: string[] = []; page.on("pageerror", error => errors.push(String(error)));
    const project = parseProject({ schemaVersion: 1, id: "style-freeze-ui", title: "Style", aspect: "16:9", theme: "bold-poster", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "原有工程", narration: { text: "原有旁白", durationMs: 2000 } }] });
    await page.evaluateOnNewDocument(value => { if (!localStorage.getItem("glint.workspace")) localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "测试资料", theme: "bold-poster", project: value })); }, project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]'); await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('[aria-label="风格包"] summary'); await page.$eval('[aria-label="风格包"] summary', element => (element as HTMLElement).click());
    await page.locator('[aria-label="风格详情"] button::-p-text(固定当前风格参数)').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("glint.workspace") || "null")?.project?.theme?.glintStyleSnapshot?.name === "bold-poster", { timeout: 15000 });
    await page.waitForFunction(async () => { const result = await fetch('/api/session/snapshot?projectId=style-freeze-ui').then(r => r.json()); return result.snapshot?.document?.theme?.glintStyleSnapshot?.name === "bold-poster"; }, { timeout: 15000 });
    const frozen = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.workspace") || "null").project.theme);
    expect(frozen.glintStyleSnapshot.version).toBe("1.0.0"); expect(frozen.colors).toEqual(frozen.glintStyleSnapshot.captured.colors);
    if (process.env.GLINT_STYLE_FREEZE_EVIDENCE) { await page.$eval('[aria-label="风格包"]', el => el.scrollIntoView({ block: "start" })); await page.screenshot({ path: path.join(process.env.GLINT_STYLE_FREEZE_EVIDENCE, "freeze.png") }); }
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    expect(await page.$eval('select[aria-label="风格"]', el => (el as HTMLSelectElement).value)).toBe("bold-poster");
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(内容)').click(); await page.waitForSelector('textarea[aria-label="title"]', { visible: true });
    await page.$eval('textarea[aria-label="title"]', el => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!; setter.call(el, "继续编辑"); el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForFunction(async () => { const result = await fetch('/api/session/snapshot?projectId=style-freeze-ui').then(r => r.json()); return result.snapshot?.document?.scenes?.[0]?.title === "继续编辑"; }, { timeout: 15000 });
    const saved = await page.evaluate(async () => (await fetch('/api/session/snapshot?projectId=style-freeze-ui').then(r => r.json())).snapshot.document);
    expect(saved.theme).toEqual(frozen); expect(saved.scenes[0].title).toBe("继续编辑"); expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);
