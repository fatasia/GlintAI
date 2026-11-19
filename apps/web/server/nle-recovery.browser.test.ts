import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect,it } from "vitest";
import { openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error server module
import { createWebServer } from "./index.mjs";
it.skipIf(process.env.GLINT_BROWSER_UI_TEST!=="1")("preserves damaged NLE bytes and detects another window instead of overwriting its timeline",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-nle-recovery-"));
 const server=createWebServer({distDir:process.env.GLINT_TEST_WEB_DIST??fileURLToPath(new URL('../dist',import.meta.url)),requestLogDir:path.join(root,'logs')});
 let opened:Awaited<ReturnType<typeof openCaptureBrowser>>|undefined;
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));opened=await openCaptureBrowser(1280,900);const {page}=opened;
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;await page.goto(url,{waitUntil:'networkidle0'});
  await page.evaluate(()=>localStorage.setItem('glint.nle.project.v2','broken original'));await page.reload({waitUntil:'networkidle0'});
  await page.locator('.rail-button::-p-text(剪辑台)').click();await page.waitForSelector('.nle-alert');
  expect(await page.$eval('.nle-alert',el=>el.textContent)).toContain('保留');
  await page.locator('[aria-label="剪辑标题"]').fill('内存中修改');
  expect(await page.evaluate(()=>localStorage.getItem('glint.nle.project.v2'))).toBe('broken original');
  await page.evaluate(()=>{localStorage.removeItem('glint.nle.project.v2');localStorage.removeItem('glint.nle.session.v1');});
  await page.reload({waitUntil:'networkidle0'});await page.locator('.rail-button::-p-text(剪辑台)').click();
  await page.waitForFunction(()=>Boolean(localStorage.getItem('glint.nle.session.v1')));
  await page.evaluate(()=>localStorage.setItem('glint.nle.project.v2','foreign window'));
  await page.locator('[aria-label="剪辑标题"]').fill('迟到修改');
  await page.waitForFunction(()=>document.querySelector('.nle-alert')?.textContent?.includes('其他窗口'));
  expect(await page.evaluate(()=>localStorage.getItem('glint.nle.project.v2'))).toBe('foreign window');
  await page.screenshot({path:path.join(root,'conflict.png')});console.log('NLE recovery evidence:',root);
 }finally{await opened?.browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},45000);
