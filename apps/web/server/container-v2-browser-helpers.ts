import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import type { Page } from "puppeteer-core";
import type { ProjectContainerV2 } from "@glintai/scenescript/project-container-v2";
import { createWebServer } from "./index.mjs";
import { createProjectContainerStore } from "./project-container-session";
import { openCaptureBrowser } from "../../studio/scripts/direct-browser/host";

export const workspace = '[aria-label="作品工作台"]';
export async function openWorkspaceV2(dist: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-workspace-v2-"));
  const store = createProjectContainerStore(path.join(root, "containers"));
  const server = createWebServer({
    distDir: dist,
    projectContainerStoreFactory: () => store,
    requestLogDir: path.join(root, "logs"),
  }) as Server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opened = await openCaptureBrowser(1440, 1000);
  return {
    ...opened,
    root,
    store,
    origin,
    async close() {
      await opened.browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function paste(page: Page, selector: string, text: string) {
  await page.locator(selector).click();
  await page.$eval(selector, (element) => (element as HTMLInputElement).select());
  await page.keyboard.sendCharacter(text);
}
export async function mutate(page: Page, action: string, run: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/project-containers/${action}` &&
        response.request().method() === "POST",
    ),
    run(),
  ]);
  const result = await response.json();
  expect(response.status(), JSON.stringify(result)).toBe(200);
  if (action !== "open") expect(result.receipt.stage).toBe("verified");
  const revision = result.snapshot.revision as number;
  await page.waitForFunction(
    (selector, revision) =>
      document.querySelector(selector)?.textContent?.includes(`· r${revision}`),
    {},
    workspace,
    revision,
  );
  return result.snapshot.document as ProjectContainerV2;
}
export async function openTab(page: Page, text: string) {
  await page.waitForFunction(
    (selector, text) =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(`${selector} .container-document-tabs button`),
      ).some((button) => button.textContent?.includes(text)),
    {},
    workspace,
    text,
  );
  await page.evaluate(
    (selector, text) =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(`${selector} .container-document-tabs button`),
      )
        .find((button) => button.textContent?.includes(text))!
        .click(),
    workspace,
    text,
  );
}
export async function addDocument(page: Page, kind: string, title: string) {
  const tools = `${workspace} .container-document-tools`;
  await page.evaluate((selector) => {
    document.querySelector<HTMLDetailsElement>(selector)!.open = true;
  }, tools);
  await paste(page, `${tools} input[maxlength="200"]`, title);
  await page.select(`${tools} select`, kind);
  return mutate(page, "lifecycle", () => page.locator(`${tools} button[type="submit"]`).click());
}
export async function screenshotWidths(page: Page, name: string) {
  for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    if (process.env.GLINT_UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(
          process.env.GLINT_UI_SCREENSHOT_DIR,
          `${name}-${width}.png`,
        ) as `${string}.png`,
      });
  }
}
