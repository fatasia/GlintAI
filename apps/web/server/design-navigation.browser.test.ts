import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {expect,it} from 'vitest';
import {findSystemBrowser} from '../../studio/scripts/direct-browser/host';
import {prepareDesign,designHtml} from './design-export-html.mjs';
const puppeteer=createRequire(new URL('../../studio/package.json',import.meta.url))('puppeteer-core');
let available=false;try{findSystemBrowser();available=true;}catch{}
it.skipIf(!available||process.env.GLINT_BROWSER_UI_TEST!=='1')('connects mobile pages through editable targets, reopens them and preserves navigation in offline HTML',async()=>{
 const document={id:'site',title:'活动报名',kind:'prototype',activePageId:'home',updatedAt:0,pages:[
  {id:'home',title:'首页',html:'<!doctype html><html><body><h1 data-design-id="heading">周末设计工作坊</h1><a data-design-id="go">查看活动详情</a></body></html>'},
  {id:'detail',title:'详情',html:'<!doctype html><html><body><h1 data-design-id="heading">活动详情与报名</h1><button data-design-id="back" data-design-page="home">返回首页</button><details><summary>报名说明</summary><p>请填写姓名。</p><input aria-label="姓名"></details></body></html>'}
 ]};
 const state={version:1,projectId:'navigation-project',activeId:'site',documents:[document]};
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{DesignEditor}from'./DesignEditor';import'./app-theme.css';if(!localStorage.getItem('glint.project-designs.v1:navigation-project'))localStorage.setItem('glint.project-designs.v1:navigation-project',${JSON.stringify(JSON.stringify(state))});createRoot(document.getElementById('app')).render(<DesignEditor projectId="navigation-project"/>);`,resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',outdir:'harness'});
 let exported='';const server=createServer((req,res)=>{if(req.url==='/app.js')return res.writeHead(200,{'content-type':'text/javascript'}).end(bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text);if(req.url==='/app.css')return res.writeHead(200,{'content-type':'text/css'}).end(bundle.outputFiles.find(file=>file.path.endsWith('.css'))!.text);if(req.url==='/export')return res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(exported);res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<link rel="stylesheet" href="/app.css"><div id="app"></div><script src="/app.js"></script>');});let browser:any;
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address()as{port:number}).port}`;browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});const page=await browser.newPage();await page.setViewport({width:1440,height:960});await page.goto(origin,{waitUntil:'networkidle0'});
  await page.locator('button::-p-text(属性)').click();await page.locator('[data-design-layer="go"] input').click();await page.waitForSelector('[aria-label="跳转页面"]');await page.select('[aria-label="跳转页面"]','detail');await page.locator('.design-toolbar button::-p-text(保存)').click();
  await page.locator('[aria-label="元素文字"]').fill('尚未应用的跳转文字');
  await page.locator('[aria-label="选择页面 2 详情"]').click();
  expect(await page.$eval('[aria-label="页面标题"]',(el:HTMLInputElement)=>el.value)).toBe('首页');
  expect(await page.$eval('[aria-label="元素文字"]',(el:HTMLTextAreaElement)=>el.value)).toBe('尚未应用的跳转文字');
  expect(await page.$eval('body',(el:HTMLElement)=>el.textContent)).toContain('元素属性尚未应用');
  await page.locator('[data-design-layer="heading"] input').click();
  expect(await page.$eval('[aria-label="元素文字"]',(el:HTMLTextAreaElement)=>el.value)).toBe('尚未应用的跳转文字');
  await page.locator('button::-p-text(应用属性)').click();
  await page.locator('[aria-label="选择页面 2 详情"]').click();
  await page.waitForFunction(()=>(document.querySelector('[aria-label="页面标题"]')as HTMLInputElement)?.value==='详情');
  await page.locator('[aria-label="选择页面 1 首页"]').click();
  await page.locator('.design-toolbar button::-p-text(保存)').click();
  await page.reload({waitUntil:'networkidle0'});await page.locator('button::-p-text(运行交互)').click();
  const inner=async(selector:string)=>{let found:any;await page.waitForFunction(()=>!!document.querySelector('iframe[title="设计预览"]'));for(let i=0;i<100;i++){for(const frame of page.frames()){if(await frame.$(selector).catch(()=>null)){found=frame;break;}}if(found)return found;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Missing interactive target '+selector);};
  await (await inner('[data-design-id="go"]')).click('[data-design-id="go"]');
  await page.waitForFunction(()=>(document.querySelector('[aria-label="页面标题"]')as HTMLInputElement)?.value==='详情');
  expect(await page.$eval('.design-stage-toolbar', (el:HTMLElement)=>el.textContent)).toContain('返回点选');
  const detail=await inner('[data-design-id="back"]');await detail.click('summary');await detail.type('[aria-label="姓名"]','测试者');expect(await detail.$eval('[aria-label="姓名"]',(el:HTMLInputElement)=>el.value)).toBe('测试者');await detail.click('[data-design-id="back"]');
  await page.waitForFunction(()=>(document.querySelector('[aria-label="页面标题"]')as HTMLInputElement)?.value==='首页');await page.locator('.design-toolbar button::-p-text(保存)').click();
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('glint.project-designs.v1:navigation-project')!).documents[0]);exported=designHtml(saved,await prepareDesign(saved));
  const offline=await browser.newPage();await offline.setViewport({width:390,height:844});await offline.goto(origin+'/export',{waitUntil:'networkidle0'});let child=await(await offline.$('iframe'))!.contentFrame();await child!.waitForSelector('[data-design-id="go"]');await child!.click('[data-design-id="go"]');await offline.waitForFunction(()=>location.hash==='#design-page-1');child=await(await offline.$('iframe'))!.contentFrame();await child!.waitForSelector('[data-design-id="back"]');await child!.click('[data-design-id="back"]');await offline.waitForFunction(()=>location.hash==='#design-page-0');
  expect(await offline.evaluate(()=>({x:document.documentElement.scrollWidth<=innerWidth,y:document.documentElement.scrollHeight<=innerHeight}))).toEqual({x:true,y:true});
  if(process.env.GLINT_DESIGN_NAVIGATION_EVIDENCE){fs.mkdirSync(process.env.GLINT_DESIGN_NAVIGATION_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.GLINT_DESIGN_NAVIGATION_EVIDENCE,'prototype.html'),exported);await offline.screenshot({path:path.join(process.env.GLINT_DESIGN_NAVIGATION_EVIDENCE,'mobile.png')});}
 }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},60000);
