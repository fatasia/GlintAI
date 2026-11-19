import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{createRequire}from'node:module';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{build}from'esbuild';import{expect,it}from'vitest';import{findSystemBrowser}from'../../studio/scripts/direct-browser/host';import{createWebServer}from'./index.mjs';import{createMediaJobs}from'./media-jobs.mjs';
const puppeteer=createRequire(new URL('../../studio/package.json',import.meta.url))('puppeteer-core');let available=false;try{findSystemBrowser();available=true;}catch{}
it.skipIf(!available||process.env.GLINT_BROWSER_UI_TEST!=='1').each(['library','generated'])('inserts a large %s image as a bounded page copy without changing the original',async entry=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'glint-design-image-')),dist=path.join(root,'web'),media=path.join(root,'media');fs.mkdirSync(dist);fs.mkdirSync(media);
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{DesignEditor}from'./DesignEditor';import'./app-theme.css';createRoot(document.getElementById('app')).render(<DesignEditor projectId="large-image"/>);`,resolveDir:fileURLToPath(new URL('../src',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',outdir:dist});for(const file of bundle.outputFiles)fs.writeFileSync(file.path,file.contents);fs.writeFileSync(path.join(dist,'index.html'),'<link rel="stylesheet" href="/stdin.css"><div id="app"></div><script src="/stdin.js"></script>');
 const jobs=createMediaJobs(media,{}),server=createWebServer({distDir:dist,mediaJobs:jobs});let browser:any;
 try{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${(server.address()as{port:number}).port}`;browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});const page=await browser.newPage();await page.setViewport({width:1440,height:960});await page.goto(url,{waitUntil:'networkidle0'});
 let name:string;
 if(process.env.GLINT_DESIGN_LARGE_IMAGE_SOURCE){name='large-source.png';fs.copyFileSync(process.env.GLINT_DESIGN_LARGE_IMAGE_SOURCE,path.join(media,name));}
 else{name=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=768;const ctx=canvas.getContext('2d')!,image=ctx.createImageData(768,768);let seed=17;for(let i=0;i<image.data.length;i+=4){for(let j=0;j<3;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;image.data[i+j]=seed>>>24;}image.data[i+3]=255;}ctx.putImageData(image,0,0);const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));return(await(await fetch('/api/media/import-image',{method:'POST',headers:{'content-type':'image/png'},body:blob})).json()).name;});}
 const original=fs.readFileSync(path.join(media,name)),hash=createHash('sha256').update(original).digest('hex');expect(original.length).toBeGreaterThan(512*1024);
 if(entry==='generated'){
  await page.setRequestInterception(true);page.on('request',(request:any)=>{const pathname=new URL(request.url()).pathname;
   if(pathname==='/api/media/models')return request.respond({status:200,contentType:'application/json',body:JSON.stringify({protocol:'skills',models:[{id:'fixture-image',name:'测试回执'}]})});
   if(pathname==='/api/media/status/finished-image')return request.respond({status:200,contentType:'application/json',body:JSON.stringify({taskId:'finished-image',state:'success',isFinal:true,assetUrl:'/api/media/assets/'+name})});
   request.continue();});
  await page.evaluate(()=>localStorage.setItem('glint.quick-image',JSON.stringify({taskId:'finished-image'})));
 }
 await page.locator('button.design-image-toggle').click();
 if(entry==='generated'){await page.locator('summary::-p-text(在这里生成图片)').click();await page.locator('button::-p-text(插入当前页面)').click();}
 else await page.locator(`.design-asset-grid button[title^="${name}"]`).click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('glint.project-designs.v1:large-image')??'null')?.documents.some((doc:any)=>doc.pages.some((page:any)=>page.html.includes('data:image/webp;base64,'))));
 const stored=await page.evaluate(()=>({documents:JSON.parse(localStorage.getItem('glint.project-designs.v1:large-image')!),assets:JSON.parse(localStorage.getItem('glint:project-assets.v1:large-image')!)}));
 const picked=stored.assets[0];expect(picked.name).not.toBe(name);expect(picked.bytes).toBeLessThanOrEqual(512*1024);expect(fs.readFileSync(path.join(media,picked.name)).length).toBe(picked.bytes);expect(createHash('sha256').update(fs.readFileSync(path.join(media,name))).digest('hex')).toBe(hash);
 await page.reload({waitUntil:'networkidle0'});expect(await page.$('.design-error')).toBeNull();
 let imageFrame:any;for(let attempt=0;attempt<100;attempt++){for(const frame of page.frames()){if(await frame.$('img[src^="data:image/webp;"]').catch(()=>null)){imageFrame=frame;break;}}if(imageFrame)break;await new Promise(resolve=>setTimeout(resolve,30));}expect(imageFrame).toBeTruthy();
 const decoded=await imageFrame.$eval('img[src^="data:image/webp;"]',async(el:HTMLImageElement)=>{await el.decode();el.scrollIntoView({block:'center'});return{width:el.naturalWidth,height:el.naturalHeight};});expect(decoded.width).toBeGreaterThan(100);expect(decoded.height).toBeGreaterThan(100);

 if(process.env.GLINT_DESIGN_LARGE_IMAGE_EVIDENCE){const out=process.env.GLINT_DESIGN_LARGE_IMAGE_EVIDENCE;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({sourceBytes:original.length,optimizedBytes:picked.bytes,sourceSha256:hash,originalUnchanged:true},null,2));fs.copyFileSync(path.join(media,picked.name),path.join(out,'optimized.webp'));await page.screenshot({path:path.join(out,'editor.png'),fullPage:true});}
 }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
},60000);
