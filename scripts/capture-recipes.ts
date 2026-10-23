import fs from "node:fs";
import path from "node:path";
import { openCaptureBrowser } from "../apps/studio/scripts/direct-browser/host.ts";

const repo = path.resolve(import.meta.dirname, "..");
async function main() {
  const output = path.resolve(repo, "outputs/ui-review/recipes");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const { browser, page } = await openCaptureBrowser(1280, 900);
  try {
    await page.goto("http://127.0.0.1:4175/", { waitUntil: "networkidle0" });
    await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("summary")].find(element => element.textContent?.includes("模板库 · 100 个实用配方"))!.click());
    await page.waitForSelector('[aria-label="模板库"] article', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('[aria-label="模板库"]')?.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${output}-1280.png` });
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="模板库"] button')].find(button => button.textContent === "用这个开始")!.click());
    await new Promise(resolve => setTimeout(resolve, 800));
    await page.evaluate(() => document.querySelector('[aria-label="快速成片"]')?.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${output}-applied-1280.png` });
    console.log(JSON.stringify({ output: `${output}-{1280,applied-1280}.png`, recipes: await page.$$eval('[aria-label="模板库"] article', items => items.length) }));
  } finally { await browser.close(); }
}
void main();
