import { openInspector } from "./browser-workspace-helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised through real HTTP.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

// Observe only allowlisted fixture fields; never capture full requests or headers.
function diagnosticText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/sk-[a-z0-9_-]+/gi, "[key]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[a-z]:[\\/][^\s"'<>]+/gi, "[path]")
    .slice(0, 400);
}

let available = false; try { findSystemBrowser(); available = true; } catch { /* no implicit browser downloads */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("validates a reference-bound candidate before a real browser can adopt it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ref-adopt-browser-")), media = path.join(root, "media"); fs.mkdirSync(media);
  const source = path.join(root, "image.png");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=32x32", "-frames:v", "1", source], { timeout: 60000 });
  const bytes = fs.readFileSync(source), hash = createHash("sha256").update(bytes).digest("hex"), ref = `approved-${hash}.png`;
  fs.writeFileSync(path.join(media, ref), bytes); fs.writeFileSync(path.join(media, "old.png"), bytes);
  const asset = { id: "hero", kind: "character", name: "小雨", version: "v1", description: "蓝外套", voice: "voice-a", refs: [`assets/${ref}`] };
  const project = parseProject({ schemaVersion: 1, id: "adopt-browser", title: "角色素材", aspect: "16:9", knowledgeSources: [], assets: [asset], scenes: [{ id: "one", kind: "image", src: "assets/old.png", assetRefs: [{ assetId: "hero", version: "v1" }], narration: { text: "原旁白", durationMs: 1000 } }] });
  const client = { models: vi.fn(async () => [{ id: "edit", name: "本地测试", tags: ["图生图"] }]), submit: vi.fn(async () => "task-browser"), status: vi.fn(async () => ({ task_id: "task-browser", state: "success", is_final: true, result_url: "https://asset.test/test.png" })) };
  const jobs = createMediaJobs(media, { GLINT_MEDIA_BASE_URL: "https://gateway.test", GLINT_MEDIA_API_KEY: "test" }, { client, download: vi.fn(async () => ({ contentType: "image/png", bytes })) });
  const store = new FileSessionStore(path.join(root, "sessions"), value => { parseProject(value); });
  const server = createWebServer({ distDir: process.env.GLINT_TEST_WEB_DIST ?? process.env.GLINT_TEST_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)), mediaJobs: jobs, sessionStore: store, requestLogDir: path.join(root, "logs") }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  const responses: Array<{ route: string; status: number; error?: string }> = [];
  const submittedReferences: Array<{ projectId?: string; sceneId?: string; assetId?: string }> = [];
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1280, 900); const page = opened.page;
    page.on("request", request => {
      if (request.url() !== `${url}/api/media/submit` || request.method() !== "POST") return;
      const body = JSON.parse(request.postData() ?? "{}") as { reference?: { projectId?: string; sceneId?: string; assetId?: string } };
      submittedReferences.push({ projectId: body.reference?.projectId, sceneId: body.reference?.sceneId, assetId: body.reference?.assetId });
    });
    page.on("response", response => {
      const responseUrl = new URL(response.url());
      if (responseUrl.origin !== url || !/^\/api\/(media|session)\//.test(responseUrl.pathname) || responseUrl.pathname.startsWith("/api/media/assets/")) return;
      const entry: { route: string; status: number; error?: string } = { route: responseUrl.pathname.replace(/\/(status|request)\/[^/]+$/, "/$1/[fixture-id]"), status: response.status() };
      responses.push(entry);
      if (responses.length > 40) responses.shift();
      if (!response.ok()) void response.json().then(value => { entry.error = diagnosticText(value?.error); }).catch(() => { entry.error = "[non-JSON error]"; });
    });
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(value => localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value, evidence: "资料" })), project);
    await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('[aria-label="共享工程编辑"]');
    await page.waitForFunction(() => Boolean(document.querySelector('[aria-label="共享工程编辑"] [role="alert"]')) || /共享工程 · r\d+/.test(document.querySelector('[aria-label="共享工程编辑"]')?.textContent ?? ""));
    expect(await page.$eval('[aria-label="共享工程编辑"]', element => element.textContent)).not.toContain("旧批准需要重新审阅");
    await openInspector(page); await page.locator('[aria-label="属性面板"] button::-p-text(生成)').click(); await page.locator('[aria-label="角色资产"] summary').click();
    await page.select('select[aria-label="选择角色资产"]', "hero");
    await page.locator('button::-p-text(批准角色版本)').click();
    await page.waitForFunction(async () => Boolean((await (await fetch('/api/session/snapshot?projectId=adopt-browser')).json()).snapshot?.document?.assets?.[0]?.approval));
    expect((store.snapshot(project.id).snapshot.document as typeof project).assets![0]!.approval?.refSha256).toBe(hash);
    await page.locator('[aria-label="为这个镜头生成素材"] summary').click();
    await page.waitForSelector('select[aria-label="生成角色或商品参考图"] option[value="hero"]');
    await page.waitForFunction(() => {
      const select = document.querySelector<HTMLSelectElement>('select[aria-label="生成角色或商品参考图"]');
      return select !== null && !select.disabled && Boolean(select.querySelector('option[value="hero"]'));
    });
    expect(await page.$eval('select[aria-label="生成角色或商品参考图"]', element => (element as HTMLSelectElement).disabled)).toBe(false);
    await page.select('select[aria-label="生成角色或商品参考图"]', "hero");
    expect(await page.$eval('select[aria-label="生成角色或商品参考图"]', element => (element as HTMLSelectElement).value)).toBe("hero");
    await page.$eval('[aria-label="为这个镜头生成素材"] input[type="checkbox"]', element => (element as HTMLInputElement).click());
    await page.locator('button::-p-text(生成候选（可能计费）)').click();
    await page.waitForSelector('img[aria-label="候选生成图片"]', { timeout: 20000 });
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(submittedReferences).toEqual([{ projectId: "adopt-browser", sceneId: "one", assetId: "hero" }]);
    expect(await page.evaluate(() => {
      const journal = JSON.parse(localStorage.getItem("glint.scene-generation:v2:adopt-browser:one") ?? "{}");
      return { projectId: journal.projectId, sceneId: journal.sceneId, taskId: journal.taskId, referenceBound: journal.referenceBound };
    })).toEqual({ projectId: "adopt-browser", sceneId: "one", taskId: "task-browser", referenceBound: true });
    fs.writeFileSync(path.join(media, ref), Buffer.concat([bytes, Buffer.from([0])]));
    await page.locator('button::-p-text(用候选替换当前镜头)').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="为这个镜头生成素材"] [role="alert"]')?.textContent?.includes("校验未通过"), { timeout: 10000 });
    expect((store.snapshot(project.id).snapshot.document as typeof project).scenes[0]!.src).toBe("assets/old.png");
    fs.writeFileSync(path.join(media, ref), bytes);
    await page.locator('button::-p-text(恢复原提交)').click();
    await page.waitForFunction(async () => /^assets\/adopted-[a-f0-9]{64}\.png$/.test((await (await fetch("/api/session/snapshot?projectId=adopt-browser")).json()).snapshot?.document?.scenes?.[0]?.src ?? ""), { timeout: 15000 });
    expect(store.snapshot(project.id).snapshot.revision).toBe(2);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const panel = await page.$('[aria-label="为这个镜头生成素材"]'), box = await panel!.boundingBox(); expect(box && box.width <= 390).toBe(true);
  } catch (error) {
    try {
      const alerts = await opened?.page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent ?? ""));
      const snapshot = store.snapshot(project.id).snapshot;
      const snapshotDocument = snapshot.document as typeof project;
      const firstScene = snapshotDocument.scenes[0];
      const src = firstScene?.kind === "image" ? firstScene.src : undefined;
      console.error("[reference-adoption fixture failure]", JSON.stringify({ responses, alerts: alerts?.map(diagnosticText), revision: snapshot.revision,
        sceneSrc: typeof src === "string" && /^assets\/[a-zA-Z0-9_-]+\.png$/.test(src) ? src : "[non-fixture source]" }));
    } catch { console.error("[reference-adoption fixture failure]", JSON.stringify({ responses, diagnosticRead: "unavailable" })); }
    throw error;
  } finally { await opened?.browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);
