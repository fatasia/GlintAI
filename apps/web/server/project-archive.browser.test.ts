import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { expect,it } from "vitest";
import { openCaptureBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error native module
import { createProjectArchiveHost } from "./project-archive-host.mjs";
// @ts-expect-error native module
import { openSecureAssets } from "./secure-assets-bridge.mjs";

it.skipIf(process.platform!=="win32")("exports and restores a full project ZIP through the real UI and pinned Windows asset store",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-project-archive-ui-"));
 const media=path.join(root,"media");fs.mkdirSync(media);
 execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=red:s=16x16","-frames:v","1",path.join(media,"cover.png")],{windowsHide:true});
 const bytes=fs.statSync(path.join(media,"cover.png")).size;
 const executable=fileURLToPath(new URL("../../desktop/secure-assets/target/release/glint-secure-assets.exe",import.meta.url));
 const host=createProjectArchiveHost({openStore:()=>openSecureAssets(executable,media)});
 const project={schemaVersion:1,id:"archive-ui",title:"带素材的项目",aspect:"16:9",knowledgeSources:[],scenes:[{id:"one",kind:"title",title:"标题",narration:{text:"正文",durationMs:1000}}]};
 const workspace={version:1,projectId:project.id,designs:{version:1,projectId:project.id,activeId:"page",documents:[{id:"page",title:"设计页",kind:"page",activePageId:"one",updatedAt:1,pages:[{id:"one",title:"页面",html:'<img src="/api/media/assets/cover.png">'}]}]},brand:null,assets:[{name:"cover.png",url:"/api/media/assets/cover.png",bytes}]};
 const bundled=await build({stdin:{contents:`
 import React,{useState}from'react';import{createRoot}from'react-dom/client';
 import{ProjectArchivePanel}from'./ProjectArchivePanel';import{prepareGitStorage,recoverGitWorkspace,captureProjectWorkspace}from'./project-git-storage';
 window.glintDesktop={request:async body=>(await fetch('/native',{method:'POST',body:JSON.stringify(body)})).json()};
 const original=${JSON.stringify(project)},workspace=${JSON.stringify(workspace)};
 function App(){const restored=recoverGitWorkspace();const[project,setProject]=useState(restored?.project??original);return <>
 <output aria-label="当前工程">{project.id}</output><ProjectArchivePanel kind="scene" project={project} documents={[]} getWorkspace={()=>project.id===original.id?workspace:captureProjectWorkspace(project.id)} onApply={()=>false} onCopy={(next,docs,attachments)=>{const tx=prepareGitStorage(next.id,{version:1,projectId:next.id,documents:docs??[],activeId:''},attachments,undefined,true,next);tx.write();tx.commit();tx.finish();setProject(next);return true;}}/>
 </>};createRoot(document.getElementById('app')).render(<App/>);`,resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',outdir:'harness'});
 const server=createServer(async(req,res)=>{try{if(req.url==='/native'){const chunks=[];for await(const chunk of req)chunks.push(chunk);let result;try{result=await host.request(JSON.parse(Buffer.concat(chunks).toString()));}catch(error){result={ok:false,error:String(error)};}res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}else{res.setHeader('content-type','text/html');res.end('<style>'+(bundled.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'')+'</style><div id="app"></div><script>'+bundled.outputFiles.find(file=>file.path.endsWith('.js'))!.text.replaceAll('</script','<\\/script')+'</script>');}}catch{res.writeHead(500);res.end();}});
 let opened:Awaited<ReturnType<typeof openCaptureBrowser>>|undefined;
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));opened=await openCaptureBrowser(1280,900);const {page,browser}=opened;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const cdp=await browser.target().createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:root,eventsEnabled:true});
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`,{waitUntil:'networkidle0'});
  await page.locator('summary::-p-text(整项目 ZIP)').click();
  await page.locator('button::-p-text(导出完整工程 ZIP)').click();
  const archive=path.join(root,'glint-archive-ui.zip');
  const deadline=Date.now()+30000;while(!fs.existsSync(archive)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  expect(fs.existsSync(archive)).toBe(true);
  await page.waitForFunction(()=>!document.querySelector('[role="status"]'));
  await (await page.$('input[aria-label="完整工程 ZIP 文件"]'))!.uploadFile(archive);
  await page.waitForSelector('[aria-label="工程包导入预览"]',{visible:true,timeout:30000}).catch(async(error:unknown)=>{console.error('archive preview failure',await page.evaluate(()=>document.body.innerText));throw error;});
  expect(await page.$eval('[aria-label="工程包导入预览"]',el=>el.textContent)).toContain('1 个素材');
  await page.locator('[aria-label="工程包导入预览"] input[type="checkbox"]').click();
  await page.locator('button::-p-text(确认恢复工程)').click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="当前工程"]')?.textContent!=='archive-ui');
  const id=await page.$eval('[aria-label="当前工程"]',el=>el.textContent);
  await page.reload({waitUntil:'networkidle0'});expect(await page.$eval('[aria-label="当前工程"]',el=>el.textContent)).toBe(id);
  const saved=await page.evaluate(id=>JSON.parse(localStorage.getItem('glint.project-designs.v1:'+id)!),id);
  expect(saved.documents).toEqual(workspace.designs.documents);expect(errors).toEqual([]);
  await page.screenshot({path:path.join(root,'restored.png')});console.log('Project archive evidence:',root);
 }finally{await opened?.browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await host.dispose();}
},90000);
