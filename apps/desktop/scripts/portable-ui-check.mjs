import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

/** Execute the packaged JavaScript, not just an HTTP check of index.html. */
export async function verifyPackagedWebUi(url, repo) {
  const frozenPrototype = JSON.parse(fs.readFileSync(path.join(repo, "apps/desktop/tauri.conf.json"), "utf8")).app?.security?.freezePrototype === true;
  const require = createRequire(pathToFileURL(path.join(repo, "apps/studio/package.json")));
  const puppeteer = require("puppeteer-core");
  let browser;
  try {
    if (process.env.GLINT_CHROME_PATH) browser = await puppeteer.launch({ executablePath: process.env.GLINT_CHROME_PATH, headless: true });
    else {
      try { browser = await puppeteer.launch({ channel: "chrome", headless: true }); }
      catch { browser = await puppeteer.launch({ channel: "msedge", headless: true }); }
    }
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (frozenPrototype) await page.evaluateOnNewDocument(() => Object.freeze(Object.prototype));
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });
    const paths = '[aria-label="视频创作起点"]';
    for (const label of ["影像创作", "动态图形"]) {
      await page.waitForSelector(`${paths} button::-p-text(${label})`, { visible: true, timeout: 10_000 });
    }
    await page.waitForFunction(selector => {
      const buttons = [...document.querySelectorAll(`${selector} button`)];
      return ["影像创作", "动态图形"].every(label => buttons.some(button => button.textContent.includes(label) && !button.disabled));
    }, { timeout: 10_000 }, paths);
    await page.locator(`${paths} button::-p-text(动态图形)`).click();
    await page.waitForSelector('[aria-label="快速成片"]', { visible: true, timeout: 10_000 });
    assert.equal(await page.evaluate(() => Object.isFrozen(Object.prototype)), frozenPrototype);
    assert.deepEqual(errors, [], "Packaged desktop UI raised JavaScript errors");
    return { rendered: true, frozenPrototype };
  } finally { await browser?.close(); }
}
