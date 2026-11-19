// Captures the main shell routes at desktop, laptop and phone widths for design review
// and as the seed for visual-regression baselines.
// Usage: pnpm exec tsx scripts/capture-ui.ts [baseUrl] [outDir]
import fs from "node:fs";
import path from "node:path";
import { openCaptureBrowser } from "../apps/studio/scripts/direct-browser/host.ts";

const repo = path.resolve(import.meta.dirname, "..");
const base = (process.argv[2] ?? "http://127.0.0.1:4175/").replace(/\/?$/, "/");
const outDir = path.resolve(repo, process.argv[3] ?? "outputs/ui-review/shell");
const WIDTHS = [[1440, 900], [1024, 768], [390, 844]] as const;
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Page = Awaited<ReturnType<typeof openCaptureBrowser>>["page"];

async function clickText(page: Page, text: string): Promise<void> {
  const clicked = await page.evaluate(label => {
    const target = [...document.querySelectorAll<HTMLElement>("button, [role=tab], summary")].find(item => (item.textContent ?? "").replace(/[↗→⌄]/g, "").trim() === label && item.offsetParent);
    target?.click();
    return Boolean(target);
  }, text);
  if (!clicked) throw new Error(`Button not found: ${text}`);
  await settle(1200);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, page } = await openCaptureBrowser(1440, 900);
  const shots: string[] = [];
  const shoot = async (name: string) => {
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(path.relative(repo, file));
  };
  try {
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(base, { waitUntil: "networkidle0" });
    await settle(1500);
    // Create the sample project once; every width then revisits it through its route.
    await clickText(page, "用示例资料试试");
    await clickText(page, "开始创作");
    await page.waitForFunction(() => location.hash.startsWith("#/p/"), { timeout: 30000 });
    const projectHash = await page.evaluate(() => location.hash);
    for (const [width, height] of WIDTHS) {
      await page.setViewport({ width, height });
      const routes: [string, string][] = [["home", "#/"], ["project", projectHash], ["library", "#/library/create"], ["automation", "#/automation/canvas"], ["settings", "#/settings"], ["edit", "#/edit"]];
      for (const [name, hash] of routes) {
        await page.evaluate(next => { location.hash = next; }, hash);
        await settle(1800);
        await shoot(`${name}-${width}`);
      }
      await page.evaluate(next => { location.hash = next; }, projectHash);
      await settle(1200);
      for (const tab of ["创意", "脚本", "设计"]) {
        try { await clickText(page, tab); await shoot(`project-${tab}-${width}`); } catch { /* tab hidden at this width */ }
      }
      await clickText(page, "作品").catch(() => undefined);
    }
    // Reload on a deep link: the project must come back, not the home page.
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${base}${projectHash}`, { waitUntil: "networkidle0" });
    await settle(2500);
    const restored = await page.evaluate(() => ({ hash: location.hash, workspaceVisible: Boolean(document.querySelector('[aria-label="工程工作区"]:not([hidden])')) }));
    await shoot("project-after-reload-1440");
    console.log(JSON.stringify({ outDir: path.relative(repo, outDir), projectHash, restored, shots }, null, 2));
  } finally {
    await browser.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
