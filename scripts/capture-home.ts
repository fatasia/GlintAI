import fs from "node:fs";
import path from "node:path";
import { openCaptureBrowser } from "../apps/studio/scripts/direct-browser/host.ts";

const repo = path.resolve(import.meta.dirname, "..");

async function main() {
  const url = process.argv[2] ?? "http://127.0.0.1:4175/";
  const output = path.resolve(repo, process.argv[3] ?? "outputs/ui-review/home");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const { browser, page } = await openCaptureBrowser(1280, 900);
  try {
    await page.goto(url, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      localStorage.setItem("glint.projects", JSON.stringify([
        { id: "p1", name: "一分钟讲清熵", mode: "source", text: "资料", template: "explainer", theme: "glint-dark", aspect: "16:9", updatedAt: Date.parse("2026-10-22T20:10:00") },
        { id: "p2", name: "咖啡店开业宣传", mode: "idea", text: "一句话", template: "explainer", theme: "cream-editorial", aspect: "9:16", updatedAt: Date.parse("2026-10-21T18:30:00") },
        { id: "p3", name: "产品更新说明", mode: "source", text: "资料", template: "listicle", theme: "glint-light", aspect: "16:9", updatedAt: Date.parse("2026-10-20T09:12:00") },
      ]));
    });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise(resolve => setTimeout(resolve, 12500));
    await page.screenshot({ path: `${output}-1280.png` });
    await page.setViewport({ width: 480, height: 900 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.screenshot({ path: `${output}-480.png` });
    console.log(JSON.stringify({ output: `${output}-{1280,480}.png`, viewport: page.viewport() }));
  } finally {
    await browser.close();
  }
}
void main();
