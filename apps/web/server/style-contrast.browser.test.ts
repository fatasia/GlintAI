import { openInspector } from "./browser-workspace-helpers";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

let available = false; try { findSystemBrowser(); available = true; } catch { /* no browser download */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("checks actual style actions in light and dark themes", async () => {
  if (!process.env.GLINT_SESSION_DIR || !process.env.GLINT_STYLE_SAMPLE_DIR || !process.env.GLINT_TEST_WEB_DIST || !process.env.GLINT_STYLE_HISTORY_EVIDENCE) throw new Error("Explicit isolated directories required");
  const { createWebServer } = await import("./index.mjs");
  const runner = { submit() { throw new Error("Unexpected job"); }, get() { return null; }, findRequest() { return null; }, cancel() { return false; }, videoFile() { return null; } };
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST, makeRunner: runner, sessionStore: new FileSessionStore(process.env.GLINT_SESSION_DIR, value => { parseProject(value); }) }) as Server;
  const project = parseProject({ schemaVersion: 1, id: "style-contrast", title: "隔离测试", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "原有工程", narration: { text: "旁白", durationMs: 2000 } }] });
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.evaluateOnNewDocument(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "隔离测试", project: value })), project);
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="共享工程编辑"]');
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(画面)').click();
    await page.locator('[aria-label="风格包"] summary').click();
    const catalog = '[aria-label="主题样片与版本"]';
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("播放历史样片"), {}, catalog);
    await page.locator(`${catalog} button::-p-text(播放历史样片)`).click();
    for (const theme of ["dark", "light"] as const) {
      if (theme === "light") { await page.locator('.rail-button[aria-label="帮助"]').click(); await page.locator('button[aria-label="切换浅色主题"]').click(); await page.keyboard.press("Escape"); }
      await page.waitForFunction(value => document.documentElement.dataset.theme === value || (value === "dark" && !document.documentElement.dataset.theme), {}, theme);
      if (theme === "light") {
        const transition = await page.$eval(`${catalog} button`, button => ({ property: getComputedStyle(button).transitionProperty, duration: getComputedStyle(button).transitionDuration }));
        console.log("BUTTON_TRANSITION", JSON.stringify(transition));
        if (transition.duration.split(",").some(value => parseFloat(value) > 0)) expect(transition.property).not.toMatch(/(^|,\s*)(all|color|background|background-color)(,|$)/);
      }
      for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
        await page.setViewport({ width, height, deviceScaleFactor: 1 });
        await page.$eval(catalog, e => e.scrollIntoView({ block: "start" }));
        const states = await page.$$eval(`${catalog} button`, buttons => buttons.map(button => {
          const style = getComputedStyle(button);
          const rgb = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
          const luminance = (color: number[]) => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
          const foreground = luminance(rgb(style.color)), background = luminance(rgb(style.backgroundColor));
          return { text: button.textContent?.trim(), disabled: button.disabled, color: style.color, background: style.backgroundColor, opacity: style.opacity, contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
        }));
        console.log("BUTTON_CONTRAST", theme, name, JSON.stringify(states));
        await page.screenshot({ path: path.join(process.env.GLINT_STYLE_HISTORY_EVIDENCE!, `contrast-${theme}-${name}.png`) });
        for (const text of ["关闭历史样片", "生成当前工程试片", "保存当前主题版本"]) {
          const state = states.find(item => item.text === text);
          expect(state, text).toBeDefined(); expect(state!.disabled, text).toBe(false); expect(Number(state!.opacity), text).toBe(1);
          expect(state!.contrast, `${text} contrast`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    await page.locator(`${catalog} button::-p-text(关闭历史样片)`).click();
    expect(await page.$('[aria-label="历史风格样片"]')).toBeNull();
    await page.locator(`${catalog} button::-p-text(保存当前主题版本)`).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("已保存当前主题版本"), {}, catalog);
    expect(errors).toEqual([]);
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);
