import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { prepareDesign } from "../apps/web/server/design-export-html.mjs";
import { findSystemBrowser } from "../apps/studio/scripts/direct-browser/host.ts";
const puppeteer=createRequire(new URL("../apps/studio/package.json",import.meta.url))("puppeteer-core");
const out=process.argv[2];if(!out||!path.isAbsolute(out))throw new Error("Pass the absolute model acceptance output directory");
const pages=new Map(),cases=(process.argv[3]??"page,wireframe,slides").split(",");if(cases.some(id=>!/^[-a-z0-9]+$/.test(id)))throw new Error("Invalid case name");
for(const id of cases){
 const result=JSON.parse(await fs.readFile(path.join(out,`${id}.json`),"utf8"));
 const prepared=await prepareDesign(result.document);
 pages.set(`/${id}`,prepared.pages[0].staticHtml);
}
const server=createServer((req,res)=>{
 const html=pages.get(req.url);
 if(!html){res.writeHead(404).end();return;}
 res.writeHead(200,{"content-type":"text/html;charset=utf-8","content-security-policy":"default-src 'none';style-src 'unsafe-inline';img-src data:;font-src data:;script-src 'none';form-action 'none';base-uri 'none'"}).end(html);
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 browser=await puppeteer.launch({executablePath:findSystemBrowser(),headless:true,args:["--disable-background-networking"]});
 const page=await browser.newPage(),report=[];
 await page.setRequestInterception(true);
 const origin=`http://127.0.0.1:${server.address().port}`;
 page.on("request",request=>void(request.url().startsWith(origin+"/")||request.url().startsWith("data:")?request.continue():request.abort()).catch(()=>{}));
 for(const id of cases)for(const width of (id==="slides"||id.startsWith("slide-"))?[1280]:[1280,390]){
  await page.setViewport({width,height:720,deviceScaleFactor:1});await page.goto(`${origin}/${id}`,{waitUntil:"networkidle0"});
  const metrics=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,text:document.body.innerText.length,editableNodes:document.querySelectorAll('[data-design-id]').length}));
  const screenshot=path.join(out,`${id}-${width}.png`);await page.screenshot({path:screenshot,fullPage:true});
  report.push({id,width,...metrics,viewportWidth:width,overflow:metrics.width>width,screenshot});
 }
 await fs.writeFile(path.join(out,"layout.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 if(report.some(row=>row.overflow||row.text<30||row.editableNodes<3))process.exitCode=1;
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
