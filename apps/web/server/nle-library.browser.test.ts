import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { expect,it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
import { startDesktopService } from "./desktop-service.mjs";
const puppeteer=createRequire(new URL("../../studio/package.json",import.meta.url))("puppeteer-core");
const dist=process.env.GLINT_TEST_WEB_DIST??fileURLToPath(new URL("../dist",import.meta.url));
let available=false;try{findSystemBrowser();available=true;}catch{}
it.skipIf(!available||process.env.GLINT_BROWSER_UI_TEST!=="1")("keeps independent NLE projects and undo history across service and browser restart",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-nle-library-"));let service:any,browser:any;
 const launch=()=>puppeteer.launch({executablePath:findSystemBrowser(),headless:true,userDataDir:path.join(root,"profile")});
 try{
  service=await startDesktopService({dataDir:path.join(root,"data"),distDir:dist});browser=await launch();let page=await browser.newPage();
  await page.setViewport({width:1440,height:960});await page.goto(service.url,{waitUntil:"networkidle0"});
  await page.locator('.rail-button::-p-text(剪辑台)').click();await page.waitForSelector('[aria-label="多轨时间线"]');
  await page.locator('[aria-label="剪辑标题"]').fill('第一份剪辑');await page.locator('button::-p-text(+ 文字)').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('glint.nle.record.v1:nle-local')!).pair.project.includes('新文字'));
  const first=await page.evaluate(()=>localStorage.getItem('glint.nle.record.v1:nle-local'));
  // Switching projects aborts the old render and cannot attach its result to the new project.
  await page.setRequestInterception(true);let pendingRender:any;
  page.on('request',(request:any)=>{if(request.url().endsWith('/api/nle/render'))pendingRender=request;else void request.continue();});
  await page.locator('button::-p-text(渲染 MP4)').click();
  await new Promise<void>((resolve,reject)=>{const started=Date.now();const poll=()=>pendingRender?resolve():Date.now()-started>5000?reject(new Error('render request missing')):setTimeout(poll,20);poll();});
  const aborted=new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('old render was not aborted')),5000);page.on('requestfailed',(request:any)=>{if(request===pendingRender){clearTimeout(timer);resolve(request.failure()?.errorText??'');}});});
  await page.locator('.nle-menu-wrap summary::-p-text(工程)').click();await page.locator('button::-p-text(新建剪辑)').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('glint.nle.project.v2')!).id!=='nle-local');
  const secondId=await page.evaluate(()=>JSON.parse(localStorage.getItem('glint.nle.project.v2')!).id);
  expect(await aborted).toContain('ABORTED');
  await page.waitForNetworkIdle();expect(await page.$('a[href*="old-project.mp4"]')).toBeNull();
  expect(await page.$eval('section[aria-label="剪辑台"]',(el:HTMLElement)=>el.textContent?.includes('成片已生成'))).toBe(false);

  expect(await page.evaluate(()=>localStorage.getItem('glint.nle.record.v1:nle-local'))).toBe(first);
  await page.locator('[aria-label="剪辑标题"]').fill('第二份剪辑');
  await page.locator('button::-p-text(+ 文字)').click();
  await page.waitForFunction((id:string)=>JSON.parse(localStorage.getItem('glint.nle.record.v1:'+id)!).pair.project.includes('新文字'),{},secondId);
  await page.locator('button::-p-text(剪辑工程库)').click();await page.waitForSelector('dialog[aria-label="剪辑工程库"]');
  await page.locator('dialog button::-p-text(第一份剪辑)').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('glint.nle.project.v2')!).id==='nle-local');
  const second=await page.evaluate((id:string)=>localStorage.getItem('glint.nle.record.v1:'+id),secondId);
  const origin=service.url;await browser.close();browser=undefined;await service.close();service=undefined;
  service=await startDesktopService({dataDir:path.join(root,"data"),distDir:dist});expect(service.url).toBe(origin);browser=await launch();page=await browser.newPage();
  await page.setViewport({width:1440,height:960});await page.goto(service.url,{waitUntil:"networkidle0"});await page.locator('.rail-button::-p-text(剪辑台)').click();
  await page.waitForSelector('[aria-label="剪辑标题"]');expect(await page.$eval('[aria-label="剪辑标题"]',(el:HTMLInputElement)=>el.value)).toBe('第一份剪辑');
  await page.locator('section[aria-label="剪辑台"] button[aria-label="撤销"]').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('glint.nle.project.v2')!).tracks.every((track:any)=>!track.clips.length));
  expect(await page.evaluate((id:string)=>localStorage.getItem('glint.nle.record.v1:'+id),secondId)).toBe(second);
  await page.locator('.nle-menu-wrap summary::-p-text(工程)').click();await page.locator('button::-p-text(剪辑工程库)').click();
  await page.locator('dialog button::-p-text(第二份剪辑)').click();
  await page.waitForFunction((id:string)=>JSON.parse(localStorage.getItem('glint.nle.project.v2')!).id===id,{},secondId);
  expect(await page.$eval('[aria-label="剪辑标题"]',(el:HTMLInputElement)=>el.value)).toBe('第二份剪辑');
  expect(await page.$('section[aria-label="剪辑台"] .nle-alert')).toBeNull();
  // Restore through the same WAL used by main-project Git/ZIP, while NLE is still mounted.
  const storageBundle=await build({stdin:{contents:"export {captureProjectWorkspace,prepareGitStorage} from './project-git-storage';",resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'iife',globalName:'testWorkspaceRestore',platform:'browser'});
  await page.addScriptTag({content:storageBundle.outputFiles[0]!.text});
  await page.evaluate((id:string)=>{const api=(window as any).testWorkspaceRestore,value=api.captureProjectWorkspace(id);value.timeline.project.title='恢复的剪辑版本';const tx=api.prepareGitStorage(id,undefined,value);tx.write();tx.commit();tx.finish();},secondId);
  expect(await page.$eval('[aria-label="剪辑标题"]',(el:HTMLInputElement)=>el.value)).toBe('第二份剪辑');
  await page.locator('button::-p-text(剪辑工程库)').click();await page.locator('dialog button::-p-text(恢复的剪辑版本)').click();
  await page.waitForFunction(()=>(document.querySelector('[aria-label="剪辑标题"]')as HTMLInputElement)?.value==='恢复的剪辑版本');
  expect(await page.$eval('section[aria-label="剪辑台"] button[aria-label="撤销"]',(el:HTMLButtonElement)=>el.disabled)).toBe(true);
  await page.locator('button::-p-text(+ 文字)').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('glint.nle.project.v2')!).tracks.flatMap((track:any)=>track.clips).length===2);
  expect(await page.$('section[aria-label="剪辑台"] .nle-alert')).toBeNull();
  await page.evaluate((id:string)=>{const api=(window as any).testWorkspaceRestore,value=api.captureProjectWorkspace(id);value.timeline.project.title='恢复后立即重启';const tx=api.prepareGitStorage(id,undefined,value);tx.write();tx.commit();tx.finish();},secondId);
  await page.reload({waitUntil:'networkidle0'});await page.locator('.rail-button::-p-text(剪辑台)').click();
  await page.waitForFunction(()=>(document.querySelector('[aria-label="剪辑标题"]')as HTMLInputElement)?.value==='恢复后立即重启');
  expect(await page.$('section[aria-label="剪辑台"] .nle-alert')).toBeNull();
  if(process.env.GLINT_NLE_LIBRARY_EVIDENCE){fs.mkdirSync(process.env.GLINT_NLE_LIBRARY_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.GLINT_NLE_LIBRARY_EVIDENCE,'restored-second.png'),fullPage:true});}
 }finally{await browser?.close();await service?.close();fs.rmSync(root,{recursive:true,force:true});}
},90000);
