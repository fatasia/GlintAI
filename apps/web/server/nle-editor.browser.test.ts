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

const dist = fileURLToPath(new URL("../dist", import.meta.url));
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
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button")].find(button => button.textContent === "剪辑台")!.click());
    await page.waitForSelector('[aria-label="剪辑台"]', { timeout: 20_000 });
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
    await page.locator('[aria-label="多轨时间线"] [aria-label="T1 文字 title"]').click();
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
    await page.waitForFunction(() => document.body.innerText.includes("文字片段（3）"), { timeout: 10_000 });

    await page.screenshot({ path: path.join(os.tmpdir(), "glint-nle-v2.png") });
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ screenshot: path.join(os.tmpdir(), "glint-nle-v2.png"), events: (xml.match(/<asset-clip /g) ?? []).length }));
  } finally {
    await opened?.browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
