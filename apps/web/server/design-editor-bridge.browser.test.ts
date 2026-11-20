import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
const browserGated = (() => { try { findSystemBrowser(); return process.env.GLINT_BROWSER_UI_TEST === "1"; } catch { return false; } })();
const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");

it.skipIf(!browserGated)("真实双 iframe：缩放后点击 child 留批注，滚动后点钉编辑，隔离来源和旧 generation，刷新品牌及缩略图", async () => {
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{DesignPreview,DesignThumb}from'./design-editor-preview';
    const html='<style>html,body{margin:0}body{width:1800px;height:2400px;background:var(--brand-bg);color:var(--brand-text)}#target{position:absolute;left:200px;top:900px;width:200px;height:100px;background:var(--accent)}@media(max-width:900px){#target{width:50px}}</style><h1 style="margin:0;color:var(--accent)">品牌页面 · 固定桌面视口</h1><button id="target" data-design-id="target" data-design-group="g1">点击这里留批注</button><span data-design-id="companion" data-design-group="g1" style="position:absolute;left:600px;top:900px">同组对象</span>';
    function App(){const[marks,setMarks]=useState([]),[events,setEvents]=useState([]),[edits,setEdits]=useState([]),[accent,setAccent]=useState('#226688'),[comment,setComment]=useState(true),[width,setWidth]=useState(664),[revision,setRevision]=useState(0),[selected,setSelected]=useState(['target']);
      const brand={name:'测试品牌',accent,bg:'#ffffff',text:'#111111'};
      return <><button id="brand" onClick={()=>setAccent('#884422')}>更换品牌</button><button id="mode" onClick={()=>setComment(v=>!v)}>切换模式</button><button id="scale" onClick={()=>setWidth(536)}>缩放</button><button id="revision" onClick={()=>setRevision(v=>v+1)}>新文档</button><button id="single" onClick={()=>setSelected(['target'])}>单选</button>
      <div id="preview" style={{width}}><DesignPreview html={html+'<!--'+revision+'-->'} viewport="desktop" interactive={false} selected={selected} commentMode={comment} annotations={marks} brand={brand}
        onMessage={m=>{setEvents(v=>[...v,m]);if(m.action==='select')setSelected(m.nodeIds);if(m.action==='comment')setMarks(v=>[...v,{id:'a'+(v.length+1),x:m.x,y:m.y,text:'编辑这条意见',createdAt:1}])}}
        onAnnotation={id=>setEdits(v=>[...v,id])}/></div>
      <div style={{width:320}}><DesignThumb html={html} title="比较缩略图" brand={brand}/></div>
      <output id="events">{JSON.stringify(events)}</output><output id="edits">{JSON.stringify(edits)}</output><output id="marks">{JSON.stringify(marks)}</output></>}
    createRoot(document.getElementById('app')).render(<App/>);
  `, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
  const css = await readFile(new URL("../src/design-editor.css", import.meta.url), "utf8");
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0]!.text); }
    else { res.setHeader("content-type", "text/html;charset=utf-8"); res.end(`<!doctype html><style>${css}body{margin:0}.design-preview-host{padding:0 12px}.design-preview-fit{border:0}output{display:none}</style><div id="app"></div><script src="/app.js"></script>`); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 1000, deviceScaleFactor: 1 });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const selector = '#preview iframe[title="设计预览"]';
    const frames = async () => { const outer = await (await page.$(selector)).contentFrame(); await outer.waitForSelector("iframe"); const child = await (await outer.$("iframe")).contentFrame(); await child.waitForSelector("#target"); return { outer, child }; };
    const ready = async () => page.waitForFunction(() => !document.querySelector("#preview .design-preview-loading"));
    await ready(); let { outer, child } = await frames();
    expect(await child.evaluate(() => { try { return !!parent.document.body; } catch { return false; } })).toBe(false);
    expect(await child.$eval("#target", (el: Element) => el.getBoundingClientRect().width)).toBe(200);
    expect(await child.$('[aria-label="拖动调整大小"]')).toBeNull();
    const read = (id: string) => page.$eval(id, (el: Element) => JSON.parse(el.textContent || "[]"));
    const point = async () => {
      const rect = await child.$eval("#target", (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const frame = await page.$eval(selector, (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / 1280 }; });
      return { x: frame.x + rect.x * frame.scale, y: frame.y + rect.y * frame.scale, scale: frame.scale };
    };
    await child.evaluate(() => scrollTo(120, 700)); await child.waitForFunction(() => scrollY === 700 && scrollX === 120);
    let p = await point(); expect(p.scale).toBeCloseTo(.5);
    // 真正的鼠标点击进入 child，而非向 parent 构造 comment 消息。
    await page.mouse.click(p.x, p.y); await page.waitForFunction(() => JSON.parse(document.querySelector("#marks")!.textContent!).length === 1);
    const mark = (await read("#marks"))[0]; expect(mark.x).toBeCloseTo(16.67, 1); expect(mark.y).toBeCloseTo(39.58, 1);
    expect((await read("#events")).filter((m: any) => m.action === "comment")[0].nodeId).toBe("target");
    const generation = await page.$eval(selector, (el: HTMLElement) => el.dataset.designGeneration);
    // 列表同步不能重载 iframe，否则滚动位置将丢失。
    expect(await child.evaluate(() => scrollY)).toBe(700);
    expect(await page.$eval(selector, (el: HTMLElement) => el.dataset.designGeneration)).toBe(generation);
    await page.mouse.move(p.x, p.y); await page.mouse.wheel({ deltaY: 180 }); await child.waitForFunction(() => scrollY > 700);
    p = await point(); await page.mouse.click(p.x, p.y);
    await page.waitForFunction(() => JSON.parse(document.querySelector("#edits")!.textContent!).length === 1);
    expect(await read("#edits")).toEqual(["a1"]); expect(await read("#marks")).toHaveLength(1);
    await page.click("#scale"); await page.waitForFunction(() => (document.querySelector('#preview iframe') as HTMLElement).style.transform === 'scale(0.4)');
    p = await point(); await page.mouse.click(p.x, p.y); await page.waitForFunction(() => JSON.parse(document.querySelector("#edits")!.textContent!).length === 2);
    // 已高亮目标在批注模式下也不能启动拖动。
    p = await point(); await page.mouse.move(p.x + 25, p.y); await page.mouse.down(); await page.mouse.move(p.x + 50, p.y + 20, { steps: 5 }); await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await read("#events")).filter((m: any) => m.action === "gesture")).toHaveLength(0);
    // 以下仅是负向信任边界测试，不作为实机批注证据。
    const count = (await read("#events")).length;
    await child.evaluate((g: string) => top!.postMessage({ type: 'glint:design', generation: g, action: 'comment', x: 1, y: 1, nodeId: 'target' }, '*'), generation);
    await outer.evaluate((g: string) => parent.postMessage({ type: 'glint:design', generation: g, action: 'comment', x: 1, y: 1, nodeId: {} }, '*'), generation);
    await page.evaluate((g: string) => { const f = document.querySelector('#preview iframe') as HTMLIFrameElement; f.contentWindow!.postMessage({ type: 'glint:design', generation: g, action: 'comment', x: 1, y: 1 }, '*'); }, generation);
    await outer.evaluate(async (g: string) => {
      const sibling = document.createElement('iframe'); sibling.srcdoc = '<script>parent.postMessage(' + JSON.stringify({ type: 'glint:design', generation: g, action: 'comment', x: 1, y: 1 }) + ',"*")<\/script>';
      const loaded = new Promise(resolve => sibling.addEventListener('load', resolve, { once: true })); document.body.appendChild(sibling); await loaded;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); sibling.remove();
    }, generation);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await read("#events")).length).toBe(count);
    await page.click("#revision"); await ready(); ({ outer, child } = await frames());
    const nextGeneration = await page.$eval(selector, (el: HTMLElement) => el.dataset.designGeneration); expect(nextGeneration).not.toBe(generation);
    const afterRevision = (await read("#events")).length;
    await outer.evaluate((g: string) => parent.postMessage({ type: 'glint:design', generation: g, action: 'comment', x: 1, y: 1 }, '*'), generation);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await read("#events")).length).toBe(afterRevision);
    await page.click("#brand"); await ready(); ({ child } = await frames());
    await child.waitForFunction(() => getComputedStyle(document.querySelector('#target')!).backgroundColor === 'rgb(136, 68, 34)');
    const thumbOuter = await (await page.$('iframe[title="比较缩略图"]')).contentFrame(); await thumbOuter.waitForSelector('iframe');
    const thumb = await (await thumbOuter.$('iframe')).contentFrame(); await thumb.waitForSelector('#target');
    expect(await thumb.evaluate(() => innerWidth)).toBe(1280);
    expect(await thumb.$eval('#target', (el: Element) => el.getBoundingClientRect().width)).toBe(200);
    expect(await thumb.$eval('#target', (el: Element) => getComputedStyle(el).backgroundColor)).toBe('rgb(136, 68, 34)');
    const thumbGeometry = await page.$eval('.design-thumb-frame', (el: Element) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; });
    expect(thumbGeometry).toEqual({ width: 320, height: 200 });
    // 正常编辑模式仍有真实拖动及 resize，批注模式才禁用。
    await page.click('#mode'); await ready(); ({ child } = await frames());
    await child.evaluate(() => scrollTo(120, 700)); await child.waitForFunction(() => scrollY === 700 && scrollX === 120);
    await child.waitForSelector('[aria-label="拖动调整大小"]');
    p = await point(); await page.mouse.click(p.x + 25, p.y);
    await page.waitForFunction(() => JSON.parse(document.querySelector('#events')!.textContent!).some((m: any) => m.action === 'select' && m.nodeIds?.includes('companion')));
    p = await point(); await page.mouse.move(p.x + 25, p.y); await page.mouse.down(); await page.mouse.move(p.x + 41, p.y + 12, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#events')!.textContent!).some((m: any) => m.action === 'gesture'));
    const gesture = (await read('#events')).find((m: any) => m.action === 'gesture'); expect(gesture.nodeIds).toEqual(['target', 'companion']); expect(gesture.dx).toBeCloseTo(40); expect(gesture.dy).toBeCloseTo(30);
    const handleRect = await child.$eval('[aria-label="拖动调整大小"]', (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const outerRect = await page.$eval(selector, (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / 1280 }; });
    const hx = outerRect.x + handleRect.x * outerRect.scale, hy = outerRect.y + handleRect.y * outerRect.scale;
    await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(hx + 16, hy + 12, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#events')!.textContent!).some((m: any) => m.action === 'gesture' && m.width));
    const resize = (await read('#events')).find((m: any) => m.action === 'gesture' && m.width); expect(resize.width).toBeCloseTo(240); expect(resize.height).toBeCloseTo(130);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.click('#single');await child.waitForSelector('[aria-label="拖动旋转"]');
    const rotationHandle=await child.$eval('[aria-label="拖动旋转"]',(el:Element)=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
    const center=await child.$eval('#target',(el:Element)=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
    const radius=center.y-rotationHandle.y;
    await page.keyboard.down('Shift');
    await page.mouse.move(outerRect.x+rotationHandle.x*outerRect.scale,outerRect.y+rotationHandle.y*outerRect.scale);await page.mouse.down();
    await page.mouse.move(outerRect.x+(center.x+radius)*outerRect.scale,outerRect.y+center.y*outerRect.scale,{steps:12});await page.mouse.up();await page.keyboard.up('Shift');
    await page.waitForFunction(()=>JSON.parse(document.querySelector('#events')!.textContent!).some((m:any)=>m.action==='gesture' && m.rotation!==undefined));
    const rotation=(await read('#events')).find((m:any)=>m.rotation!==undefined);expect(rotation.rotation).toBeCloseTo(90,0);expect(rotation.nodeIds).toEqual(['target']);
    p = await point(); await page.mouse.click(p.x+25,p.y,{clickCount:2});
    await page.waitForFunction(()=>JSON.parse(document.querySelector('#events')!.textContent!).some((m:any)=>m.action==='edit'));
    const edit=(await read('#events')).find((m:any)=>m.action==='edit');expect(edit.nodeId).toBe('target');expect(edit.width).toBe(200);
    if (process.env.GLINT_DESIGN_BRIDGE_EVIDENCE) await page.screenshot({ path: process.env.GLINT_DESIGN_BRIDGE_EVIDENCE, fullPage: true });
    expect(errors).toEqual([]);
    console.log('DESIGN_BRIDGE_CHROMIUM_PROOF', JSON.stringify({ mark, edits: await read('#edits'), scaled: [0.5, 0.4], viewport: [1280, 800], thumbGeometry, errors }));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
