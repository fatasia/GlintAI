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
import { createLlmSettings } from "./llm-settings.mjs";

// EDIT-12 真实模型组合指令质量：一条指令同时要求文字精简、起点移动与颜色
// 变更，验证差异预览→应用→撤销全链在真实网关模型上成立。无本地替身；回执
// 先独占预留、结束写回，失败或结果不确定不自动重试。
let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_NLE_PROPOSAL_LIVE_E2E !== "1" || !available)("applies a live combined text/time/color proposal with preview and undo", async () => {
  const receipt = process.env.GLINT_NLE_PROPOSAL_LIVE_RECEIPT;
  for (const key of ["GLINT_LLM_BASE_URL", "GLINT_LLM_API_KEY", "GLINT_LLM_MODEL"] as const) if (!process.env[key]) throw new Error(`Live proposal test requires ${key}`);
  if (!receipt || !path.isAbsolute(receipt)) throw new Error("Live proposal test requires an absolute new receipt path");
  fs.writeFileSync(receipt, JSON.stringify({ state: "reserved", at: new Date().toISOString() }), { flag: "wx" });
  const record = (result: unknown) => { try { fs.writeFileSync(receipt, JSON.stringify(result, null, 2)); } catch { /* receipt is best-effort evidence */ } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-proposal-live-"));
  const previous = Object.fromEntries(["GLINT_LLM_PROTOCOL", "GLINT_LLM_REASONING_EFFORT", "GLINT_BROWSER_UI_TEST"].map(key => [key, process.env[key]]));
  delete process.env.GLINT_LLM_REASONING_EFFORT;
  const server = createWebServer({ distDir: fileURLToPath(new URL("../dist", import.meta.url)), requestLogDir: path.join(root, "logs"), llmSettings: createLlmSettings(process.env, null) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const started = Date.now();
  let behaviour: Record<string, unknown> = { appliedText: "", appliedDurationMs: null, appliedStartMs: null, appliedColor: null };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "proposal-live", title: "文字测试", fps: 30, width: 1280, height: 720, tracks: [{ id: "t1", kind: "text", name: "字幕", clips: [
      { id: "a", kind: "text", text: "这是一句需要精简的原始字幕文案", startMs: 0, durationMs: 2000 },
      { id: "b", kind: "text", text: "第二句保持不变", startMs: 2000, durationMs: 1500 },
    ] }] };
    await page.evaluate(value => localStorage.setItem("glint.nle.project.v2", JSON.stringify(value)), project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="剪辑台"]');
    await page.locator('summary::-p-text(AI 文字提案)').click();
    await page.locator('input[aria-label="时间线文字修改要求"]').fill("只修改第一句：文字精简到八个字以内，起点移动到 500 毫秒，颜色改成 #e07b39；第二句与其他字段不要动。");
    await page.locator('details:has(input[aria-label="时间线文字修改要求"]) input[type="checkbox"]').click();
    await page.locator('button::-p-text(生成文字提案)').click();
    await page.waitForSelector('[aria-label="修改差异预览"]', { timeout: 120_000 });
    const preview = await page.$eval('[aria-label="修改差异预览"]', el => el.textContent);
    expect(preview).toContain("这是一句需要精简的原始字幕文案");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const box = await (await page.$('[aria-label="修改差异预览"]'))!.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    if (process.env.GLINT_NLE_PROPOSAL_EVIDENCE) {
      await page.$eval('[aria-label="修改差异预览"]', element => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(process.env.GLINT_NLE_PROPOSAL_EVIDENCE, "proposal-preview-1280.png") });
    }
    await page.locator('[aria-label="修改差异预览"] button::-p-text(应用修改)').click();
    await page.waitForFunction(() => {
      const clips = JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips;
      return clips[0].text !== "这是一句需要精简的原始字幕文案" && clips[1].text === "第二句保持不变";
    }, { timeout: 10000 });
    const applied = await page.evaluate(() => JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips);
    const first = applied[0], second = applied[1];
    behaviour = {
      textShortened: typeof first.text === "string" && first.text.length <= 8 && first.text !== "这是一句需要精简的原始字幕文案",
      startMsMoved: first.startMs === 500,
      colorApplied: first.color === "#e07b39",
      appliedDurationMs: first.durationMs,
      durationDisclosed: preview.includes("durationMs") && preview.includes("1500") === (first.durationMs === 1500),
      secondUntouched: second.text === "第二句保持不变" && second.startMs === 2000 && second.color === undefined,
    };
    await page.locator('button[aria-label="撤销"]').click();
    await page.waitForFunction(() => {
      const clip = JSON.parse(localStorage.getItem("glint.nle.project.v2")!).tracks[0].clips[0];
      return clip.text === "这是一句需要精简的原始字幕文案" && clip.startMs === 0 && clip.color === undefined;
    }, { timeout: 10000 });
    behaviour.appliedText = first.text;
    record({ state: "completed", elapsedMs: Date.now() - started, ...behaviour });
    expect(behaviour.textShortened, `text: ${first.text}`).toBe(true);
    expect(behaviour.startMsMoved, `startMs: ${first.startMs}`).toBe(true);
    expect(behaviour.colorApplied, `color: ${first.color}`).toBe(true);
    expect(behaviour.secondUntouched).toBe(true);
  } catch (error) {
    record({ state: "failed", elapsedMs: Date.now() - started, ...behaviour, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await opened?.browser.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(previous)) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
