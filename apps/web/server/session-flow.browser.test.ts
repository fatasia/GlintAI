import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised by a real browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const dist = fileURLToDist();
function fileURLToDist() { return new URL("../dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); }

let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }
// Opt-in: requires an explicitly fresh production build.
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("a shared project edits through CAS: remote sync, then a 409 keeps the draft", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-session-flow-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}), sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(base, { waitUntil: "networkidle0" });

    // Draft a project, then enter the shared-session editor.
    await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
    await page.locator('textarea[aria-label="快速成片资料"]').fill("# 熵与咖啡\n\n- 热咖啡会放凉\n- 熵是微观排列方式的数量\n\n一杯咖啡，就是熵增的日常证据。");
    await page.locator('.pc-submit').click();
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="共享工程编辑"]')), { timeout: 30_000 });
    await page.waitForFunction(() => /共享工程 · r\d+/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""), { timeout: 20_000 });
    const projectId = await page.$eval('[aria-label="共享工程编辑"] code', element => element.textContent!.trim());
    const revisionAtOpen = Number((await page.$eval('[aria-label="共享工程编辑"]', element => element.textContent!)).match(/共享工程 · r(\d+)/)![1]);

    // A second entry (raw HTTP) reads the shared snapshot and edits it.
    const opened2 = await (await fetch(`${base}/api/session/snapshot?projectId=${encodeURIComponent(projectId)}`)).json();
    expect(opened2.look.revision).toBe(revisionAtOpen);
    const transaction = { id: "external-entry-1", projectId, baseRevision: opened2.look.revision, actor: "cli", scope: {}, operations: [{ kind: "set", path: ["scenes", "0", "title"], value: "外部入口改的标题" }], intent: "外部入口" };
    const applied = await (await fetch(`${base}/api/session/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, transaction }) })).json();
    expect(["saved", "verified"]).toContain(applied.receipt.stage);

    // The editor polls (1.5s) and adopts the remote revision while clean.
    await page.waitForFunction(() => /已同步其他入口/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""), { timeout: 15_000 });
    await page.waitForFunction(() => document.body.textContent!.includes("外部入口改的标题"), { timeout: 15_000 });

    // Now the local editor races an external write: stale base → 409 → draft kept.
    const stale = { id: "external-entry-2", projectId, baseRevision: applied.look.revision, actor: "cli", scope: {}, operations: [{ kind: "set", path: ["scenes", "0", "title"], value: "外部再改一次" }], intent: "外部入口" };
    await fetch(`${base}/api/session/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, transaction: stale }) });
    const localTitle = await page.$eval('textarea[aria-label="title"]', element => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(element, "浏览器里的本地修改");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return element.value;
    });
    expect(localTitle).toBe("浏览器里的本地修改");
    await page.waitForFunction(() => /版本不同，草稿仍保留/.test(document.body.textContent ?? ""), { timeout: 20_000 });
    await page.screenshot({ path: path.join(process.env.GLINT_SESSION_EVIDENCE ?? root, "session-conflict.png") });
    expect(await page.$eval('[aria-label="共享工程编辑"]', element => element.textContent!)).toContain("浏览器里的本地修改");
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
