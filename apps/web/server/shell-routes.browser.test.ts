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
// @ts-expect-error JavaScript server exercised through a real browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("hash routes survive reload and back, and the command palette is fully keyboard operable", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build glint-web before running this test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-shell-routes-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const hash = () => page.evaluate(() => window.location.hash);
    // The palette is the only element with this class; [role=dialog] also matches the hidden tools layer.
    const paletteOpen = () => page.evaluate(() => Boolean(document.querySelector(".g-palette")));
    const chord = async (key: string) => { await page.keyboard.down("Control"); await page.keyboard.press(key as never); await page.keyboard.up("Control"); };

    // Deep link: a tool tab address restores that tab on a cold load, and reload keeps it.
    await page.goto(`${base}#/library/brand`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#tool-tab-brand[aria-selected=true]", { visible: true });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#tool-tab-brand[aria-selected=true]", { visible: true });
    expect(await hash()).toBe("#/library/brand");

    // Rail navigation writes the address; the browser Back button returns to the previous place.
    await page.locator('.rail-button::-p-text(设置)').click();
    await page.waitForFunction(() => window.location.hash === "#/settings");
    await page.goBack();
    await page.waitForFunction(() => window.location.hash === "#/library/brand");
    await page.waitForSelector("#tool-tab-brand[aria-selected=true]", { visible: true });

    // A hostile or unknown address falls back to the home view instead of breaking the app.
    await page.goto(`${base}#/p/..%2F..%2Fetc`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="创作首页"]', { visible: true });

    // Command palette: Ctrl+K opens it with focus in the search field.
    await page.goto(`${base}#/`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".rail-button");
    await chord("k");
    await page.waitForSelector(".g-palette", { visible: true });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("combobox");
    expect(await page.$$eval('.g-palette [role="option"]', nodes => nodes.length)).toBeGreaterThan(8);

    // Typing (including CJK) filters; arrows move the selection; Enter runs it.
    await page.keyboard.type("品牌");
    await page.waitForFunction(() => document.querySelectorAll('.g-palette [role="option"]').length === 1);
    expect(await page.$eval('.g-palette [aria-selected="true"]', node => node.textContent)).toBe("品牌与声音");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.hash === "#/library/brand");
    await page.waitForFunction(() => !document.querySelector(".g-palette"));

    // Escape closes without navigating; Ctrl+K toggles; Shift+Ctrl+K is not ours.
    await chord("k");
    await page.waitForSelector(".g-palette", { visible: true });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".g-palette"));
    expect(await hash()).toBe("#/library/brand");
    await chord("k"); await page.waitForSelector(".g-palette", { visible: true });
    await chord("k"); await page.waitForFunction(() => !document.querySelector(".g-palette"));
    await page.keyboard.down("Control"); await page.keyboard.down("Shift"); await page.keyboard.press("k"); await page.keyboard.up("Shift"); await page.keyboard.up("Control");
    expect(await paletteOpen()).toBe(false);

    // The rail entry opens it too, and an empty result set says so instead of showing nothing.
    await page.locator('.rail-button[aria-label="搜索"]').click();
    await page.waitForSelector(".g-palette", { visible: true });
    await page.keyboard.type("zzzz没有这个");
    await page.waitForFunction(() => document.querySelector(".g-palette-empty")?.textContent?.includes("没有匹配"));
    await page.keyboard.press("Enter");
    expect(await hash()).toBe("#/library/brand");
    await page.keyboard.press("Escape");

    // Narrow screens: the rail is a bottom bar and nothing overflows horizontally.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto(`${base}#/`, { waitUntil: "networkidle0" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.$eval(".app-rail", node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: window.innerHeight }; });
    expect(box.bottom).toBeGreaterThan(box.height - 2);
    expect(box.top).toBeGreaterThan(box.height / 2);
    // Every rail button must be fully on screen (a clipped button cannot be tapped).
    const clipped = await page.$$eval(".rail-button", nodes => nodes.filter(node => { const r = node.getBoundingClientRect(); return r.left < -0.5 || r.right > window.innerWidth + 0.5 || r.width < 36; }).map(node => node.getAttribute("aria-label")));
    expect(clipped).toEqual([]);
    // A toast (PWA install prompt) may be on screen; it must not sit on top of any rail button.
    await page.evaluate(() => { window.dispatchEvent(new Event("beforeinstallprompt")); });
    const covered = await page.$$eval(".rail-button", nodes => nodes.filter(node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !node.contains(hit); }).map(node => node.getAttribute("aria-label")));
    expect(covered).toEqual([]);
    await page.locator('.rail-button[aria-label="帮助"]').click();
    await page.waitForSelector('[aria-label="项目链接"] a', { visible: true });
  } finally {
    await opened?.browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
