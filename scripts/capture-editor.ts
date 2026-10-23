import fs from "node:fs";
import path from "node:path";
import { openCaptureBrowser } from "../apps/studio/scripts/direct-browser/host.ts";

const repo = path.resolve(import.meta.dirname, "..");
async function main() {
  const projectFile = process.argv[2] ?? "outputs/llm-live/idea-a86b73b2-a86f-41c1-903d-3ffdc557f355.project.json";
  const output = path.resolve(repo, process.argv[3] ?? "outputs/ui-review/editor");
  const project = JSON.parse(fs.readFileSync(path.resolve(repo, projectFile), "utf8")).project;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const { browser, page } = await openCaptureBrowser(1280, 900);
  try {
    await page.goto("http://127.0.0.1:4175/", { waitUntil: "networkidle0" });
    await page.evaluate((value) => {
      localStorage.setItem("glint.workspace", JSON.stringify({ mode: "source", text: "示例工程", template: "explainer", theme: "glint-dark", aspect: "16:9", project: value }));
    }, project);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label="分镜编辑器"]', { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    await page.evaluate(() => document.querySelector('[aria-label="分镜编辑器"]')?.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `${output}-edit-1280.png` });
    await page.evaluate(() => [...document.querySelectorAll('[aria-label="属性面板"] button')].find(button => button.textContent === "画面")?.click());
    await new Promise(resolve => setTimeout(resolve, 800));
    await page.screenshot({ path: `${output}-visual-1280.png` });
    await page.evaluate(() => [...document.querySelectorAll('[aria-label="属性面板"] button')].find(button => button.textContent === "改稿")?.click());
    await new Promise(resolve => setTimeout(resolve, 300));
    await page.screenshot({ path: `${output}-assistant-1280.png` });
    await page.evaluate(() => {
      const group = document.querySelector('[aria-label="工作区视图"]');
      const button = group ? [...group.querySelectorAll("button")].find(item => item.textContent === "创意") : null;
      (button as HTMLButtonElement | null)?.click();
    });
    await page.waitForFunction(() => document.querySelector('[aria-label="创意工作区"]')?.textContent?.includes("镜头总览"), { timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 800));
    await page.evaluate(() => document.querySelector('[aria-label="镜头画布"]')?.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${output}-board-1280.png` });
    console.log(JSON.stringify({ output: `${output}-{edit,board}-1280.png`, scenes: project.scenes?.length }));
  } finally {
    await browser.close();
  }
}
void main();
