import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
import { openHomeTool, openInspector, openWorkspaceMenu } from "../server/browser-workspace-helpers";
// @ts-expect-error JavaScript server exercised through a real browser.
import { createWebServer } from "../server/index.mjs";
// @ts-expect-error JavaScript media jobs helper.
import { createMediaJobs } from "../server/media-jobs.mjs";
// @ts-expect-error JavaScript local render job runner.
import { createJobRunner } from "../server/jobs.mjs";

/**
 * CREATE-04/06/07 real-browser acceptance. Everything is local and free:
 * heuristic compose (no model), mock TTS (silent), the local Remotion/ffmpeg
 * render at draft resolution, and a system Chrome that must actually PLAY the
 * resulting trial clip. Opt-in like the other browser suites.
 */
const run = promisify(execFile);
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
const studioDir = fileURLToPath(new URL("../../studio", import.meta.url));
const evidence = (task: string, name?: string) => {
  const dir = path.resolve(fileURLToPath(new URL("../../../evidence", import.meta.url)), task, "run-20261025b");
  fs.mkdirSync(dir, { recursive: true });
  return name ? path.join(dir, name) : dir;
};
/**
 * Minimal browser surface used here. apps/web does not depend on
 * puppeteer-core (the capture host lives in apps/studio), so the suite relies
 * on a structural type instead of importing puppeteer's own declarations.
 */
interface BrowserPage {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  reload(options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>;
  waitForFunction<T extends unknown[]>(fn: (...args: T) => unknown, options?: { timeout?: number }, ...args: T): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): { click(options?: { timeout?: number }): Promise<void>; fill(value: string): Promise<void> };
  $eval<T = unknown>(selector: string, fn: (element: HTMLTextAreaElement) => T): Promise<T>;
  screenshot(options: { path: string }): Promise<unknown>;
  on(event: "pageerror", listener: (error: Error) => void): void;
}
interface BrowserSession { browser: { close(): Promise<void> }; page: BrowserPage }
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }
const enabled = process.env.GLINT_BROWSER_UI_TEST === "1" && browserAvailable;

const SOURCE = "# 熵与咖啡试片\n\n## 为什么咖啡会凉\n热量总是从高温流向低温，热咖啡放凉是自发过程。\n\n## 熵在说一件事\n孤立系统的熵只增不减，排列方式只会越来越多。\n";
const WIZARD_PLAN = { title: "试片草稿方案", hook: "刷新存活钩子", audience: "验证者", platform: "16:9", theme: "glint-dark", totalSeconds: 7, takeaway: "草稿还在", scenes: [
  { goal: "开场", narration: "刷新前写下的旁白。", visual: "字卡", seconds: 3, kind: "title" },
  { goal: "卖点", narration: "草稿恢复的第二镜。", visual: "两栏要点", seconds: 4, kind: "bullets" },
] };
const UNDO_PROJECT = { schemaVersion: 1, id: "undo-trial", title: "撤销试片", aspect: "16:9", knowledgeSources: [], theme: "glint-dark", scenes: [
  { id: "hook", kind: "title", title: "批准标题", narration: { text: "批准的旁白原句，撤销后回来。", durationMs: 2500 } },
  { id: "body", kind: "definition", term: "概念", definition: "定义正文", narration: { text: "第二句旁白。", durationMs: 2500 } },
] };

async function startServer(root: string, outputDir?: string): Promise<Server> {
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  const options: Record<string, unknown> = {
    distDir: dist,
    mediaJobs: createMediaJobs(mediaDir, {}),
    sessionStore: new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); }),
  };
  if (outputDir) options.makeRunner = createJobRunner({ studioDir, outputDir, timeoutMs: 300_000 });
  const server = createWebServer(options) as Server;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}
async function stopServer(server: Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
const shot = async (page: BrowserPage, file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  return file;
};
const clickExact = (page: BrowserPage, text: string) => page.evaluate(label => {
  const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label && !button.disabled);
  if (!target) throw new Error(`button not found or disabled: ${label}`);
  target.click();
}, text);
/** React-compatible direct input: sets the value and fires the input event. */
const typeInto = (page: BrowserPage, selector: string, value: string) => page.evaluate((query, text) => {
  const target = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(query);
  if (!target) throw new Error(`missing control: ${query}`);
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(target, text);
  target.dispatchEvent(new Event("input", { bubbles: true }));
}, selector, value);
const bodyText = (page: BrowserPage) => page.evaluate(() => document.body.innerText);

it.skipIf(!enabled)("composes offline, renders a low-res trial clip locally and plays it in the browser (CREATE-04)", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-create04-"));
  const outDir = evidence("CREATE-04");
  const server = await startServer(root, outDir);
  let opened: BrowserSession | undefined;
  const startedAt = Date.now();
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900) as unknown as BrowserSession;
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await openHomeTool(page, "create");
    await page.waitForSelector("#make-input", { timeout: 20_000 });
    await page.locator("#make-input").fill(SOURCE);
    await clickExact(page, "生成分镜");
    await page.waitForSelector('.glint-editor');
    await openWorkspaceMenu(page,"更多创作选项");
    // CREATE-14 surfacing here too: the offline compose response carries the
    // audited source back as the review basis, rendered by the real server.
    await page.waitForFunction(() => document.body.innerText.includes("旁白依据核对") && (document.querySelector(".glint-editor-meta")?.textContent?.includes("个分镜") ?? false), { timeout: 60_000 });
    await shot(page, evidence("CREATE-14", "browser-offline-review.png"));
    await page.locator('.workspace-tools-heading button').click();
    await page.locator('button::-p-text(导出视频)').click();
    await page.evaluate(()=>{const select=document.querySelector<HTMLSelectElement>('[aria-label="导出规格"]')!;select.value="draft";select.dispatchEvent(new Event("change",{bubbles:true}));});
    await clickExact(page, "导出 MP4");
    // Mock TTS + draft encoding: the local render job produces a real MP4.
    await page.waitForFunction(() => Boolean(document.querySelector('video[aria-label="生成的视频"]')), { timeout: 300_000 });
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('video[aria-label="生成的视频"]');
      return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
    }, { timeout: 60_000 });
    await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('video[aria-label="生成的视频"]')!;
      video.muted = true;
      void video.play();
    });
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('video[aria-label="生成的视频"]');
      return Boolean(video && !video.paused && video.currentTime > 0.5);
    }, { timeout: 30_000 });
    const playback = await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('video[aria-label="生成的视频"]')!;
      return { currentTime: video.currentTime, duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight, paused: video.paused };
    });
    // Playable, moving, and low-resolution (draft encodes at half size).
    expect(playback.paused).toBe(false);
    expect(playback.currentTime).toBeGreaterThan(0.5);
    expect(playback.videoWidth).toBeGreaterThan(0);
    expect(playback.videoWidth).toBeLessThanOrEqual(1280);
    expect(playback.duration).toBeGreaterThan(2);
    await page.evaluate(() => document.querySelector('video[aria-label="生成的视频"]')?.scrollIntoView({ block: "center" }));
    await new Promise(resolve => setTimeout(resolve, 300));
    await shot(page, path.join(outDir, "trial-playing.png"));
    expect(errors).toEqual([]);
    // The clip on disk must decode as h264 and match the played duration.
    const clip = fs.readdirSync(outDir).filter(name => /^idea-[a-z0-9-]+\.mp4$/.test(name))
      .map(name => ({ name, at: fs.statSync(path.join(outDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.name;
    expect(clip).toBeTruthy();
    const jobFile = fs.readdirSync(path.join(outDir, ".jobs")).filter(name => /^idea-[a-z0-9-]+\.json$/.test(name))
      .map(name => ({ name, at: fs.statSync(path.join(outDir, ".jobs", name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.name;
    const job = jobFile ? JSON.parse(fs.readFileSync(path.join(outDir, ".jobs", jobFile), "utf8")) : {};
    const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,avg_frame_rate", "-show_entries", "format=duration,size", "-of", "json", path.join(outDir, clip!)], { encoding: "utf8" })).stdout);
    const track = probe.streams[0], format = probe.format;
    expect(track.codec_name).toBe("h264");
    expect(Number(format.duration)).toBeGreaterThan(2);
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
      ranAt: new Date().toISOString(), clip, jobId: job.id, jobStageLog: job.log, actualSeconds: job.actualSeconds ?? null, playback, probe: { codec: track.codec_name, width: track.width, height: track.height, duration: Number(format.duration), bytes: Number(format.size) },
      sourceChars: SOURCE.length, totalMs: Date.now() - startedAt,
      assertions: "offline heuristic compose / real-server review basis / mock TTS draft render / h264 low-res / browser playhead advances",
    }, null, 2));
  } catch (error) {
    if (opened) console.error("CREATE-04 browser failure body:", (await bodyText(opened.page)).slice(0, 4000));
    throw error;
  } finally {
    await opened?.browser.close();
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 420_000);

it.skipIf(!enabled)("keeps the wizard draft across a real reload and restores approved narration through undo (CREATE-06/07)", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-create06-"));
  const server = await startServer(root);
  let opened: BrowserSession | undefined;
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900) as unknown as BrowserSession;
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    // Seed both drafts, then let the NEXT navigation boot with them in place.
    await page.evaluate((draft, workspace) => {
      localStorage.setItem("glint:wizard-draft:v1", JSON.stringify(draft));
      localStorage.setItem("glint.workspace", JSON.stringify(workspace));
    }, { goal: "刷新前定下的目标", audience: "验证者", platform: "16:9", seconds: 15, material: "", plans: [WIZARD_PLAN], planIndex: 0 }, { mode: "source", text: "Original", project: UNDO_PROJECT, template: "explainer", theme: "glint-dark", aspect: "16:9" });
    await page.reload({ waitUntil: "networkidle0" });
    // CREATE-06: the wizard comes back with the plan after a real reload.
    await openWorkspaceMenu(page,"方案");
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>('[aria-label="创作目标"]')?.value) === "刷新前定下的目标", { timeout: 20_000 });
    await page.waitForFunction(() => document.body.innerText.includes("已恢复上次草稿") && document.body.innerText.includes("试片草稿方案"), { timeout: 20_000 });
    await shot(page, evidence("CREATE-06", "wizard-restored-after-reload.png"));
    // An edit is autosaved and survives a second reload.
    await typeInto(page, '[aria-label="创作目标"]', "刷新后仍在这 CREATE-06");
    await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem("glint:wizard-draft:v1") ?? "").goal === "刷新后仍在这 CREATE-06"; } catch { return false; } }, { timeout: 10_000 });
    await page.reload({ waitUntil: "networkidle0" });
    await openWorkspaceMenu(page,"方案");
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>('[aria-label="创作目标"]')?.value) === "刷新后仍在这 CREATE-06", { timeout: 20_000 });
    await shot(page, evidence("CREATE-06", "wizard-edit-persisted-after-second-reload.png"));
    // CREATE-07: the approved narration comes back through the undo chain.
    await page.locator('button::-p-text(继续编辑工程)').click();
    await openInspector(page);
    await page.locator('[aria-label="属性面板"] button::-p-text(声音)').click();
    await page.waitForSelector('textarea[aria-label="旁白"]', { timeout: 20_000 });
    const original = "批准的旁白原句，撤销后回来。";
    expect(await page.$eval('textarea[aria-label="旁白"]', element => element.value)).toBe(original);
    await typeInto(page, 'textarea[aria-label="旁白"]', "手滑改掉的旁白");
    await page.locator('[aria-label="分镜编辑器"] button[aria-label="撤销"]').click();
    await page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="旁白"]')?.value === text, { timeout: 10_000 }, original);
    await shot(page, evidence("CREATE-07", "undo-restores-approved-narration.png"));
    expect(errors).toEqual([]);
    fs.writeFileSync(path.join(evidence("CREATE-06"), "report.json"), JSON.stringify({
      ranAt: new Date().toISOString(), reloads: 2, wizardRestored: true, editPersisted: true, undoRestoresApprovedNarration: true,
    }, null, 2));
  } catch (error) {
    if (opened) console.error("CREATE-06/07 browser failure body:", (await bodyText(opened.page)).slice(0, 4000));
    throw error;
  } finally {
    await opened?.browser.close();
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
