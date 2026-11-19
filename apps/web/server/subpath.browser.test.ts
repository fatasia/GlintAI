import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
import { openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error JavaScript HTTP host.
import { createWebServer } from "./index.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { openRestoredProject } from "./browser-workspace-helpers";

it.skipIf(process.env.GLINT_SUBPATH_UI_TEST !== "1")("creates, restores and previews local media without requesting a root API or asset", async () => {
 const dist = process.env.GLINT_SUBPATH_WEB_DIST;
 if (!dist || !path.isAbsolute(dist)) throw new Error("Build with GLINT_WEB_BASE_PATH=/glint/ and provide GLINT_SUBPATH_WEB_DIST");
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-subpath-browser-"));
 const media=path.join(root,"media");fs.mkdirSync(media);
 const server=createWebServer({basePath:"/glint/",distDir:dist,mediaJobs:createMediaJobs(media,{}),sessionStore:new FileSessionStore(path.join(root,"sessions"),document=>{parseProject(document);})}) as Server;
 let opened:Awaited<ReturnType<typeof openCaptureBrowser>>|undefined;
 try {
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  opened=await openCaptureBrowser(1440,960);const page=opened.page,requests:string[]=[],errors:string[]=[];
  page.on("request",request=>{if(request.url().startsWith(origin))requests.push(new URL(request.url()).pathname);});
  page.on("pageerror",error=>errors.push(String(error)));
  await page.goto(`${origin}/glint/`,{waitUntil:"networkidle0"});
  expect(await page.$eval('link[rel="manifest"]',link=>(link as HTMLLinkElement).href)).toBe(`${origin}/glint/manifest.webmanifest`);
  const worker=await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;return {scope:registration.scope,script:registration.active?.scriptURL};});
  expect(worker).toEqual({scope:`${origin}/glint/`,script:`${origin}/glint/sw.js`});
  await page.locator('[aria-label="视频创作起点"] button::-p-text(动态图形)').click();
  await page.locator('textarea[aria-label="快速成片资料"]').fill("# 子路径验收\n\n## 作品\n保存一个可编辑的作品，重新打开后检查素材预览。");
  await page.select('[aria-label="输入类型"]',"source");await page.locator('.pc-submit').click();
  await page.waitForSelector('.glint-editor',{visible:true});
  await page.locator('button::-p-text(保存项目)').click();
  const asset=await page.evaluate(async()=>{
   const canvas=document.createElement("canvas");canvas.width=128;canvas.height=128;const ctx=canvas.getContext("2d")!;ctx.fillStyle="#e0533d";ctx.fillRect(0,0,128,128);
   const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),"image/png"));
   const response=await fetch("/glint/api/media/import-image",{method:"POST",headers:{"content-type":"image/png"},body:blob});
   if(!response.ok)throw Error("Image import failed");const data=await response.json();
   const project=JSON.parse(localStorage.getItem("glint.workspace")!).project;
   const asset={name:data.name,url:`/api/media/assets/${data.name}`,bytes:blob.size};
   localStorage.setItem(`glint:project-assets.v1:${project.id}`,JSON.stringify([asset]));return asset;
  });
  await page.reload({waitUntil:"networkidle0"});await openRestoredProject(page);
  await page.locator('[aria-label="工作区视图"] button::-p-text(创意)').click();
  await page.locator(`[data-id="asset:${asset.name}"] button`).click();
  await page.waitForFunction(()=>document.querySelector<HTMLImageElement>('dialog[aria-label="项目素材预览"] img')?.naturalWidth===128);
  expect(await page.$eval('dialog img',image=>(image as HTMLImageElement).src)).toContain("/glint/api/media/assets/");
  await page.locator('button::-p-text(添加为新镜头)').click();
  await page.locator('[aria-label="工作区视图"] button::-p-text(作品)').click();
  await page.setViewport({width:390,height:844,deviceScaleFactor:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(process.env.GLINT_SUBPATH_EVIDENCE)await page.screenshot({path:process.env.GLINT_SUBPATH_EVIDENCE,fullPage:true});
  expect(requests.some(url=>url.startsWith("/glint/api/"))).toBe(true);
  expect(requests.filter(url=>!url.startsWith("/glint/"))).toEqual([]);
  expect(errors).toEqual([]);
  const manifest=await (await fetch(`${origin}/glint/manifest.webmanifest`)).json();expect(manifest.scope).toBe("./");
 } finally {await opened?.browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
},90000);
