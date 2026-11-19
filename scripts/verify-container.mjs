import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const exec=promisify(execFile), repo=fileURLToPath(new URL('../',import.meta.url));
const image=process.argv[2], base=process.argv[3]??'/glint/';
if(!image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]+$/.test(image)||!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))throw Error('Usage: node scripts/verify-container.mjs <local-image> [/base/]');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'glint-container-check-')),name='glint-check-'+randomUUID().slice(0,8);
const run=async(args,timeout=60000)=>(await exec('docker',args,{cwd:repo,windowsHide:true,timeout,maxBuffer:4*1024*1024})).stdout;
const report={image,base,output,status:'running',startedAt:new Date().toISOString()};
const token=randomUUID()+randomUUID();
const request=(url,init={})=>fetch(url,{...init,headers:{...init.headers,authorization:'Basic '+Buffer.from('glint:'+token).toString('base64')}});
let started=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
 await run(['image','inspect',image]); // Never implicitly pull an unreviewed target image.
 await run(['run','--detach','--init','--name',name,'--memory=2g','--cpus=2','--shm-size=256m','--security-opt=no-new-privileges:true','--security-opt',`seccomp=${path.join(repo,'deploy/chromium-seccomp.json')}`,'--publish','127.0.0.1::4175','--env','GLINT_PUBLIC_HOST=localhost','--env',`GLINT_ACCESS_TOKEN=${token}`,image]);started=true;
 const port=(await run(['port',name,'4175/tcp'])).trim();if(!/^127\.0\.0\.1:\d+$/.test(port))throw Error('Expected loopback-only port');
 const origin='http://'+port;
 let ready=false;for(let i=0;i<60;i++){try{if((await request(origin+'/healthz',{signal:AbortSignal.timeout(2000)})).ok){ready=true;break;}}catch{}await delay(1000);}
 assert(ready,'Container health did not become ready');
 assert.equal((await request(origin+base)).status,200);
 if(base!=='/')assert.equal((await request(origin+'/api/health')).status,404);
 const browserCode=`const {createRequire}=require('node:module');const p=createRequire('/app/apps/studio/package.json')('puppeteer-core');(async()=>{const b=await p.launch({executablePath:'/usr/bin/chromium',headless:true});try{const page=await b.newPage();await page.authenticate({username:'glint',password:process.env.GLINT_ACCESS_TOKEN});await page.goto('chrome://sandbox');const sandbox=await page.evaluate(()=>document.body.innerText);if(!/Seccomp-BPF sandbox\\s+Yes/.test(sandbox)||!/PID namespaces\\s+Yes/.test(sandbox))throw Error(sandbox);await page.goto('http://127.0.0.1:4175${base}',{waitUntil:'networkidle0'});await page.waitForSelector('[aria-label="快速成片"]',{visible:true});console.log(JSON.stringify({sandbox,rendered:true}));}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});`;
 report.browser=JSON.parse((await run(['exec',name,'node','-e',browserCode],90000)).trim());
 const response=await request(origin+base+'api/make',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'# 容器验收\n\n## 第一节\n真实中文画面。\n\n## 第二节\n检查沙箱与视频输出。',tts:'mock',music:'off',encoding:'draft'})});
 assert.equal(response.status,200);const submitted=await response.json();assert(submitted.jobId);
 let job;for(let i=0;i<150;i++){job=await (await request(origin+base+'api/make/'+submitted.jobId)).json();if(['done','failed','cancelled'].includes(job.status))break;await delay(2000);}
 assert.equal(job?.status,'done',JSON.stringify(job));
 const video=await request(origin+base+'api/video/'+submitted.jobId);assert(video.ok);const bytes=Buffer.from(await video.arrayBuffer());assert(bytes.length>1000);fs.writeFileSync(path.join(output,'render.mp4'),bytes);
 await run(['cp',path.join(output,'render.mp4'),name+':/tmp/glint-acceptance.mp4']);
 const metadata=JSON.parse(await run(['exec',name,'ffprobe','-v','error','-show_streams','-show_format','-of','json','/tmp/glint-acceptance.mp4']));
 assert(metadata.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'&&s.width>0));assert(Number(metadata.format.duration)>0);
 report.video={bytes:bytes.length,duration:metadata.format.duration,streams:metadata.streams.map(s=>({type:s.codec_type,codec:s.codec_name,width:s.width,height:s.height}))};
 report.status='passed';console.log(JSON.stringify(report,null,2));
}catch(error){report.status='failed';report.error=String(error).replaceAll(token,'[redacted]');console.error(report.error);process.exitCode=1;}
finally{if(started){try{const logs=await exec('docker',['logs',name],{windowsHide:true,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(output,'container.log'),logs.stdout+logs.stderr);}catch{}await run(['rm','--force',name]).catch(()=>{});}report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('Container evidence: '+output);}

