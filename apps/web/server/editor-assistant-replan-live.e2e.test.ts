import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JS server exercised via real HTTP.
import { createWebServer } from "./index.mjs";
import { createLlmSettings } from "./llm-settings.mjs";

// EDIT-11 真实模型过期重算浏览器端到端：无本地替身，GLINT_LLM_* 必须显式
// 指向真实网关；断言是行为级（过期提示、手动更新保留、另一镜不变），不是
// 确定性文本。回执先独占预留、结束写回；失败或结果不确定不自动重试。
let available = false; try { findSystemBrowser(); available = true; } catch { /* do not download browsers */ }
it.skipIf(process.env.GLINT_TEXT_REPLAN_LIVE_E2E !== "1" || !available)("replans a stale edit against the live model in a real browser", async () => {
  const receipt = process.env.GLINT_TEXT_REPLAN_LIVE_RECEIPT;
  const required = ["GLINT_LLM_BASE_URL", "GLINT_LLM_API_KEY", "GLINT_LLM_MODEL"] as const;
  for (const key of required) if (!process.env[key]) throw new Error(`Live replan test requires ${key}`);
  if (!receipt || !path.isAbsolute(receipt)) throw new Error("Live replan test requires an absolute new receipt path");
  fs.writeFileSync(receipt, JSON.stringify({ state: "reserved", at: new Date().toISOString() }), { flag: "wx" });
  const record = (result: unknown) => { try { fs.writeFileSync(receipt, JSON.stringify(result, null, 2)); } catch { /* receipt is best-effort evidence */ } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-replan-live-"));
  const previous = Object.fromEntries(["GLINT_LLM_PROTOCOL", "GLINT_LLM_REASONING_EFFORT", "GLINT_BROWSER_UI_TEST", "GLINT_ASSISTANT_EVIDENCE"].map(key => [key, process.env[key]]));
  delete process.env.GLINT_LLM_REASONING_EFFORT;
  const sessionStore = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); });
  const server = createWebServer({ distDir: fileURLToPath(new URL("../dist", import.meta.url)), sessionStore, requestLogDir: path.join(root, "logs"), llmSettings: createLlmSettings(process.env, null) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const started = Date.now();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(url, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "replan-live", title: "重算测试", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "one", kind: "title", title: "这是一个特别长的原始标题需要被精简", narration: { text: "原旁白", durationMs: 1000 } },
      { id: "two", kind: "title", title: "第二镜标题", narration: { text: "下一句", durationMs: 1000 } },
    ] };
    await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "资料" })), project);
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await page.locator('[aria-label="属性面板"] button::-p-text(改稿)').click();
    await page.locator('input[aria-label="分镜修改指令"]').fill("请把第一镜标题精简到十个字以内，保持主题；旁白与其他镜头不要修改。");
    await page.locator('[aria-label="创作助手"] button::-p-text(AI 修改本分镜)').click();
    // 首轮真实模型在途时制造工程变化。
    await page.locator('[aria-label="属性面板"] button::-p-text(声音)').click();
    await page.locator('textarea[aria-label="旁白"]').fill("手动更新旁白");
    await page.waitForFunction(async () => (await (await fetch("/api/session/snapshot?projectId=replan-live")).json()).snapshot?.document?.scenes?.[0]?.narration?.text === "手动更新旁白", { timeout: 10000 });
    await page.locator('[aria-label="属性面板"] button::-p-text(改稿)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="创作助手"] [role="alert"]')?.textContent?.includes("工程已变化"), { timeout: 90_000 });
    const afterStale = sessionStore.snapshot(project.id).snapshot.document as typeof project;
    expect(afterStale.scenes[0]!.title).toBe("这是一个特别长的原始标题需要被精简");
    expect(afterStale.scenes[0]!.narration.text).toBe("手动更新旁白");
    if (process.env.GLINT_ASSISTANT_EVIDENCE) {
      await page.$eval('[aria-label="创作助手"]', element => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(process.env.GLINT_ASSISTANT_EVIDENCE, "stale-1280.png") });
    }
    // 切到第二镜触发「基于最新工程重新规划」，真实模型按原指令对最新工程重算。
    await page.locator('[aria-label="分镜时间线"] button::-p-text(two)').click();
    await page.locator('[aria-label="创作助手"] button::-p-text(基于最新工程重新规划)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="创作助手"]')?.textContent?.includes("这一镜已修改"), { timeout: 120_000 });
    const result = sessionStore.snapshot(project.id).snapshot.document as typeof project;
    expect(result.scenes[0]!.title).not.toBe("这是一个特别长的原始标题需要被精简");
    expect(result.scenes[0]!.narration.text).toBe("手动更新旁白");
    expect(result.scenes[1]!.title).toBe("第二镜标题");
    expect(result.scenes[1]!.narration.text).toBe("下一句");
    if (process.env.GLINT_ASSISTANT_EVIDENCE) {
      await page.$eval('[aria-label="创作助手"]', element => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(process.env.GLINT_ASSISTANT_EVIDENCE, "replanned-1280.png") });
    }
    record({ state: "completed", elapsedMs: Date.now() - started, replannedTitle: result.scenes[0]!.title, narrationKept: result.scenes[0]!.narration.text, secondSceneUntouched: result.scenes[1]!.title === "第二镜标题" });
  } catch (error) {
    record({ state: "failed", elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await opened?.browser.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of Object.keys(previous)) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
