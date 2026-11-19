import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

let available = false; try { findSystemBrowser(); available = true; } catch { /* The runner requires an explicit browser. */ }
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
const listen = (server: Server, port = 0) => new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("executes one local workflow, explicitly imports its output and recovers without resubmitting", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the Web app before workflow browser verification");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-comfy-browser-")), library = path.join(root, "media");
  const png = path.join(root, "fixture.png"), privateValue = "WORKFLOW_VALUE_NOT_FOR_RECOVERY_STORAGE";
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=royalblue:s=128x72", "-frames:v", "1", png], { windowsHide: true, timeout: 15_000 });
  const bytes = fs.readFileSync(png), workflow = { "1": { class_type: "Fixture", inputs: { text: privateValue } } };
  const input = path.join(root, "workflow-api.json"); fs.writeFileSync(input, JSON.stringify(workflow));
  let submissions = 0;
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "POST" && url.pathname === "/prompt") {
      submissions++; req.resume(); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ prompt_id: "ui-prompt-1", node_errors: {} })); return;
    }
    if (url.pathname === "/history/ui-prompt-1") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ "ui-prompt-1": { status: { status_str: "success", completed: true }, outputs: { "1": { images: [{ filename: "fixture.png", subfolder: "", type: "output" }] } } } })); return;
    }
    if (url.pathname === "/object_info/Fixture") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ Fixture: { name: "Fixture", input: { required: {} }, output: ["IMAGE"] } })); return; }
    if (url.pathname === "/queue") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ queue_running: [], queue_pending: [] })); return; }
    if (url.pathname === "/view" && url.searchParams.get("filename") === "fixture.png") { res.setHeader("content-type", "image/png"); res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  let app: Server | undefined, opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await listen(upstream);
    const jobs = createMediaJobs(library, {});
    app = createWebServer({ distDir: dist, mediaJobs: jobs, requestLogDir: path.join(root, "logs") }) as Server;
    await listen(app);
    opened = await openCaptureBrowser(1440, 1000);
    const page = opened.page, errors: string[] = [], posts: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    const panel = 'section[aria-label="本地工作流"]';
    const expand = async () => {
      const summary = page.locator('summary::-p-text(本地工作流)');
      await summary.click(); await page.waitForSelector(panel, { visible: true });
    };
    await page.goto(`${origin(app)}/#/library/create`, { waitUntil: "networkidle0" }); await expand();
    await page.locator(`${panel} summary::-p-text(连接本地工作流服务)`).click();
    await page.locator(`${panel} input[aria-label="本地服务地址"]`).fill(origin(upstream));
    const configuration = page.waitForResponse(result => new URL(result.url()).pathname === "/api/media/comfyui/config" && result.request().method() === "POST");
    await page.locator(`${panel} button::-p-text(保存连接)`).click();
    const configured = await configuration; expect(configured.ok()).toBe(true); expect((await configured.json()).configured).toBe(true);
    const file = await page.$(`${panel} input[aria-label="导入工作流 JSON"]`); expect(file).toBeTruthy(); await file!.uploadFile(input);
    await page.waitForFunction((selector, value) => document.querySelector<HTMLTextAreaElement>(`${selector} textarea[aria-label="API 格式工作流"]`)?.value.includes(value), {}, panel, privateValue);
    const validation = page.waitForResponse(result => new URL(result.url()).pathname === "/api/media/comfyui/validate" && result.request().method() === "POST");
    await page.locator(`${panel} button::-p-text(检查节点依赖)`).click();
    const validated = await validation; expect(validated.ok()).toBe(true); expect(await validated.json()).toMatchObject({ ok: true, checked: 1, missing: [], submitted: false });
    expect(submissions).toBe(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("glint.comfyui-task") ?? "{}"))).toEqual({});
    await page.click(`${panel} input[type="checkbox"]`);
    const submission = page.waitForResponse(result => new URL(result.url()).pathname === "/api/media/comfyui/submit" && result.request().method() === "POST");
    await page.locator(`${panel} button::-p-text(执行工作流)`).click();
    const submitted = await submission; expect(submitted.status()).toBe(202);
    const task = await submitted.json() as { taskId: string }; expect(task.taskId).toBeTruthy();
    await page.waitForSelector(`${panel} select[aria-label="工作流输出"]`, { visible: true });
    await page.select(`${panel} select[aria-label="工作流输出"]`, "0");
    expect(submissions).toBe(1);
    const imported = page.waitForResponse(result => new URL(result.url()).pathname === `/api/media/comfyui/import/${task.taskId}` && result.request().method() === "POST");
    await page.locator(`${panel} button::-p-text(导入素材库)`).click();
    const importedResponse = await imported; expect(importedResponse.ok()).toBe(true);
    const asset = await importedResponse.json() as { assetName: string; assetUrl: string; sha256: string };
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(library, asset.assetName))).toEqual(bytes);
    const downloaded = await fetch(new URL(asset.assetUrl, origin(app))); expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(jobs.library().some((item: { name: string }) => item.name === asset.assetName)).toBe(true);
    const port = (app.address() as AddressInfo).port; await close(app); app = undefined;
    const restarted = createMediaJobs(library, {});
    expect(restarted.comfyui.configured()).toBe(true);
    app = createWebServer({ distDir: dist, mediaJobs: restarted, requestLogDir: path.join(root, "logs-restarted") }) as Server;
    await listen(app, port);
    await page.reload({ waitUntil: "networkidle0" }); await expand();
    const recovered = page.waitForResponse(result => new URL(result.url()).pathname === `/api/media/comfyui/status/${task.taskId}`);
    await page.locator(`${panel} button::-p-text(查询回执与进度)`).click();
    const recovery = await recovered; expect(recovery.ok()).toBe(true); expect((await recovery.json()).taskId).toBe(task.taskId);
    await page.waitForSelector(`img[alt="${asset.assetName}"]`);
    expect(submissions).toBe(1);
    expect(posts.filter(route => route === "/api/media/submit")).toEqual([]);
    expect(await page.evaluate(value => Object.values(localStorage).some(item => item.includes(value)), privateValue)).toBe(false);
    const records = fs.readdirSync(library).filter(name => name.endsWith(".json")).map(name => fs.readFileSync(path.join(library, name), "utf8"));
    expect(records.some(record => record.includes(privateValue))).toBe(false);
    for (const width of [1440, 1024, 390]) {
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (process.env.GLINT_UI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.GLINT_UI_SCREENSHOT_DIR, { recursive: true });
        await (await page.$(panel))!.screenshot({ path: path.join(process.env.GLINT_UI_SCREENSHOT_DIR, `local-workflow-${width}.png`) as `${string}.png` });
      }
    }
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); if (app) await close(app); if (upstream.listening) await close(upstream); fs.rmSync(root, { recursive: true, force: true }); }
}, 90_000);
