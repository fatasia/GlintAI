import { openInspector } from "./browser-workspace-helpers";
import http from "node:http";
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

let available = false; try { findSystemBrowser(); available = true; } catch { /* do not download browsers */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("replans the original instruction against the latest saved project in a real browser", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-assistant-browser-"));
  const calls: Array<{ kind: "plan" | "edit"; prompt: string }> = [];
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { observed = resolve; });
  const llm = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const system = String(body.messages?.[0]?.content ?? ""), prompt = String(body.messages?.at(-1)?.content ?? "");
      const kind = system.includes("规划器") ? "plan" : "edit"; calls.push({ kind, prompt });
      const editNumber = calls.filter(call => call.kind === "edit").length;
      if (kind === "edit" && editNumber === 1) { observed(); await gate; }
      const result = kind === "plan" ? { steps: [] } : { id: "one", kind: "title", title: editNumber === 1 ? "过期标题" : "重算标题", narration: { text: editNumber === 1 ? "原旁白" : "手动更新旁白" } };
      if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] })); }
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  const vars = ["GLINT_LLM_BASE_URL", "GLINT_LLM_API_KEY", "GLINT_LLM_MODEL", "GLINT_LLM_PROTOCOL", "GLINT_LLM_REASONING_EFFORT"] as const;
  const previous = Object.fromEntries(vars.map(key => [key, process.env[key]]));
  const sessionStore = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); });
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), sessionStore, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => llm.listen(0, "127.0.0.1", resolve));
    process.env.GLINT_LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
    process.env.GLINT_LLM_API_KEY = "local-test-only"; process.env.GLINT_LLM_MODEL = "test-local"; process.env.GLINT_LLM_PROTOCOL = "openai"; delete process.env.GLINT_LLM_REASONING_EFFORT;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(url, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "assistant-browser", title: "重算测试", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "one", kind: "title", title: "原始标题", narration: { text: "原旁白", durationMs: 1000 } },
      { id: "two", kind: "title", title: "第二镜标题", narration: { text: "下一句", durationMs: 1000 } },
    ] };
    await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "资料" })), project);
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await page.locator(".home-resume").click();
    await page.waitForSelector('[aria-label="创作助手"]', { visible: true });
    await page.locator('textarea[aria-label="分镜修改指令"]').fill("让标题更简短");
    await page.locator('[aria-label="创作助手"] button::-p-text(AI 修改本分镜)').click();
    await Promise.race([requested, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("本地模型未收到首次请求")), 8000))]);
    await page.locator('button[aria-controls="glint-inspector"]').click();
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(声音)').click();
    await page.locator('textarea[aria-label="旁白"]').fill("手动更新旁白");
    await page.waitForFunction(async () => (await (await fetch("/api/session/snapshot?projectId=assistant-browser")).json()).snapshot?.document?.scenes?.[0]?.narration?.text === "手动更新旁白", { timeout: 10000 });
    release();
    await page.waitForFunction(() => document.querySelector('[aria-label="创作助手"] [role="alert"]')?.textContent?.includes("工程已变化"), { timeout: 10000 });
    const afterStale = sessionStore.snapshot(project.id).snapshot.document as typeof project;
    expect(afterStale.scenes[0]!.title).toBe("原始标题"); expect(afterStale.scenes[0]!.narration.text).toBe("手动更新旁白");
    if (process.env.GLINT_ASSISTANT_EVIDENCE) {
      await page.$eval('[aria-label="创作助手"]', element => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(process.env.GLINT_ASSISTANT_EVIDENCE, "stale-1280.png") });
    }
    await page.locator('[aria-label="分镜时间线"] button::-p-text(第二镜标题)').click();
    await page.locator('[aria-label="创作助手"] button::-p-text(基于最新工程重新规划)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="创作助手"]')?.textContent?.includes("这一镜已修改"), { timeout: 10000 });
    await page.waitForFunction(async () => (await (await fetch("/api/session/snapshot?projectId=assistant-browser")).json()).snapshot?.document?.scenes?.[0]?.title === "重算标题", { timeout: 10000 });
    const result = sessionStore.snapshot(project.id).snapshot.document as typeof project;
    expect(result.scenes[0]!.title).toBe("重算标题"); expect(result.scenes[0]!.narration.text).toBe("手动更新旁白");
    expect(result.scenes[1]!.title).toBe("第二镜标题");
    expect(calls.map(call => call.kind)).toEqual(["plan", "edit", "plan", "edit"]);
    expect(calls[2]!.prompt).toContain("手动更新旁白"); expect(calls[2]!.prompt).toContain("让标题更简短");
    expect(calls[3]!.prompt).toContain("手动更新旁白"); expect(calls[3]!.prompt).toContain("让标题更简短");
    if (process.env.GLINT_ASSISTANT_EVIDENCE) {
      await page.$eval('[aria-label="创作助手"]', element => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: path.join(process.env.GLINT_ASSISTANT_EVIDENCE, "replanned-1280.png") });
    }
    await page.locator(".editor-close-properties").click();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.$eval('[aria-label="创作助手"]', element => element.scrollIntoView({ block: "center" }));
    const panel = await page.$('[aria-label="创作助手"]'), box = await panel!.boundingBox();
    expect(box && box.width <= 390).toBe(true);
    if (process.env.GLINT_ASSISTANT_EVIDENCE) await page.screenshot({ path: path.join(process.env.GLINT_ASSISTANT_EVIDENCE, "replanned-390.png") });
  } finally {
    release(); await opened?.browser.close(); server.closeAllConnections(); llm.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => llm.close(() => resolve()))]);
    for (const key of vars) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
