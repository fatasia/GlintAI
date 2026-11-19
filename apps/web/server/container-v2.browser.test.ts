import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
import { appendContainerDocuments } from "./project-container-session";
import {
  addDocument,
  mutate,
  openTab,
  openWorkspaceV2,
  paste,
  screenshotWidths,
  workspace,
} from "./container-v2-browser-helpers";
const dist = process.env.GLINT_TEST_WEB_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
let available = false;
try {
  findSystemBrowser();
  available = true;
} catch {
  /* No implicit downloads. */
}

async function createScript(context: Awaited<ReturnType<typeof openWorkspaceV2>>) {
  const { page, origin } = context;
  await page.goto(`${origin}/#/c`, { waitUntil: "networkidle0" });
  await paste(page, '.container-document-form input[maxlength="200"]', "统一创作测试");
  await page.select(".container-document-form select", "script-document");
  return mutate(page, "open", () =>
    page.locator('.container-document-form button[type="submit"]').click(),
  );
}
async function exerciseScript(context: Awaited<ReturnType<typeof openWorkspaceV2>>) {
  const { page } = context,
    selector = 'textarea[aria-label="脚本文档正文"]';
  await page.waitForSelector(selector, { visible: true });
  const snapshot = await mutate(page, "append", () =>
    paste(page, selector, "## 镜头一\n统一作品的原文"),
  );
  await page.waitForFunction(() =>
    document.querySelector(".script-save-status")?.textContent?.match(/草稿已就绪|已载入外部版本/),
  );
  await screenshotWidths(page, "workspace-v2-script");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(
    (selector) =>
      document.querySelector<HTMLTextAreaElement>(selector)?.value === "## 镜头一\n统一作品的原文",
    {},
    selector,
  );
  await retainDraftOnServerConflict(context, snapshot, selector);
  return snapshot;
}
/** A rejected write keeps the local draft: an outside writer commits first, the next save conflicts. */
async function retainDraftOnServerConflict(
  context: Awaited<ReturnType<typeof openWorkspaceV2>>,
  snapshot: Awaited<ReturnType<typeof mutate>>,
  selector: string,
) {
  const { page, store } = context;
  const baseRevision = store.snapshot(snapshot.id).snapshot.revision,
    objectId = snapshot.objects[0]!.id,
    payload = {
      ...snapshot.versions.find((v) => v.objectId === objectId)!.payload,
      content: "外部入口已修改",
      updatedAt: Date.now(),
    } as Record<string, unknown>;
  await appendContainerDocuments(
    store,
    snapshot.id,
    { id: "external-write", baseRevision, actor: "cli", scope: {}, intent: "外部入口修改" },
    [{ objectId, versionId: "external-v1", payload }],
  );
  await paste(page, selector, "## 镜头一\n本地草稿保留");
  // The shared save-status region surfaces the CAS refusal with a recovery action; the editor buffer keeps the draft.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[aria-label="保存状态"] button')].some(
      (item) => item.textContent === "备份草稿并接续共享版本",
    ),
  );
  expect(await page.$eval(selector, (element) => (element as HTMLTextAreaElement).value)).toBe(
    "## 镜头一\n本地草稿保留",
  );
  await screenshotWidths(page, "workspace-v2-conflict");
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('[aria-label="保存状态"] button')].find(
      (item) => item.textContent === "备份草稿并接续共享版本",
    );
    if (!button || (button as HTMLButtonElement).disabled)
      throw new Error("Reload button is not clickable");
    (button as HTMLButtonElement).click();
  });
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.textContent?.includes("已接续共享版本") &&
      document.querySelector(".script-save-status")?.textContent?.includes("已载入外部版本"),
    {},
    '[aria-label="作品工作台"]',
  );
  expect(await page.$eval(selector, (element) => (element as HTMLTextAreaElement).value)).toBe(
    "外部入口已修改",
  );
}
async function exerciseDesign(context: Awaited<ReturnType<typeof openWorkspaceV2>>) {
  const { page } = context;
  await addDocument(page, "design-document", "设计稿");
  await page.waitForSelector('[aria-label="设计文档编辑器"]', { visible: true });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.design-toolbar [role="status"]')].some(
      (element) =>
        element.textContent?.includes("已保存") ||
        element.textContent?.includes("草稿已就绪") ||
        element.textContent?.includes("已载入"),
    ),
  );
  await paste(page, 'input[aria-label="设计文档标题"]', "修改后的设计");
  await mutate(page, "append", () => page.locator('input[aria-label="页面标题"]').click());
  await page.waitForFunction(() =>
    document.querySelector(".design-save-status")?.textContent?.match(/草稿已就绪|已载入外部版本/),
  );
  await screenshotWidths(page, "workspace-v2-design");
}
async function exercisePreviz(context: Awaited<ReturnType<typeof openWorkspaceV2>>) {
  const { page } = context;
  await addDocument(page, "previz-document", "人物预演");
  await page.waitForSelector('[aria-label="镜头几何预演"]', { visible: true });
  await screenshotWidths(page, "workspace-v2-previz");
}
async function archiveAndUndo(context: Awaited<ReturnType<typeof openWorkspaceV2>>) {
  const { page } = context;
  await openTab(page, "修改后的设计");
  await page.waitForSelector('[aria-label="设计文档编辑器"]', { visible: true });
  await page.waitForFunction(
    () =>
      document.querySelector(".design-save-status")?.textContent?.includes("已保存") ||
      document.querySelector(".design-save-status")?.textContent?.includes("已载入"),
  );
  const tools = `${workspace} .container-document-tools`;
  await page.evaluate((selector) => {
    document.querySelector<HTMLDetailsElement>(selector)!.open = true;
    document.querySelector<HTMLInputElement>(`${selector} input[type="checkbox"]`)!.click();
  }, tools);
  await mutate(page, "lifecycle", () =>
    page.evaluate((selector) => {
      const button = [...document.querySelectorAll(`${selector} button`)].find(
        (item) => item.textContent === "归档当前文档",
      );
      if (!button || (button as HTMLButtonElement).disabled)
        throw new Error("Archive button is not clickable");
      (button as HTMLButtonElement).click();
    }, tools),
  );
  await mutate(page, "undo", () =>
    page.evaluate((selector) => {
      const button = [...document.querySelectorAll(`${selector} .workspace-bar button`)].find(
        (item) => item.textContent === "撤销作品修改",
      );
      if (!button || (button as HTMLButtonElement).disabled)
        throw new Error("Undo button is not clickable");
      (button as HTMLButtonElement).click();
    }, workspace),
  );
  await page.waitForSelector('[aria-label="设计文档编辑器"]', { visible: true });
  expect(
    await page.$eval(
      'input[aria-label="设计文档标题"]',
      (element) => (element as HTMLInputElement).value,
    ),
  ).toBe("修改后的设计");
}
async function reopenFromWorkList(
  context: Awaited<ReturnType<typeof openWorkspaceV2>>,
  title: string,
) {
  const { page, origin } = context;
  await page.goto(`${origin}/#/c`, { waitUntil: "networkidle0" });
  await page.evaluate((target) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.getAttribute("aria-label") === `打开作品：${target}`,
    );
    if (!button) throw new Error(`Work list is missing an entry for ${target}`);
    button.click();
  }, title);
  await page.waitForSelector(workspace, { visible: true });
  await page.waitForFunction(
    (selector) =>
      document.querySelectorAll(`${selector} .container-document-tabs button`).length === 5,
    {},
    workspace,
  );
  const undo = await page.$eval(
    `${workspace} .workspace-bar button`,
    (element) => !(element as HTMLButtonElement).disabled,
  );
  expect(undo).toBe(true);
  await screenshotWidths(page, "workspace-v2-reopened");
}
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)(
  "creates five document kinds in one persistent work, shares history and retains standalone stores at three widths",
  async () => {
    if (!fs.existsSync(path.join(dist, "index.html")))
      throw new Error("Build Web before browser verification");
    const context = await openWorkspaceV2(dist),
      errors: string[] = [];
    context.page.on("pageerror", (error) => errors.push(String(error)));
    try {
    const created = await createScript(context);
      expect(created.version).toBe(2);
      await exerciseScript(context);
      await exerciseDesign(context);
      await exercisePreviz(context);
      await addDocument(context.page, "timeline-document", "剪辑稿");
      await context.page.waitForSelector('input[aria-label="剪辑标题"]', { visible: true });
      await addDocument(context.page, "scene-document", "分镜稿");
      await context.page.waitForSelector('[aria-label="分镜编辑器"]', { visible: true });
      await archiveAndUndo(context);
      await reopenFromWorkList(context, "统一创作测试");
      const saved = context.store.snapshot(created.id).snapshot.document;
      expect(saved.objects as unknown[]).toHaveLength(5);
      expect(
        await context.page.evaluate(() =>
          Object.keys(localStorage).filter((key) =>
            /^glint\.(project-documents|project-designs|nle)\./.test(key),
          ),
        ),
      ).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  90_000,
);
