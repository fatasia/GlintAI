import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised by a real browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }
// Opt-in: requires an explicitly fresh production build, never tests an arbitrary old dist.
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("creates, edits, previews and undoes a pack in the built browser UI", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-browser-ui-"));
  const sessions = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "candidate.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const server = createWebServer({ distDir: dist, sessionStore: sessions, mediaJobs: createMediaJobs(mediaDir, {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    // The advanced panel is a native disclosure; click it in page context so
    // Puppeteer's actionability scroll cannot race the long home page.
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("summary")].find(element => element.textContent?.includes("高级编辑"))!.click());
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("summary")].some(element => element.textContent?.includes("从模板开始") && element.getBoundingClientRect().height > 0));
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("summary")].find(element => element.textContent?.includes("从模板开始"))!.click());
    await page.locator('[aria-label="创作包目录"] button').filter(element => element.textContent?.includes("12 秒产品发布")).click();
    await page.evaluate(() => document.querySelector('input[aria-label="产品名称"]')?.scrollIntoView({ block: "center" }));
    await page.locator('input[aria-label="产品名称"]').fill("浏览器验收商品");
    await page.locator('[aria-label="创作库"] input[type="checkbox"]').click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="创作库"] input[type="checkbox"]')?.checked);
    await page.locator('button::-p-text(用这个创作)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="分镜编辑器"]')?.textContent?.includes("3 个分镜"));
    await page.waitForFunction(() => document.querySelector('[aria-label="共享工程编辑"] [role="status"]')?.textContent?.includes("已连接") || document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r0"));
    await page.locator('[aria-label="属性面板"] button::-p-text(声音)').click();
    await page.waitForSelector('input[aria-label="旁白偏移"]');
    await page.locator('[aria-label="属性面板"] button::-p-text(改稿)').click();
    await page.waitForFunction(() => document.body.innerText.includes("剧本质量"));
    await page.locator('input[aria-label="分镜修改指令"]').fill("稍后修改标题，保留其他内容");
    await page.locator('[aria-label="工作区视图"] button::-p-text(创意)').click();
    await page.waitForSelector('[aria-label="镜头画布"] .react-flow__node[data-id="selling-points"]');
    const sellingPoint = await page.evaluate(() => { const el = document.querySelector('[aria-label="镜头画布"] .react-flow__node[data-id="selling-points"]'); const all = [...document.querySelectorAll('[aria-label="镜头画布"] .react-flow__node')].map(n => n.getAttribute('data-id')); if (el) el.scrollIntoView({ block: "center" }); const rect = el ? el.getBoundingClientRect() : null; return { point: rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null, all, hasCanvas: Boolean(document.querySelector('[aria-label="镜头画布"]')) }; });
    if (!sellingPoint.point) throw new Error("selling-points node missing");
    await page.mouse.click(sellingPoint.point.x, sellingPoint.point.y);
    await page.waitForFunction(() => document.querySelector('[aria-label="镜头属性"]')?.textContent?.includes('selling-points'));
    const launchTitle = await page.evaluate(() => { const el = document.querySelector('[aria-label="镜头画布"] .react-flow__node[data-id="launch-title"]'); el?.scrollIntoView({ block: "center" }); const rect = el?.getBoundingClientRect(); return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null; });
    if (!launchTitle) throw new Error("launch-title node missing");
    await page.mouse.click(launchTitle.x, launchTitle.y);
    await page.waitForFunction(() => document.querySelector('[aria-label="镜头属性"]')?.textContent?.includes('launch-title'));
    const node = await page.$('[aria-label="镜头画布"] .react-flow__node[data-id="launch-title"]');
    await node!.scrollIntoView();
    const dragLaunchTitle = async () => {
      const current = await page.$('[aria-label="镜头画布"] .react-flow__node[data-id="launch-title"]');
      const bounds = await current?.boundingBox();
      if (!bounds) throw new Error('Scene card has no visible bounds');
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
      await page.mouse.down();
      await new Promise(resolve => setTimeout(resolve, 80));
      await page.mouse.move(bounds.x + bounds.width / 2 + 60, bounds.y + 70, { steps: 12 });
      await new Promise(resolve => setTimeout(resolve, 120));
      await page.mouse.move(bounds.x + bounds.width / 2 + 61, bounds.y + 71, { steps: 2 });
      await page.mouse.up();
    };
    const boardSaved = () => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('glint.scene-board:')));
    await dragLaunchTitle();
    await new Promise(resolve => setTimeout(resolve, 400));
    // Under parallel CPU load the first press can land before React Flow marks
    // the pointer as a drag; retry once instead of asserting on a lost event.
    if (!(await boardSaved())) await dragLaunchTitle();
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('glint.scene-board:')));
    expect(sessions.snapshot(sessions.list()[0]!.projectId).look.revision).toBe(0);
    await page.locator('[aria-label="镜头画布"] button::-p-text(自动整理)').click();
    if (process.env.GLINT_UI_SCREENSHOT_DIR) {
      const directory = path.resolve(process.env.GLINT_UI_SCREENSHOT_DIR); fs.mkdirSync(directory, { recursive: true });
      await page.locator('[aria-label="镜头画布"] button::-p-text(看全画布)').click();
      await page.screenshot({ path: path.join(directory, 'scene-board-1280.png') as `${string}.png` });
      await page.setViewport({ width: 480, height: 900 });
      await page.waitForSelector('[aria-label="镜头列表"]');
      await page.locator('[aria-label="镜头列表"] button').filter(element => element.textContent?.includes('镜头 1')).click();
      await page.screenshot({ path: path.join(directory, 'scene-board-480.png') as `${string}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.setViewport({ width: 1280, height: 900 });
    }
    await page.locator('[aria-label="工作区视图"] button::-p-text(作品)').click();
    expect(await page.$eval('input[aria-label="分镜修改指令"]', input => (input as HTMLInputElement).value)).toBe("稍后修改标题，保留其他内容");
    expect(await page.$$('[aria-label="创作助手"]')).toHaveLength(1);
    await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.locator('[aria-label="画面风格"] button::-p-text(黑白)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="画面风格"] [role="status"]')?.textContent?.includes("已应用黑白"));
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r1"));
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="分镜编辑器"] svg filter[id^="glint-fx-preview-"]')), { timeout: 30_000 });
    // Native browser UI and actual Remotion preview are mounted, not a DOM-only mock.
    await page.locator('[aria-label="分镜编辑器"] button::-p-text(撤销)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="画面风格"]')?.textContent?.includes("当前为原色"));
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r2"));
    const current = sessions.list()[0]!;
    expect(parseProject(sessions.snapshot(current.projectId).snapshot.document).scenes[0]!.effects).toBeUndefined();
    expect(errors).toEqual([]);
    await page.locator('[aria-label="属性面板"] button::-p-text(内容)').click();
    await page.locator('[aria-label="分镜编辑器"] summary::-p-text(存为创作包)').click();
    await page.locator('input[aria-label="创作包作者"]').fill('Browser author');
    await page.locator('input[aria-label="确认创作包权利与隐私"]').click();
    await page.locator('button::-p-text(保存到创作库)').click();
    await page.waitForFunction(() => Object.keys(localStorage).includes('glint.creation-packs.imported.v1'));
    const savedPacks = await page.evaluate(() => JSON.parse(localStorage.getItem('glint.creation-packs.imported.v1') ?? '[]'));
    expect(savedPacks).toHaveLength(1); expect(savedPacks[0].author).toBe('Browser author');
    expect(sessions.snapshot(current.projectId).look.revision).toBe(2);
    // Real library bytes -> candidate preview -> explicit adoption -> same-origin preview URL.
    await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click();
    await page.locator('[aria-label="分镜编辑器"] details summary::-p-text(素材候选)').click();
    await page.waitForSelector('[aria-label="可采用素材"] button');
    await page.locator('[aria-label="可采用素材"] button').filter(element => element.textContent?.includes('candidate.png')).click();
    await page.locator('button::-p-text(添加为新镜头)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="分镜编辑器"]')?.textContent?.includes("4 个分镜"));
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r3"));
    const withMedia = parseProject(sessions.snapshot(current.projectId).snapshot.document);
    expect(withMedia.scenes.some(scene => scene.kind === "image" && scene.src === "assets/candidate.png")).toBe(true);
    // The shot strip shows the real library frame, not just a number.
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="分镜时间线"] img[src="/api/media/assets/candidate.png"]')));
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="分镜编辑器"] img[src="/api/media/assets/candidate.png"]')), { timeout: 30_000 });
    await page.locator('[aria-label="分镜编辑器"] button::-p-text(撤销)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="分镜编辑器"]')?.textContent?.includes("3 个分镜"));
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r4"));
    // Project-level style: applying a pack changes the theme, keeps scenes, and is undoable.
    await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.waitForSelector('[aria-label="可选风格包"] button', { timeout: 15_000 });
    await page.evaluate(() => {
      const details = document.querySelector<HTMLDetailsElement>('[aria-label="风格包"]')!;
      details.open = true;
      const card = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="可选风格包"] button')]
        .find(button => button.textContent?.includes("奶油编辑部"))!;
      card.click();
    });
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="应用风格 奶油编辑部"]')));
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[aria-label="应用风格 奶油编辑部"]')!.click());
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r5"));
    expect(parseProject(sessions.snapshot(current.projectId).snapshot.document).theme).toBe("cream-editorial");
    await page.evaluate(() => {
      const undo = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="分镜编辑器"] button')]
        .find(button => button.textContent === "撤销")!;
      undo.click();
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r6"));
    expect(parseProject(sessions.snapshot(current.projectId).snapshot.document).theme).not.toBe("cream-editorial");
    // Same workbench: the creative view keeps a live preview beside the canvas.
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="工作区视图"] button')].find(button => button.textContent === "创意")!.click());
    await page.waitForSelector('[aria-label="创意工作区"] .react-flow__node');
    await page.waitForFunction(() => document.querySelector('[aria-label="画布预览"]')?.textContent?.includes("三个卖点"), { timeout: 30_000 });
    // Library material appears on the same canvas and is adopted only on an explicit click.
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="创意工作区"] button')].find(button => button.textContent === "显示素材")!.click());
    await page.waitForSelector('[aria-label="素材节点"]');
    await page.evaluate(() => document.querySelector<HTMLElement>('[aria-label="素材节点"]')!.click());
    await page.waitForFunction(() => document.querySelector('[aria-label="素材详情"]')?.textContent?.includes("candidate.png"));
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="素材详情"] button')].find(button => button.textContent === "添加为新镜头")!.click());
    await page.waitForFunction(() => document.querySelector('[aria-label="分镜编辑器"]')?.textContent?.includes("4 个分镜"));
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent 上下文"]')?.textContent?.includes("r7"));
    expect(parseProject(sessions.snapshot(current.projectId).snapshot.document).scenes.some(scene => scene.src === "assets/candidate.png" && scene.kind === "image")).toBe(true);
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="镜头画布"] img[src="/api/media/assets/candidate.png"]')), { timeout: 15_000 });
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="工作区视图"] button')].find(button => button.textContent === "作品")!.click());
    await page.setViewport({ width: 480, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  } catch (error) {
    if (opened) {
      const snapshot = await opened.page.evaluate(() => ({ text: document.body.innerText.slice(0, 14000), buttons: [...document.querySelectorAll('button')].filter(button => button.textContent?.includes('用这个')).map(button => ({ text: button.textContent, disabled: button.disabled })) }));
      console.error("Browser failure state", JSON.stringify(snapshot));
    }
    throw error;
  } finally {
    await opened?.browser.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
