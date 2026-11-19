import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {startDesktopService} from './desktop-service.mjs';
import {findSystemBrowser} from '../../studio/scripts/direct-browser/host';
const puppeteer=createRequire(new URL('../../studio/package.json',import.meta.url))('puppeteer-core');
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const output=path.resolve(process.argv[2]??path.join(repo,'../outputs/slides-video-'+Date.now()));
if(fs.existsSync(output))throw new Error('Use a new evidence directory');fs.mkdirSync(output,{recursive:true});
const service=await startDesktopService({dataDir:path.join(output,'data'),distDir:path.join(repo,'apps/web/dist'),studioDir:path.join(repo,'apps/studio')});
const inputDocument=process.env.GLINT_DESIGN_ACCEPTANCE_DOCUMENT?JSON.parse(fs.readFileSync(process.env.GLINT_DESIGN_ACCEPTANCE_DOCUMENT,'utf8')):null;
if(inputDocument&&inputDocument.kind!=='slides')throw new Error('Acceptance document must be slides');
const browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});
let page:any;
try{
 page=await browser.newPage();await page.setViewport({width:1440,height:1000});const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(String(error)));
 await page.goto(service.url,{waitUntil:'networkidle0'});
 await page.locator('textarea[aria-label="快速成片资料"]').fill('# 幻灯片转视频\n\n## 验证\n从可编辑演示稿生成真实视频。');
 await page.select('[aria-label="输入类型"]','source');await page.locator('.pc-submit').click();await page.waitForSelector('.glint-editor');
 if(inputDocument){
  await page.locator('button::-p-text(保存项目)').click();
  await page.evaluate((document:any)=>{const saved=JSON.parse(localStorage.getItem('glint.projects')!)[0],id=saved.project.id;localStorage.setItem('glint.project-designs.v1:'+id,JSON.stringify({version:1,projectId:id,documents:[document],activeId:document.id}));},inputDocument);
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.home-project');await page.locator('.home-project').click();await page.waitForSelector('.glint-editor');
 }
 await page.locator('.glint-editor button::-p-text(设计)').click();await page.waitForSelector('[aria-label="切换设计文档"]');
 const slides=await page.$eval('[aria-label="切换设计文档"]',(e:HTMLSelectElement)=>[...e.options].find(o=>o.textContent?.startsWith('幻灯片'))!.value);
 await page.select('[aria-label="切换设计文档"]',slides);
 if(!inputDocument)await page.locator('[aria-label="演讲备注"]').fill('第一张幻灯片。');
 await page.locator('.design-editor button::-p-text(保存)').click();
 await page.locator('.design-editor button::-p-text(加入视频)').click();
 await page.waitForFunction(()=>document.querySelector('.glint-editor')?.getAttribute('data-view')==='video' || document.querySelector('.design-editor [role="alert"]'),{timeout:120000});
 assert.equal(await page.$eval('.glint-editor',(node:Element)=>node.getAttribute('data-view')),'video',await page.evaluate(()=>document.querySelector('.design-editor [role="alert"]')?.textContent));
 await page.locator('button::-p-text(保存项目)').click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('glint.projects')??'[]'));fs.writeFileSync(path.join(output,'saved-projects.json'),JSON.stringify(saved,null,2));
 const project=saved[0].project;assert.ok(project);const images=project.scenes.filter((s:any)=>s.presentation==='slide');assert.equal(images.length,inputDocument?.pages.length??3);assert.ok(images.every((s:any)=>s.kind==='image'));assert.equal(images[0].narration.text,inputDocument?.pages[0].notes??'第一张幻灯片。');
 await page.screenshot({path:path.join(output,'slides-in-editor.png'),fullPage:true});
 await page.locator('button::-p-text(导出视频)').click();await page.waitForSelector('[aria-label="配音"]',{visible:true});
 await page.select('[aria-label="配音"]','sapi');await page.select('[aria-label="背景配乐"]','auto');await page.select('[aria-label="导出规格"]','draft');
 const submitted=page.waitForResponse((r:any)=>r.url().endsWith('/api/make')&&r.request().method()==='POST',{timeout:30000});
 await page.locator('button::-p-text(导出 MP4)').click();const response=await submitted;const job=await response.json();assert.ok(response.ok(),JSON.stringify(job));assert.ok(job.jobId);
 let state:any,last='';const deadline=Date.now()+15*60*1000;
 while(Date.now()<deadline){
  const result=await fetch(service.url+'/api/make/'+job.jobId);state=await result.json();
  if(state.stage!==last){console.log(JSON.stringify({status:state.status,stage:state.stage}));last=state.stage;}
  if(['done','failed','cancelled'].includes(state.status))break;await new Promise(resolve=>setTimeout(resolve,1000));
 }
 fs.writeFileSync(path.join(output,'render-result.json'),JSON.stringify(state,null,2));assert.equal(state.status,'done',JSON.stringify(state));
 const video=await fetch(service.url+state.video);assert.ok(video.ok);const file=path.join(output,'slides-video.mp4');fs.writeFileSync(file,Buffer.from(await video.arrayBuffer()));
 const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8',windowsHide:true});assert.equal(probe.status,0,probe.stderr);
 const metadata=JSON.parse(probe.stdout);assert.ok(metadata.streams.some((s:any)=>s.codec_type==='video'));assert.ok(metadata.streams.some((s:any)=>s.codec_type==='audio'));assert.ok(Number(metadata.format.duration)>5);
 fs.writeFileSync(path.join(output,'ffprobe.json'),JSON.stringify(metadata,null,2));
 const thumb=spawnSync('ffmpeg',['-y','-ss','8','-i',file,'-frames:v','1',path.join(output,'video-frame.png')],{encoding:'utf8',windowsHide:true});assert.equal(thumb.status,0,thumb.stderr);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,output,video:file,seconds:metadata.format.duration}));
}catch(error){if(page){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),String(error)+'\n'+await page.evaluate(()=>document.body.innerText).catch(()=>''));}throw error;}
finally{await browser.close();await service.close();}
