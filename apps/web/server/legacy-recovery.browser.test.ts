import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {findSystemBrowser} from '../../studio/scripts/direct-browser/host';
import {startDesktopService} from './desktop-service.mjs';
const puppeteer=createRequire(new URL('../../studio/package.json',import.meta.url))('puppeteer-core');
it.skipIf(process.env.GLINT_BROWSER_UI_TEST!=='1')('imports a historical origin through the recovery UI and rolls back an interrupted import before mounting editors',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'glint-recovery-ui-'));
 let service:Awaited<ReturnType<typeof startDesktopService>>|undefined,browser:any;
 try{
  service=await startDesktopService({dataDir:path.join(root,'data'),distDir:fileURLToPath(new URL('../dist',import.meta.url))});
  browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});const page=await browser.newPage();
  const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(String(e)));
  await page.goto(service.url,{waitUntil:'networkidle0'});
  await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
  await page.locator('textarea[aria-label="快速成片资料"]').fill('# 从旧客户端恢复\n\n## 内容\n这份工程来自旧端口，需要导入后仍能打开和编辑。');
  await page.select('[aria-label="输入类型"]','source');await page.locator('.pc-submit').click();await page.waitForSelector('.glint-editor');
  await page.locator('button::-p-text(保存项目)').click();
  const saved=await page.evaluate(()=>localStorage.getItem('glint.projects'));expect(saved).toBeTruthy();
  const file=path.join(root,'origin-12345.json');fs.writeFileSync(file,JSON.stringify({version:1,origin:'http://127.0.0.1:12345',exportedAt:'2026-11-01',values:{'glint.projects':saved,'glint:theme':'light'}}));
  await page.evaluate(()=>{localStorage.setItem('glint.projects','[]');localStorage.setItem('glint:theme','dark');});
  await page.goto(service.url+'/#/recovery');await page.reload({waitUntil:'networkidle0'});
  await page.waitForSelector('[aria-label="旧客户端数据恢复"]');expect(await page.$('.glint-editor')).toBeNull();
  await (await page.$('input[type="file"]')).uploadFile(file);
  await page.waitForFunction(()=>document.body.textContent?.includes('待写入 2 条'));
  const importButton=page.locator('button::-p-text(备份当前记录并导入)');
  expect(await page.$eval('input[type="checkbox"]',(e:HTMLInputElement)=>e.checked)).toBe(false);
  await page.click('input[type="checkbox"]');await importButton.click();
  await page.waitForFunction(()=>document.body.textContent?.includes('导入已保存'));
  expect(await page.evaluate(()=>localStorage.getItem('glint.projects'))).toBe(saved);
  expect(JSON.parse(await page.evaluate(()=>localStorage.getItem('glint:legacy-recovery:backup:v1'))).entries[0].before).toBe('[]');
  await page.locator('button::-p-text(返回工作区)').click();await page.waitForSelector('.home-project');
  expect(await page.$eval('html',(e:HTMLElement)=>e.dataset.theme)).toBe('light');
  await page.locator('.home-project').click();await page.waitForSelector('.glint-editor');
  // A prepared WAL represents termination after one write but before commit.
  await page.evaluate(()=>{
   localStorage.setItem('glint:legacy-recovery:journal:v1',JSON.stringify({version:1,state:'prepared',entries:[{key:'glint:theme',before:'light',after:'dark'}]}));
   localStorage.setItem('glint:theme','dark');
  });
  await page.reload({waitUntil:'networkidle0'});
  expect(await page.evaluate(()=>localStorage.getItem('glint:legacy-recovery:journal:v1'))).toBeNull();
  expect(await page.$eval('html',(e:HTMLElement)=>e.dataset.theme)).toBe('light');
  expect(errors).toEqual([]);
 }finally{await browser?.close();await service?.close();fs.rmSync(root,{recursive:true,force:true});}
},60000);
