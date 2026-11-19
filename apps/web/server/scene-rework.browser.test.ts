import { openInspector } from "./browser-workspace-helpers";
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
// @ts-expect-error JS server exercised through real HTTP.
import { createWebServer } from "./index.mjs";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("prevents cross-tab duplicate submissions and rejects a stale generated candidate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-rework-browser-")), image = path.join(root, "image.png");
  fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>(done => { release = done; }), requested = new Promise<void>(done => { observed = done; });
  const submissions: Array<Record<string, unknown>> = [];
  const mediaJobs = {
    configured: () => true, protocol: () => "skills", library: () => [{ name: "old.png" }, { name: "new.png" }, { name: "hero.png" }],
    asset: (name: string) => ["old.png", "new.png", "hero.png"].includes(name) ? image : null,
    models: async () => [{ id: "m1", name: "测试模型" }],
    submit: async (input: Record<string, unknown>) => { submissions.push(input); return { taskId: "task-test" }; },
    status: async () => { observed(); await gate; return { taskId: "task-test", isFinal: true, state: "success", assetUrl: "/api/media/assets/new.png" }; },
  };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs, sessionStore: new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); }), requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    await page.goto(url, { waitUntil: "networkidle0" });
    const project = { schemaVersion: 1, id: "rework-browser", title: "单镜测试", aspect: "16:9", knowledgeSources: [], assets: [{ id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝色外套", refs: ["assets/hero.png"] }], scenes: [
      { id: "one", kind: "image", src: "assets/old.png", assetRefs: [{ assetId: "hero", version: "v1" }], narration: { text: "原旁白", durationMs: 1000 } },
      { id: "two", kind: "title", title: "第二镜", narration: { text: "下一句", durationMs: 1000 } },
    ] };
    await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "资料" })), project);
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click(); await page.locator('[aria-label="为这个镜头生成素材"] summary').click();
    await page.waitForSelector('select[aria-label="生成素材模型"] option[value="m1"]');
    expect(await page.$eval('[aria-label="镜头引用资产"]', element => element.textContent)).toContain("未选择参考图时不会发送图片");
    // Both tabs are opened before the first receipt is written, so the second
    // submission exercises the browser's actual cross-tab Web Lock.
    const second = await opened.browser.newPage();
    await second.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await second.goto(url, { waitUntil: "networkidle0" });
    await second.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(second);
    await second.locator('[aria-label="属性面板"] button::-p-text(生成)').click();
    await second.locator('[aria-label="为这个镜头生成素材"] summary').click();
    await second.waitForSelector('select[aria-label="生成素材模型"] option[value="m1"]');
    await second.$eval('[aria-label="为这个镜头生成素材"] input[type="checkbox"]', element => (element as HTMLInputElement).click());
    await page.$eval('[aria-label="为这个镜头生成素材"] input[type="checkbox"]', element => (element as HTMLInputElement).click());
    const firstState = await page.$eval('[aria-label="为这个镜头生成素材"]', element => ({
      text: element.textContent,
      values: [...element.querySelectorAll('input, textarea, select, button')].map(control => ({ tag: control.tagName, label: control.getAttribute('aria-label'), value: (control as HTMLInputElement).value, checked: (control as HTMLInputElement).checked, disabled: (control as HTMLInputElement).disabled, text: control.textContent })),
    }));
    expect(firstState.values.find(control => control.tag === "BUTTON" && control.text?.includes("生成候选"))?.disabled, JSON.stringify(firstState)).toBe(false);
    await page.bringToFront();
    const firstButton = await page.evaluateHandle(() => [...document.querySelectorAll('[aria-label="为这个镜头生成素材"] button')].find(button => button.textContent?.includes("生成候选"))!);
    const firstBox = await firstButton.asElement()!.boundingBox();
    expect(firstBox, "首标签提交按钮应可见").not.toBeNull();
    if (process.env.GLINT_REWORK_EVIDENCE) await page.screenshot({ path: path.join(process.env.GLINT_REWORK_EVIDENCE, "before-submit-1280.png") });
    await Promise.race([firstButton.asElement()!.click(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("首标签鼠标点击超时")), 8000))]);
    await requested;
    await second.bringToFront();
    const secondButton = await second.evaluateHandle(() => [...document.querySelectorAll('[aria-label="为这个镜头生成素材"] button')].find(button => button.textContent?.includes("生成候选"))!);
    await Promise.race([secondButton.asElement()!.click(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("次标签鼠标点击超时")), 8000))]);
    await second.waitForFunction(() => document.querySelector('[aria-label="为这个镜头生成素材"]')?.textContent?.includes("另一个标签页"));
    expect(submissions).toHaveLength(1); expect(String(submissions[0]!.prompt)).toContain("蓝色外套"); expect(submissions[0]!.params).toEqual({});
    await page.bringToFront();
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(声音)').click(); await page.locator('textarea[aria-label="旁白"]').fill("手动修改的新旁白");
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click(); release();
    await page.waitForSelector('img[aria-label="候选生成图片"]', { timeout: 15000 });
    expect(await page.$eval('[aria-label="为这个镜头生成素材"]', element => element.textContent)).toContain("镜头或引用资产已变化");
    expect(await page.$eval('button::-p-text(用候选替换当前镜头)', element => (element as HTMLButtonElement).disabled)).toBe(true);
    if (process.env.GLINT_REWORK_EVIDENCE) await (await page.$('[aria-label="为这个镜头生成素材"]'))!.screenshot({ path: path.join(process.env.GLINT_REWORK_EVIDENCE, "stale-1280.png") });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="为这个镜头生成素材"]'), box = await panel!.boundingBox(); expect(box && box.width <= 390).toBe(true);
    if (process.env.GLINT_REWORK_EVIDENCE) await panel!.screenshot({ path: path.join(process.env.GLINT_REWORK_EVIDENCE, "stale-390.png") });
    expect(submissions).toHaveLength(1);
  } finally { release(); await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);
