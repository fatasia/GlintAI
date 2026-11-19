import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised over HTTP.
import { createWebServer } from "./index.mjs";
let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("protects stale multi-field text proposals and applies one undoable edit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-ai-")), calls: unknown[] = [];
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { requested = resolve; });
  const llm = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")); calls.push(JSON.parse(data.messages.at(-1).content));
    if (calls.length === 1) { requested(); await gate; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ edits: [{ id: "a", text: "新字幕", startMs: 200, durationMs: 1500, color: "#ffcc00", fontSize: 48, align: "center" }] }) } }] }));
  });
  const vars = ["GLINT_LLM_BASE_URL", "GLINT_LLM_API_KEY", "GLINT_LLM_MODEL", "GLINT_LLM_PROTOCOL", "GLINT_LLM_REASONING_EFFORT"] as const;
  const previous = Object.fromEntries(vars.map(key => [key, process.env[key]]));
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => llm.listen(0, "127.0.0.1", resolve));
    process.env.GLINT_LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
    process.env.GLINT_LLM_API_KEY = "local-test"; process.env.GLINT_LLM_MODEL = "local-test"; process.env.GLINT_LLM_PROTOCOL = "openai"; delete process.env.GLINT_LLM_REASONING_EFFORT;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "test-ai", title: "文字测试", fps: 30, width: 1280, height: 720, tracks: [{ id: "t1", kind: "text", name: "字幕", clips: [{ id: "a", kind: "text", text: "原字幕", startMs: 0, durationMs: 2000 }] }] };
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('section[aria-label="剪辑台"]');
    await page.locator('.nle-menu-wrap > summary::-p-text(工程)').click();
    await page.locator('summary::-p-text(AI 文字提案)').click();
    await page.locator('input[aria-label="时间线文字修改要求"]').fill("精简字幕");
    expect(await page.$eval('button::-p-text(生成文字提案)', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('details:has(input[aria-label="时间线文字修改要求"]) input[type="checkbox"]').click();
    await page.locator('button::-p-text(生成文字提案)').click();
    await Promise.race([waiting, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("模型未收到请求")), 10000))]);
    await page.locator('input[aria-label="剪辑标题"]').fill("更新的工程标题");
    release();
    await page.waitForSelector('[aria-label="修改差异预览"]');
    expect(await page.$eval('[aria-label="修改差异预览"] button::-p-text(应用修改)', el => (el as HTMLButtonElement).disabled)).toBe(true);
    await page.locator('[aria-label="修改差异预览"] button::-p-text(取消)').click();
    await page.locator('details:has(input[aria-label="时间线文字修改要求"]) input[type="checkbox"]').click();
    await page.locator('button::-p-text(生成文字提案)').click();
    await page.waitForSelector('[aria-label="修改差异预览"]');
    const text = await page.$eval('[aria-label="修改差异预览"]', el => el.textContent);
    expect(text).toContain("原字幕"); expect(text).toContain("新字幕"); expect(text).toContain("startMs"); expect(text).toContain("durationMs"); expect(text).toContain("#ffcc00"); expect(text).toContain("fontSize");
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual({ instruction: "精简字幕", clips: [{ id: "a", trackId: "t1", text: "原字幕", startMs: 0, durationMs: 2000 }], timelineEndMs: 2000, occupied: [{ trackId: "t1", clips: [{ id: "a", startMs: 0, durationMs: 2000 }] }] });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const box = await (await page.$('[aria-label="修改差异预览"]'))!.boundingBox(); expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await page.locator('[aria-label="修改差异预览"] button::-p-text(应用修改)').click();
    await page.waitForFunction(() => { const clip = JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0]; return clip.text === "新字幕" && clip.startMs === 200 && clip.durationMs === 1500 && clip.color === "#ffcc00" && clip.fontSize === 48 && clip.align === "center"; });
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => { const project = JSON.parse(localStorage.getItem("glint.nle.project.v2")!), clip = project.tracks[0].clips[0]; return project.title === "更新的工程标题" && clip.text === "原字幕" && clip.startMs === 0 && clip.durationMs === 2000 && clip.color === undefined && clip.fontSize === undefined && clip.align === undefined; });
  } finally {
    release();
    await opened?.browser.close(); server.closeAllConnections(); llm.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => llm.close(() => resolve()))]);
    for (const key of vars) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
