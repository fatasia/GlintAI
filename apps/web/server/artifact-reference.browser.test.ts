import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect,it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
import { proposeArtifact } from "./artifact-proposal.mjs";
const puppeteer=createRequire(new URL("../../studio/package.json",import.meta.url))("puppeteer-core");
let available=false;try{findSystemBrowser();available=true;}catch{}
it.skipIf(!available||process.env.GLINT_BROWSER_UI_TEST!=="1")("attaches a real PNG to a scoped design proposal without storing image bytes in conversation history",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"glint-reference-ui-"));
 const document={id:"reference-doc",kind:"page",title:"参考页面",updatedAt:1,activePageId:"p",pages:[{id:"p",title:"首页",html:"<!doctype html><html><head></head><body></body></html>"}]};
 const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ArtifactAssistant}from'./ArtifactAssistant';import'./app-theme.css';function App(){const[doc,setDoc]=useState(${JSON.stringify(document)});return <><ArtifactAssistant projectId="reference-project" title="参考工程" document={doc} onApply={setDoc}/><output id="result">{JSON.stringify(doc)}</output></>;}createRoot(window.document.getElementById('app')).render(<App/>);`,resolveDir:fileURLToPath(new URL("../src",import.meta.url)),loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",outdir:"harness"});
 const calls:any[]=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/app.js')return res.writeHead(200,{'content-type':'text/javascript'}).end(bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text);
  if(req.url==='/app.css')return res.writeHead(200,{'content-type':'text/css'}).end(bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'');
  if(req.url==='/')return res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<link rel="stylesheet" href="/app.css"><style>body{max-width:640px;margin:24px auto}output{display:none}</style><div id="app"></div><script src="/app.js"></script>');
  if(req.url==='/api/artifact/proposal'){
   try{let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);
    const result=await proposeArtifact(request,{chat:async(value:any)=>{calls.push(value);return{text:JSON.stringify({document:{...request.document,pages:[{...request.document.pages[0],html:'<main><h1>参考图重建页面</h1><p>保留层次，重新设计</p></main>'}]},summary:'按截图层次生成可编辑页面'})};}});
    return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
   }catch(error){return res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:String(error)}));}
  }res.writeHead(404).end();
 });let browser:any;
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});const page=await browser.newPage();await page.setViewport({width:900,height:1000});
  const address=server.address() as {port:number};await page.goto(`http://127.0.0.1:${address.port}`,{waitUntil:'networkidle0'});
  const data=await page.evaluate(()=>{const canvas=window.document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#e9f3f7';ctx.fillRect(0,0,640,360);ctx.fillStyle='#173b53';ctx.fillRect(40,40,320,40);return canvas.toDataURL('image/png').split(',')[1]!;});
  const file=path.join(root,'reference.png');fs.writeFileSync(file,Buffer.from(data,'base64'));
  await (await page.$('[aria-label="上传设计参考截图"]'))!.uploadFile(file);
  await page.waitForSelector('img[alt="待发送的设计参考图"]');
  expect(calls).toHaveLength(0);
  await page.locator('[aria-label="文档创作指令"]').fill('参考截图重建页面，保留层次');await page.locator('button::-p-text(生成提案)').click();
  await page.waitForSelector('[aria-label="提案预览"]');expect(calls).toHaveLength(1);
  expect(calls[0].messages[0].images[0]).toEqual({mimeType:'image/png',data});
  expect(await page.$eval('#result',(node:Element)=>JSON.parse(node.textContent!).pages[0].html)).toBe(document.pages[0]!.html);
  await page.locator('button::-p-text(确认应用)').click();await page.waitForFunction(()=>window.document.querySelector('#result')?.textContent?.includes('参考图重建页面'));
  const histories=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('glint.artifact-assistant')).map(key=>localStorage.getItem(key)).join(''));
  expect(histories).not.toContain(data);expect(histories).toContain('参考截图重建页面');
 }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
},60000);
