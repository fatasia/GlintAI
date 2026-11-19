import fs from"node:fs";import path from"node:path";import{createServer}from"node:http";import{createRequire}from"node:module";import{fileURLToPath}from"node:url";import{build}from"esbuild";import{expect,it}from"vitest";import{findSystemBrowser}from"../../studio/scripts/direct-browser/host";
const puppeteer=createRequire(new URL("../../studio/package.json",import.meta.url))("puppeteer-core");let available=false;try{findSystemBrowser();available=true;}catch{}
const motionCss=`@keyframes glint-design-fade{from{opacity:0}to{opacity:1}}@keyframes glint-design-rise{from{opacity:0;translate:0 32px}to{opacity:1;translate:0 0}}[data-design-enter="fade"]{animation-name:glint-design-fade}[data-design-enter="rise"]{animation-name:glint-design-rise}[data-design-enter]:not([data-design-enter="none"]){animation-duration:var(--glint-enter-duration,600ms);animation-delay:var(--glint-enter-delay,0ms);animation-timing-function:ease-out;animation-fill-mode:both;animation-iteration-count:1}`;
const page=(id:string,title:string,body:string,enters:Array<{sel:string;type:"rise"|"fade";delay:number}>=[{sel:"h1",type:"rise",delay:120}])=>({id,title,html:`<!doctype html><html><head><style>body{margin:0;background:white;color:#173e32;padding:80px;font:30px sans-serif}</style><style>${motionCss}</style></head><body><h1 data-design-id="t-${id}"${enters.some(e=>e.sel==="h1")?` data-design-enter="${enters.find(e=>e.sel==="h1")!.type}" style="--glint-enter-duration:400ms;--glint-enter-delay:${enters.find(e=>e.sel==="h1")!.delay}ms"`:""}>${title}</h1><p data-design-id="p-${id}"${enters.some(e=>e.sel==="p")?` data-design-enter="${enters.find(e=>e.sel==="p")!.type}" style="--glint-enter-duration:400ms;--glint-enter-delay:${enters.find(e=>e.sel==="p")!.delay}ms"`:""}>${body}</p></body></html>`});
const doc={version:1,projectId:"transition-project",activeId:"deck",documents:[{id:"deck",title:"转场演示",kind:"slides",activePageId:"one",updatedAt:0,pages:[page("one","第一页","保持第一页。"),page("two","第二页","翻到这一页。",[{sel:"h1",type:"rise",delay:120},{sel:"p",type:"fade",delay:600}])]}]};
it.skipIf(!available||process.env.GLINT_BROWSER_UI_TEST!=="1")("edits page transitions, previews without saving, plays them while presenting and reveals entrance objects step by step",async()=>{
 const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{DesignEditor}from'./DesignEditor';import'./app-theme.css';if(!localStorage.getItem('glint.project-designs.v1:transition-project'))localStorage.setItem('glint.project-designs.v1:transition-project',${JSON.stringify(JSON.stringify(doc))});createRoot(document.getElementById('app')).render(<DesignEditor projectId="transition-project"/>);`,resolveDir:fileURLToPath(new URL("../src",import.meta.url)),loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",outdir:"harness"});
 const server=createServer((req,res)=>{const js=bundle.outputFiles.find(file=>file.path.endsWith(".js"))!.text;if(req.url==="/app.js")return res.writeHead(200,{"content-type":"text/javascript"}).end(js);if(req.url==="/app.css")return res.writeHead(200,{"content-type":"text/css"}).end(bundle.outputFiles.find(file=>file.path.endsWith(".css"))!.text);res.writeHead(200,{"content-type":"text/html;charset=utf-8"}).end('<link rel="stylesheet" href="/app.css"><div id="app"></div><script src="/app.js"></script>');});let browser:any;
 try{await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${(server.address()as{port:number}).port}`;browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true});const ui=await browser.newPage();await ui.setViewport({width:1440,height:960});await ui.emulateMediaFeatures([{name:"prefers-reduced-motion",value:"no-preference"}]);await ui.goto(origin,{waitUntil:"networkidle0"});
 const stored=()=>ui.evaluate(()=>localStorage.getItem("glint.project-designs.v1:transition-project")!);
 // Page preview content lives inside srcdoc iframes: find the frame that owns the fixture markers.
 const withMarkers=async(fn:()=>unknown)=>{
  for(const frame of ui.frames()){
   try{if(await frame.evaluate(()=>Boolean(document.querySelector('[data-design-id]'))))return await frame.evaluate(fn);}catch{}
  }
  return null;};
 const enterStates=async()=>await withMarkers(()=>[...document.querySelectorAll("[data-design-enter]")].map(n=>Number(getComputedStyle(n as HTMLElement).opacity)))as unknown as number[] ?? [];
 const pollStates=async(check:(s:number[])=>boolean,label:string)=>{
  const deadline=Date.now()+6000;let states:number[]=[];
  while(Date.now()<deadline){states=await enterStates();if(states.length&&check(states))return states;await new Promise(r=>setTimeout(r,120));}
  throw new Error(`step reveal did not reach ${label}: ${JSON.stringify(states)}`);};
 // AC2: rail edit persists through save and reload.
 try{await ui.waitForSelector('[aria-label="页面转场方式"]',{timeout:12000});}catch{
  const snapshot=await ui.evaluate(()=>({design:document.querySelector(".design-editor")?.tagName??"none",body:document.body.innerHTML.slice(0,1200)}));
  throw new Error(`transition rail missing; page snapshot: ${JSON.stringify(snapshot)}`);
 }
 await ui.select('[aria-label="页面转场方式"]',"fade");await ui.select('[aria-label="页面转场时长"]',"300");await ui.locator("button::-p-text(保存)").click();
 await ui.waitForFunction(()=>localStorage.getItem("glint.project-designs.v1:transition-project")?.includes('"type":"fade"'));
 expect(await stored()).toContain('"durationMs":300');
 await ui.reload({waitUntil:"networkidle0"});expect(await ui.$eval('[aria-label="页面转场方式"]',(el:HTMLSelectElement)=>el.value)).toBe("fade");
 // AC2b: apply to all pages, then one undo returns to "only the edited page keeps its transition".
 await ui.locator("button::-p-text(应用到全部页)").click();
 await ui.waitForFunction(()=>(JSON.parse(localStorage.getItem("glint.project-designs.v1:transition-project")!)?.documents[0]?.pages??[]).every((p:any)=>p.transition?.type==="fade"),{timeout:12000}).catch(async()=>{
  throw new Error(`apply-all state: ${await stored()}`);
 });
 await ui.locator(".design-toolbar button::-p-text(撤销)").click();
 await ui.locator("button::-p-text(保存)").click();
 await ui.waitForFunction(()=>{const pages=(JSON.parse(localStorage.getItem("glint.project-designs.v1:transition-project")!)?.documents[0]?.pages??[])as any[];return pages[0]?.transition?.type==="fade"&&pages[1]?.transition===undefined;},{timeout:12000}).catch(async()=>{
  throw new Error(`undo state: ${await stored()}`);
 }); // AC4: preview plays 上一页→本页 once and never touches the document (active page must be page two).
 await ui.click('[aria-label="选择页面 2 第二页"]');
 // The undo above restored page two to "unset": give it its own transition again before previewing.
 await ui.select('[aria-label="页面转场方式"]',"fade");await ui.select('[aria-label="页面转场时长"]',"1200");await ui.locator("button::-p-text(保存)").click();
 await ui.waitForFunction(()=>(JSON.parse(localStorage.getItem("glint.project-designs.v1:transition-project")!)?.documents[0]?.pages?.[1]as any)?.transition?.type==="fade",{timeout:12000});
 const before=await stored();
 await ui.locator("button::-p-text(试播转场)").click();await ui.waitForSelector('[aria-label="试播页面转场"]');
 expect(await ui.$eval('[aria-label="页面转场播放"]',(el:HTMLElement)=>el.querySelectorAll(".design-transition-frame").length)).toBe(2);
 expect(await stored()).toBe(before);
 await ui.locator('[aria-label="试播页面转场"] button::-p-text(关闭)').click();
 await ui.waitForSelector('[aria-label="试播页面转场"]',{hidden:true,timeout:6000});
 // AC3+AC-PERF: presenting plays the transition, ignores a second advance mid-flight, lands on page two.
 await ui.click('[aria-label="选择页面 1 第一页"]');
 await ui.locator("button::-p-text(播放演示)").click();await ui.waitForSelector("button::-p-text(退出演示)");
 await ui.keyboard.press("ArrowRight");await ui.waitForSelector('[aria-label="页面转场播放"]');await new Promise(r=>setTimeout(r,250));
 // Sample mid-flight: the incoming page must be partially faded while the outgoing one stays put.
 const midFlight=await ui.$$eval(".design-transition-frame",nodes=>nodes.map(node=>({anim:(node as HTMLElement).style.animationName||getComputedStyle(node).animationName,opacity:Number(getComputedStyle(node).opacity)})));
 expect(midFlight.some(f=>f.anim.includes("glint-page-fade-in")&&f.opacity<1&&f.opacity>0)).toBe(true);
 await ui.keyboard.press("ArrowRight");await ui.waitForFunction(()=>!document.querySelector('[aria-label="页面转场播放"]'),{timeout:6000});
 let landed=false;const landedDeadline=Date.now()+6000;
 while(Date.now()<landedDeadline&&!landed){landed=(await withMarkers(()=>document.body!.textContent!.includes("翻到这一页")))===true;if(!landed)await new Promise(r=>setTimeout(r,150));}
 expect(landed).toBe(true);
 // AC5: step reveal holds entrance objects, then releases them one click at a time.
 await ui.keyboard.press("Escape");await ui.waitForFunction(()=>!document.querySelector(".design-presentation-controls"),{timeout:6000});
 await ui.locator('[aria-label="逐步展示"]').click();await ui.locator("button::-p-text(保存)").click();
 await ui.waitForFunction(()=>localStorage.getItem("glint.project-designs.v1:transition-project")?.includes('"stepReveal":true'));
 await ui.click('[aria-label="选择页面 1 第一页"]');
 await ui.locator("button::-p-text(播放演示)").click();await ui.keyboard.press("ArrowRight");await ui.waitForFunction(()=>!document.querySelector('[aria-label="页面转场播放"]'),{timeout:6000});
 const held=await pollStates(s=>s.length===2&&s[0]<0.05&&s[1]<0.05,"held");
 const stage=await ui.$(".design-presenting iframe")??await ui.$("iframe");const box=await stage!.boundingBox();
 const clickStage=()=>ui.mouse.click(box!.x+box!.width/2,box!.y+box!.height/2);
 clickStage();const afterFirst=await pollStates(s=>s[0]>0.9&&s[1]<0.05,"first released");
 expect(afterFirst[1]).toBeLessThan(0.05);
 clickStage();await pollStates(s=>s[1]>0.9,"second released");
 if(process.env.GLINT_S03_EVIDENCE){fs.mkdirSync(process.env.GLINT_S03_EVIDENCE,{recursive:true});await ui.screenshot({path:path.join(process.env.GLINT_S03_EVIDENCE,"presenting-revealed.png")});}
 }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},60000);
