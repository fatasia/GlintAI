import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {developmentEnvironment} from './dev.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const puppeteer=createRequire(new URL('../../studio/package.json',import.meta.url))('puppeteer-core');
const output=path.resolve(process.argv[2]??path.join(repo,'../outputs/native-recovery-'+Date.now()));
if(fs.existsSync(output))throw new Error('Use a new evidence directory');
fs.mkdirSync(output,{recursive:true});
const data=path.join(output,'data'),executable=path.join(repo,'apps/desktop/target/debug/glint-desktop.exe');
fs.mkdirSync(data);
const freePort=async()=>{const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;};
let child,browser,exitPromise,lastPage;
const errors=[],diagnostics=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function launch(label){
 fs.rmSync(path.join(data,'test-stop'),{force:true});
 const port=await freePort();
 child=spawn(executable,[],{cwd:repo,windowsHide:true,env:{...developmentEnvironment(repo),GLINT_DESKTOP_TEST_DATA_DIR:data,GLINT_DESKTOP_TEST_CDP_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 const log=fs.createWriteStream(path.join(output,label+'.log'));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 exitPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{log.end();resolve({code,signal});});});
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){
  if(child.exitCode!==null)throw new Error('Native host exited before ready');
  try{const response=await fetch('http://127.0.0.1:'+port+'/json/version');if(response.ok){browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}}catch{}
  await delay(200);
 }
 if(!browser)throw new Error('Native WebView2 CDP did not become ready');
 let page;
 while(Date.now()<deadline){page=(await browser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));if(page)break;await delay(100);}
 if(!page)throw new Error('Native owned workspace not found');
 lastPage=page;page.on('pageerror',error=>errors.push(String(error)));page.on('console',m=>{if(m.type()==='error')diagnostics.push(m.text())});page.on('requestfailed',r=>diagnostics.push({path:new URL(r.url()).pathname,failed:r.failure()?.errorText}));
 await page.waitForSelector('textarea[aria-label="快速成片资料"]',{timeout:20000});
 return page;
}
async function stop(crash=false){
 browser?.disconnect();browser=undefined;
 if(crash)child.kill();else fs.writeFileSync(path.join(data,'test-stop'),'stop');
 const result=await Promise.race([exitPromise,delay(10000).then(()=>{throw new Error('Native shutdown timeout');})]);
 child=undefined;return result;
}
try{
 let page=await launch('boot-1');const origin=new URL(page.url()).origin;

 await page.locator('textarea[aria-label="快速成片资料"]').fill('# 原生重启验收\n\n## 第一段\n在真正的 WebView2 客户端保存工程。\n\n## 第二段\n关闭并重新启动后继续编辑。');
 await page.select('[aria-label="输入类型"]','source');await page.locator('.pc-submit').click();await page.waitForSelector('.glint-editor');
 await page.locator('button::-p-text(保存项目)').click();
 const saved=await page.evaluate(()=>localStorage.getItem('glint.projects'));assert.ok(saved);
 await page.screenshot({path:path.join(output,'native-saved.png')});
 const normal=await stop();assert.equal(normal.code,0);
 page=await launch('boot-2');assert.equal(new URL(page.url()).origin,origin);
 assert.equal(await page.evaluate(()=>localStorage.getItem('glint.projects')),saved);
 await page.locator('.home-project').click();await page.waitForSelector('.glint-editor');
 await page.evaluate(()=>{window.__testClicks=[];document.addEventListener('click',event=>window.__testClicks.push(event.target.textContent),true)});
 await page.locator('.glint-editor button::-p-text(创意)').click();await page.waitForSelector('[aria-label="项目画布"]');
 await page.screenshot({path:path.join(output,'native-reopened.png')});
 // Distinct committed values must survive abrupt native-process termination as well.
 await page.evaluate(()=>localStorage.setItem('glint:theme','light'));
 await delay(1000);await stop(true);
 page=await launch('boot-3');assert.equal(new URL(page.url()).origin,origin);
 assert.equal(await page.evaluate(()=>localStorage.getItem('glint.projects')),saved);
 assert.equal(await page.evaluate(()=>localStorage.getItem('glint:theme')),'light');
 await stop();assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,origin,normalRestart:true,abruptRestart:true,errors},null,2));
 console.log(JSON.stringify({passed:true,output,origin}));
}catch(error){
 if(lastPage){await lastPage.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.txt'),JSON.stringify({error:String(error),errors,diagnostics,clicks:await lastPage.evaluate(()=>window.__testClicks).catch(()=>null),text:await lastPage.evaluate(()=>document.body.innerText).catch(()=>null)},null,2));}
 throw error;
}finally{
 browser?.disconnect();if(child&&child.exitCode===null){child.kill();await exitPromise.catch(()=>{});}
}
