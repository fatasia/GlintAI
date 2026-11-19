import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { findSystemBrowser, openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript server exercised by a real browser.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";

const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let browserAvailable = false;
try { findSystemBrowser(); browserAvailable = true; } catch { /* No implicit downloads. */ }

function wav(): Buffer {
  const rate = 8000, seconds = 0.6, samples = Math.floor(rate * seconds);
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + samples * 2, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) data.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 2 * 440) * 12000), 44 + index * 2);
  return data;
}

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("edits multitrack, undoes, splits, exports FCPXML and draws an audio waveform", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-browser-"));
  const mediaDir = path.join(root, "media"); fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "tone.wav"), wav());
  fs.writeFileSync(path.join(mediaDir, "still.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(mediaDir, {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1440, 960);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('section[aria-label="剪辑台"]', { timeout: 20_000 });
    await page.waitForSelector('[aria-label="多轨时间线"]', { timeout: 20_000 });

    // Add a text clip, move it numerically, then undo with the keyboard.
    await page.locator('button::-p-text(+ 文字)').click();
    await page.waitForSelector('input[aria-label="起点 ms"]');
    const start = page.locator('input[aria-label="起点 ms"]');
    await start.click({ clickCount: 3 });
    await start.fill("1200");
    await page.waitForFunction(() => (document.querySelector('input[aria-label="起点 ms"]') as HTMLInputElement | null)?.value === "1200");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
    await page.waitForFunction(() => (document.querySelector('input[aria-label="起点 ms"]') as HTMLInputElement | null)?.value === "0");
    // The current UI creates random txt-* ids; address the clip through its selected state.
    const addedClipLabel = await page.evaluate(() => document.querySelector('[aria-label="多轨时间线"] [aria-pressed="true"]')?.getAttribute("aria-label") ?? null);
    expect(addedClipLabel, "the new text clip must be the current selection").toContain("T1 文字 txt-");

    // Incoming transition is stored on the clip and rendered by the preview.
    await page.select('select[aria-label="入场转场"]', "zoom");
    await page.waitForFunction(() => (document.querySelector('select[aria-label="入场转场"]') as HTMLSelectElement | null)?.value === "zoom");

    // Add the audio asset; the timeline decodes it and draws the waveform.
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[aria-label="素材库"] button')].find(button => button.textContent === "加入音频轨")!.click());
    await page.waitForSelector('[aria-label="多轨时间线"] svg polyline', { timeout: 20_000 });

    // Seek into the clip and split it.
    const ruler = await page.$('[aria-label="时间标尺"]');
    if (!ruler) throw new Error("ruler missing");
    const box = await ruler.boundingBox();
    if (!box) throw new Error("ruler has no box");
    // Ruler x=0 is the element's left edge; 1000 ms at 0.08 px/ms is 80 px.
    await page.mouse.click(box.x + 80, box.y + box.height / 2);
    if (!addedClipLabel) throw new Error("no selected clip label");
    await page.locator(`[aria-label="多轨时间线"] [aria-label="${addedClipLabel}"]`).click();
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "在播放头切分")!.click());
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="多轨时间线"] [aria-label^="T1 文字"][aria-label$="-b"]').length > 0, { timeout: 10_000 });

    // Shift-click adds to the selection; the header reports the group size.
    const textClips = await page.$$('[aria-label^="T1 文字 txt-"]');
    if (textClips.length < 2) throw new Error("expected at least two text clips");
    await textClips[0]!.click();
    await page.keyboard.down("Shift");
    await textClips[1]!.click();
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => document.body.innerText.includes("已选 2"), { timeout: 10_000 });

    // The edit-decision export does not re-render, it serialises the timeline.
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "FCPXML")!.click());
    await page.waitForFunction(() => document.body.innerText.includes("下载 ") && document.body.innerText.includes("事件"), { timeout: 20_000 });
    const exported = await page.evaluate(() => [...document.querySelectorAll("a")].map(link => link.getAttribute("href")).find(href => href?.endsWith(".fcpxml")) ?? null);
    expect(exported).toMatch(/^\/api\/project\/export\/[a-f0-9]{16}\/[a-f0-9]{16}\.fcpxml$/);
    const xml = await (await fetch(`${url}${exported}`)).text();
    expect(xml).toContain('<fcpxml version="1.9">');
    expect(xml).toContain('audioRole="effects"');
    expect(xml).toContain('offset="0s"');
    expect(xml).not.toContain('name="title"');
    // The export banner reports the text-clip omission count (server contract, not UI copy).
    await page.waitForFunction(() => document.body.innerText.includes("下载") && /事件/.test(document.body.innerText), { timeout: 10_000 });
    const bannerText = await page.evaluate(() => document.body.innerText.match(/下载 FCPXML（\d+ 事件）/)?.[0] ?? "");
    expect(bannerText).toMatch(/下载 FCPXML（\d+ 事件）/);

    await page.screenshot({ path: path.join(os.tmpdir(), "glint-nle-v2.png") });
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ screenshot: path.join(os.tmpdir(), "glint-nle-v2.png"), events: (xml.match(/<asset-clip /g) ?? []).length }));
  } finally {
    await opened?.browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("projects a saved film onto the timeline and writes edits back", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-bridge-"));
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(path.join(root, "media"), {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1440, 960);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    // Seed a saved film the projection can read (approvedPlan-style timing).
    await page.evaluate(() => {
      const film = { id: "library-entry", name: "桥接演示", mode: "source", text: "", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.now(),
        project: { schemaVersion: 1, id: "bridge-film", title: "桥接演示", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [
          { id: "intro", kind: "title", title: "熵与生命", narration: { text: "今天聊熵。", durationMs: 2000 } },
          { id: "points", kind: "bullets", heading: "三条事实", items: ["a", "b"], narration: { text: "三条事实。", durationMs: 3000 } },
        ] } };
      localStorage.setItem("glint.projects", JSON.stringify([film]));
    });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('section[aria-label="剪辑台"]', { timeout: 20_000 });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "从工程投影")!.click());
    await page.waitForFunction(() => document.body.innerText.includes("已投影"), { timeout: 10_000 });
    await page.waitForSelector('[aria-label="多轨时间线"] [aria-label="场景 scene-intro"]', { timeout: 10_000 });
    await page.waitForSelector('[aria-label="多轨时间线"] [aria-label="场景 scene-points"]', { timeout: 10_000 });
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("glint.nle.record.v1:bridge-film")!).bridge)).toMatchObject({sourceId:"library-entry",projectId:"bridge-film"});
    // Trim the second scene by -1s through the inspector, then write back.
    await page.locator('[aria-label="多轨时间线"] [aria-label="场景 scene-points"]').click();
    await page.waitForSelector('input[aria-label="时长 ms"]', { timeout: 10_000 });
    const current = await page.waitForFunction(() => (document.querySelector('input[aria-label="时长 ms"]') as HTMLInputElement | null)?.value ?? null, { timeout: 10_000 }).then(handle => handle.jsonValue<string>());
    const durationInput = page.locator('input[aria-label="时长 ms"]');
    await durationInput.click({ clickCount: 3 });
    await durationInput.fill(String(Number(current) - 1000));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "回写工程")!.click());
    await page.waitForFunction(() => document.body.innerText.includes("已回写 2 个片段"), { timeout: 10_000 });
    const written = await page.evaluate(() => {
      const films = JSON.parse(localStorage.getItem("glint.projects") ?? "[]") as Array<{ project?: { scenes: Array<{ id: string; narration: { durationMs?: number } }> } }>;
      const film = films.find(entry => entry.project?.id === "bridge-film");
      return film?.project?.scenes.map(scene => [scene.id, scene.narration.durationMs]) ?? null;
    });
    expect(written).toEqual([["intro", 2000], ["points", 2000]]);
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !browserAvailable)("records keyframes with K, shows diamonds on clips, razors all tracks with B and opens the shortcut sheet", async () => {
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Run pnpm --filter glint-web build before GLINT_BROWSER_UI_TEST=1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-nle-keys-"));
  const server = createWebServer({ distDir: dist, mediaJobs: createMediaJobs(path.join(root, "media"), {}) }) as Server;
  let opened: Awaited<ReturnType<typeof openCaptureBrowser>> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    opened = await openCaptureBrowser(1440, 960);
    const page = opened.page, errors: string[] = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      localStorage.setItem("glint.nle.project.v2", JSON.stringify({
        schemaVersion: 1, id: "keys-demo", title: "快捷键演示", fps: 30, width: 1920, height: 1080,
        tracks: [
          { id: "v1", kind: "video", name: "主轨", clips: [] },
          { id: "ov1", kind: "overlay", name: "叠加", clips: [{ id: "shot", kind: "text", text: "叠加镜头", startMs: 0, durationMs: 6000 }] },
          { id: "a1", kind: "audio", name: "音频", clips: [{ id: "voice", kind: "audio", src: "assets/voice.wav", startMs: 0, durationMs: 6000 }] },
        ],
      }));
    });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent?.includes("剪辑台"))!.click());
    await page.waitForSelector('[aria-label="多轨时间线"]', { timeout: 20_000 });
    // Select the clip, move the playhead, then K records a keyframe at it.
    await page.locator('[aria-label="多轨时间线"] [aria-label="叠加 shot"]').click();
    const ruler = await page.$('[aria-label="时间标尺"]'); const box = await ruler!.boundingBox();
    await page.mouse.click(box!.x + 160, box!.y + box!.height / 2); // ~2000ms at 0.08 px/ms
    await page.keyboard.press("k");
    await page.waitForSelector('[aria-label="多轨时间线"] button[aria-label^="关键帧"]', { timeout: 10_000 });
    // Clicking a diamond seeks to its frame.
    await page.evaluate(() => (document.querySelector('button[aria-label="跳到开头"]') as HTMLElement)!.click());
    await page.locator('[aria-label="多轨时间线"] button[aria-label^="关键帧"]').click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="时间码"]') as HTMLElement | null)?.textContent?.includes("00:02"), { timeout: 10_000 });
    // B razors every track at the playhead.
    await page.keyboard.press("b");
    await page.waitForFunction(() => document.body.innerText.includes("剃刀已在播放头切分 2 个片段"), { timeout: 10_000 });
    await page.waitForSelector('[aria-label="多轨时间线"] [aria-label="叠加 shot-b"]', { timeout: 10_000 });
    // The transport bar steps one frame.
    const before = await page.evaluate(() => (document.querySelector('[aria-label="时间码"]') as HTMLElement | null)?.textContent ?? "");
    await page.evaluate(() => (document.querySelector('button[aria-label="下一帧"]') as HTMLElement)!.click());
    await page.waitForFunction(value => (document.querySelector('[aria-label="时间码"]') as HTMLElement | null)?.textContent !== value, before, { timeout: 10_000 });
    // ? opens the shortcut sheet; Esc closes it.
    await page.keyboard.press("?");
    await page.waitForSelector('[role="dialog"][aria-label="快捷键"]', { timeout: 10_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "glint-nle-shortcuts.png") });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="快捷键"]'), { timeout: 10_000 });
    await page.screenshot({ path: path.join(os.tmpdir(), "glint-nle-transport.png") });
    expect(errors).toEqual([]);
  } finally {
    await opened?.browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
