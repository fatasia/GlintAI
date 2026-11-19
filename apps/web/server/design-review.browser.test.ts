import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
import { artifactFingerprint } from "../src/artifact-project";
import type { ArtifactEditRequest } from "../src/artifact-project";
import type { DesignDocument, DesignSelection, ProjectDesignDocuments } from "../src/design-artifacts";

const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");
const projectId = "design-review-chromium";
const originalTitle = "原始标题";
const revisedTitle = "批注后的清晰标题";
const originalButton = "原始按钮";
const revisedButton = "立即查看详情";
const initialDocument: DesignDocument = {
  id: "review-document", title: "真实设计审阅", kind: "page", activePageId: "first-page", updatedAt: 1,
  pages: [
    { id: "first-page", title: "审阅首页", notes: "人工备注必须保留", annotations: [], html: '<!doctype html><html><head><style>html,body{margin:0}body{width:1280px;height:800px;background:#fbfaf6;color:#172b39;font:24px sans-serif}h1,button,p{position:absolute;left:80px;margin:0;padding:20px;width:560px;box-sizing:border-box}h1{top:70px;font-size:40px}button{top:230px;height:90px;background:#226688;color:white;border:0;font-size:30px}p{top:390px;background:#e6edf0}aside{position:absolute;left:760px;top:70px;width:340px;padding:24px;background:#eee4d5}</style></head><body><h1 data-design-id="review-title">原始标题</h1><button data-design-id="review-button">原始按钮</button><p data-design-id="not-selected">未选择的说明，必须原样保留</p><aside data-design-id="locked-note" data-design-locked="true">锁定的合规说明，禁止修改</aside></body></html>' },
    { id: "second-page", title: "不可影响的第二页", html: '<!doctype html><html><body><p data-design-id="second-page-note">第二页的独立内容</p></body></html>', notes: "第二页备注", annotations: [{ id: "existing-second-page-mark", nodeId: "second-page-note", x: 10, y: 20, text: "第二页人工批注", createdAt: 1 }] },
  ],
};
const initialState: ProjectDesignDocuments = { version: 1, projectId, activeId: initialDocument.id, documents: [initialDocument] };
type ProposalRequest = { projectId: string; document: DesignDocument; instruction: string; selection: DesignSelection };

it("真实 DesignEditor + ArtifactChat：多批注精准提案、影响单、确认应用、一次撤销，以及过期预览和旧批注请求拒绝", async () => {
  const evidence = await mkdtemp(fileURLToPath(new URL("../../../evidence/design-review-browser-", import.meta.url)));
  const bundle = await build({ stdin: { contents: `
    import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';
    import{DesignEditor}from'./DesignEditor';import{ArtifactChat}from'./ArtifactChat';
    import{artifactFingerprint}from'./artifact-project';import{designDocumentsKey}from'./design-artifacts';
    import './app-theme.css';
    const initial=${JSON.stringify(initialState)};
    localStorage.setItem(designDocumentsKey(initial.projectId),JSON.stringify(initial));
    function App(){
      const[state,setState]=useState(initial),[selection,setSelection]=useState(),[request,setRequest]=useState(),[applied,setApplied]=useState([]);
      const editHandle=useRef(null);const doc=state.documents.find(item=>item.id===state.activeId);
      return <><header id="harness-heading">真实设计审阅 · 多批注 → 精准选区 → 影响单 → 确认 → 一次撤销</header>
        <main id="shell"><DesignEditor projectId={initial.projectId} title="审阅测试工程" editHandle={editHandle}
          onDocumentsChange={setState} onSelection={setSelection} onReview={setRequest}/>
        <aside id="chat"><ArtifactChat projectId={initial.projectId} title="审阅测试工程" document={doc} selection={selection} request={request}
          onApply={next=>{const accepted=editHandle.current.apply(doc,next);if(accepted)setApplied(items=>[...items,{before:doc,next}]);return accepted;}}/></aside></main>
        <output id="document-state">{JSON.stringify(doc)}</output><output id="review-request">{JSON.stringify(request??null)}</output>
        <output id="fingerprint">{artifactFingerprint(doc)}</output><output id="applied">{JSON.stringify(applied)}</output>
        <output id="handle-status">{JSON.stringify({undo:typeof editHandle.current?.undo,redo:typeof editHandle.current?.redo,canUndo:editHandle.current?.canUndo,canRedo:editHandle.current?.canRedo})}</output></>;
    }
    createRoot(document.getElementById('app')).render(<App/>);
  `, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false,
    format: "iife", platform: "browser", jsx: "automatic", outdir: "browser-harness" });
  const requests: ProposalRequest[] = [], proposals: DesignDocument[] = [], serverErrors: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/api/artifact/proposal" && req.method === "POST") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProposalRequest;
        requests.push(body);
        // 只替换请求文档中的两个目标文本，不重建页面，也不改动人工批注或时间戳。
        const next: DesignDocument = { ...body.document, pages: body.document.pages.map(page => page.id === body.selection.pageId ? {
          ...page, html: page.html.replace('data-design-id="review-title">' + originalTitle, 'data-design-id="review-title">' + revisedTitle)
            .replace('data-design-id="review-button">' + originalButton, 'data-design-id="review-button">' + revisedButton),
        } : page) };
        proposals.push(next);
        res.writeHead(200, { "content-type": "application/json;charset=utf-8" });
        res.end(JSON.stringify({ document: next, summary: "仅按两条选中批注更新标题与按钮；未选说明、锁定节点、第二页和人工批注原样保留。" }));
      } catch (error) { serverErrors.push(String(error)); res.writeHead(500).end(); }
    } else if (req.url === "/app.js") {
      res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text);
    } else if (req.url === "/app.css") {
      res.setHeader("content-type", "text/css"); res.end(bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text);
    } else if (req.url === "/") {
      res.setHeader("content-type", "text/html;charset=utf-8");
      res.end('<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/app.css"><style>body{margin:0}#harness-heading{height:44px;padding:10px 18px;font:16px sans-serif}#shell{display:grid;grid-template-columns:minmax(0,1fr) 560px;height:1080px}#chat{min-height:0;border-left:1px solid var(--line-2)}output{display:none}</style></head><body><div id="app"></div><script src="/app.js"></script></body></html>');
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let browser: any;
  try {
    browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
    const page = await browser.newPage(); await page.setViewport({ width: 1840, height: 1160, deviceScaleFactor: 1 });
    page.setDefaultTimeout(15_000);
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(String(error)));
    const readDocument = (): Promise<DesignDocument> => page.$eval("#document-state", (el: Element) => JSON.parse(el.textContent!));
    const readRequest = (): Promise<ArtifactEditRequest> => page.$eval("#review-request", (el: Element) => JSON.parse(el.textContent!));
    const readApplied = (): Promise<Array<{ before: DesignDocument; next: DesignDocument }>> => page.$eval("#applied", (el: Element) => JSON.parse(el.textContent!));
    const clickButton = async (scope: string, text: string) => {
      const buttons = await page.$$(scope + " button");
      for (const button of buttons) {
        if ((await button.evaluate((el: Element) => el.textContent?.trim())) === text) {
          expect(await button.evaluate((el: HTMLButtonElement) => el.disabled), text + " 应可操作").toBe(false);
          await button.click(); return;
        }
      }
      throw new Error("未找到按钮：" + scope + " / " + text);
    };
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const screenshot = (name: string) => page.screenshot({ path: evidence + "/" + name + ".png", fullPage: true });
    const previewFrame = 'iframe[title="设计预览"]';
    const childFrame = async () => {
      await page.waitForSelector(previewFrame);
      await page.waitForFunction(() => !document.querySelector(".design-preview-loading"));
      const outer = await (await page.$(previewFrame)).contentFrame(); await outer.waitForSelector("iframe");
      const child = await (await outer.$("iframe")).contentFrame(); await child.waitForSelector('[data-design-id="review-title"]');
      return child;
    };
    const assertCanvas = async (title: string, button: string) => {
      const child = await childFrame();
      await child.waitForFunction((t: string, b: string) => document.querySelector('[data-design-id="review-title"]')?.textContent === t && document.querySelector('[data-design-id="review-button"]')?.textContent === b, {}, title, button);
    };
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await assertCanvas(originalTitle, originalButton);
    expect(await readDocument()).toEqual(initialDocument);
    await page.click(".design-comment-toggle");
    const notes = [
      { nodeId: "review-title", text: "标题改为：" + revisedTitle },
      { nodeId: "review-button", text: "按钮改为：" + revisedButton },
      { nodeId: "not-selected", text: "这条暂不送审，说明必须保留" },
    ];
    for (const [index, note] of notes.entries()) {
      const child = await childFrame();
      expect(await child.evaluate(() => { try { return !!parent.document.body; } catch { return false; } })).toBe(false);
      await page.$eval(previewFrame, (el: Element) => el.scrollIntoView({ block: "center" }));
      const rect = await child.$eval(`[data-design-id="${note.nodeId}"]`, (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const frame = await page.$eval(previewFrame, (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / 1280 }; });
      // 鼠标进入真实的双层隔离 iframe；不向 parent 伪造任何批注消息。
      await page.mouse.click(frame.x + rect.x * frame.scale, frame.y + rect.y * frame.scale);
      await page.waitForSelector('textarea[aria-label="批注内容"]', { visible: true });
      await page.type('textarea[aria-label="批注内容"]', note.text);
      await clickButton(".design-annotation-form", "保存批注");
      await page.waitForFunction((count: number) => JSON.parse(document.querySelector("#document-state")!.textContent!).pages[0].annotations.length === count, {}, index + 1);
      expect((await readDocument()).pages[0]!.annotations![index]).toMatchObject({ nodeId: note.nodeId, text: note.text });
    }
    const before = await readDocument();
    expect(before.pages[0]!.html).toBe(initialDocument.pages[0]!.html);
    expect(before.pages[1]).toEqual(initialDocument.pages[1]);
    expect(before.pages[0]!.annotations).toHaveLength(3);
    await page.click('input[aria-label="选入修改批注 1"]');
    await page.click('input[aria-label="选入修改批注 2"]');
    expect(await page.$eval('input[aria-label="选入修改批注 3"]', (el: HTMLInputElement) => el.checked)).toBe(false);
    await clickButton(".design-review-head", "送入助手草稿 · 2");
    await page.waitForSelector('[aria-label="批注修改队列"]');
    expect(requests).toHaveLength(0);
    expect(await page.$eval('[aria-label="文档创作指令"]', (el: HTMLTextAreaElement) => el.value)).toBe("");
    const review = await readRequest();
    expect(review.annotationIds).toEqual(before.pages[0]!.annotations!.slice(0, 2).map(mark => mark.id));
    expect(review.selection).toMatchObject({ documentId: before.id, pageId: "first-page", nodeId: "review-title", nodeIds: ["review-title", "review-button"], text: originalTitle, editable: true });
    await screenshot("01-real-comments-selected");
    expect(review.documentFingerprint).toBe(artifactFingerprint(before));
    await clickButton(".artifact-review-queue", "载入批注到草稿");
    await page.waitForFunction((instruction: string) => (document.querySelector('[aria-label="文档创作指令"]') as HTMLTextAreaElement).value === instruction, {}, review.instruction);
    await settle(); expect(requests).toHaveLength(0);
    expect(review.instruction).toContain(notes[0]!.text); expect(review.instruction).toContain(notes[1]!.text);
    expect(review.instruction).not.toContain(notes[2]!.text);
    await clickButton(".artifact-assistant", "生成提案");
    await page.waitForSelector('[aria-label="提案预览"]');
    expect(requests).toHaveLength(1); expect(serverErrors).toEqual([]);
    expect(requests[0]).toMatchObject({ projectId, document: before, instruction: review.instruction, selection: review.selection });
    expect(requests[0]!.selection.nodeIds).toEqual(["review-title", "review-button"]);
    const proposed = proposals[0]!;
    expect(proposed).toEqual({ ...before, pages: [{ ...before.pages[0]!, html: before.pages[0]!.html.replace(originalTitle, revisedTitle).replace(originalButton, revisedButton) }, before.pages[1]!] });
    expect(await readDocument(), "确认前不可改动真实文档").toEqual(before);
    expect(await readApplied()).toEqual([]);
    await assertCanvas(originalTitle, originalButton);
    const impact = await page.$eval('[aria-label="改动影响"]', (el: Element) => el.textContent!);
    expect(impact).toContain("明确选区"); expect(impact).toContain("审阅首页"); expect(impact).toContain("2 个节点");
    expect(impact).toContain("全局样式不变"); expect(impact).toContain("一次撤销整份提案");
    expect(impact).toContain("其他页面、锁定内容与人工批注已校验保留");
    const generated = await (await page.$('iframe[title="生成页面预览"]')).contentFrame();
    await generated.waitForSelector('[data-design-id="review-title"]');
    expect(await generated.$eval('[data-design-id="review-title"]', (el: Element) => el.textContent)).toBe(revisedTitle);
    expect(await generated.$eval('[data-design-id="review-button"]', (el: Element) => el.textContent)).toBe(revisedButton);
    await page.$eval('[aria-label="改动影响"]', (el: Element) => el.scrollIntoView({ block: "center" }));
    await screenshot("02-impact-before-confirmation");
    await clickButton(".artifact-assistant-proposal", "确认应用");
    await page.waitForFunction(() => JSON.parse(document.querySelector("#applied")!.textContent!).length === 1);
    const applied = await readDocument();
    expect(applied).toEqual({ ...proposed, updatedAt: applied.updatedAt });
    expect(applied.pages[0]!.annotations).toEqual(before.pages[0]!.annotations);
    expect(applied.pages[1]).toEqual(before.pages[1]);
    expect(await readApplied()).toEqual([{ before, next: proposed }]);
    await assertCanvas(revisedTitle, revisedButton);
    const child = await childFrame();
    for (const id of ["not-selected", "locked-note"]) {
      expect(await child.$eval(`[data-design-id="${id}"]`, (el: Element) => el.outerHTML)).toBe(initialDocument.pages[0]!.html.match(new RegExp(`<[^>]+data-design-id="${id}"[^>]*>[^<]*</[^>]+>`))![0]);
    }
    const handle = await page.$eval("#handle-status", (el: Element) => JSON.parse(el.textContent!));
    expect(handle).toMatchObject({ undo: "function", redo: "function", canUndo: true, canRedo: false });
    await screenshot("03-confirmed-two-targets");
    // 只点一次真实编辑器撤销，必须同时还原两个节点，且保留之前的人工作业。
    await clickButton(".design-toolbar", "撤销");
    await page.waitForFunction((html: string) => JSON.parse(document.querySelector("#document-state")!.textContent!).pages[0].html === html, {}, before.pages[0]!.html);
    expect(await readDocument()).toEqual(before);
    await assertCanvas(originalTitle, originalButton);
    expect(await page.$eval("#handle-status", (el: Element) => JSON.parse(el.textContent!))).toMatchObject({ canRedo: true });
    await screenshot("04-one-undo-restores-both");

    // 再取一份真实提案，然后通过真实源码输入改文档，旧预览不可覆盖新版本。
    await clickButton(".artifact-review-queue", "载入批注到草稿");
    await page.waitForFunction((instruction: string) => (document.querySelector('[aria-label="文档创作指令"]') as HTMLTextAreaElement).value === instruction, {}, review.instruction);
    await clickButton(".artifact-assistant", "生成提案");
    await page.waitForSelector('[aria-label="提案预览"]'); expect(requests).toHaveLength(2);
    expect(await readDocument()).toEqual(before);
    await clickButton(".design-view-switch", "HTML 源码");
    const sourceSelector = 'textarea[aria-label="页面 HTML 源码"]';
    await page.waitForSelector(sourceSelector, { visible: true }); await page.click(sourceSelector);
    await page.keyboard.down("Control"); await page.keyboard.press("End"); await page.keyboard.up("Control");
    await page.keyboard.type("<!-- manual-source-revision -->");
    await page.waitForFunction(() => JSON.parse(document.querySelector("#document-state")!.textContent!).pages[0].html.endsWith("<!-- manual-source-revision -->"));
    const manual = await readDocument();
    expect(manual.pages[0]!.html).toBe(before.pages[0]!.html + "<!-- manual-source-revision -->");
    expect(manual.pages[0]!.annotations).toEqual(before.pages[0]!.annotations);
    expect(manual.pages[1]).toEqual(before.pages[1]);
    await clickButton(".artifact-assistant-proposal", "确认应用");
    await page.waitForFunction(() => /预览后文档已变化|提案已失效/.test(document.querySelector(".artifact-assistant [role=alert]")?.textContent || ""));
    expect(await readDocument()).toEqual(manual); expect(await readApplied()).toHaveLength(1);
    expect(await page.$('[aria-label="提案预览"]')).toBeNull();
    await screenshot("05-stale-preview-rejected");

    // 原队列的指纹已过期：显式重新载入也不能把它当作当前文档的精准请求。
    const loadButtons = await page.$$(".artifact-review-queue button");
    const staleLoad = await Promise.all(loadButtons.map(async (button: any) => ({ button, text: await button.evaluate((el: Element) => el.textContent?.trim()) })));
    const load = staleLoad.find(item => item.text === "载入批注到草稿")!.button;
    if (!(await load.evaluate((el: HTMLButtonElement) => el.disabled))) await load.click();
    await page.waitForFunction(() => /已变化|已过期|失效/.test(document.querySelector(".artifact-review-queue")?.textContent || ""));
    const staleQueue = await page.$eval(".artifact-review-queue", (el: Element) => el.textContent!);
    expect(staleQueue).toMatch(/已变化|已过期|失效/);
    expect(await page.$eval('[aria-label="文档创作指令"]', (el: HTMLTextAreaElement) => el.value)).not.toBe(review.instruction);
    await settle(); expect(requests).toHaveLength(2); expect(await readDocument()).toEqual(manual);
    await screenshot("06-stale-review-request-rejected");
    expect(serverErrors).toEqual([]); expect(errors).toEqual([]);
    console.log("DESIGN_REVIEW_CHROMIUM_PROOF", JSON.stringify({ browser: await browser.version(), evidence, annotations: before.pages[0]!.annotations!.map(mark => ({ id: mark.id, nodeId: mark.nodeId })), selection: requests[0]!.selection, proposals: requests.length, applications: (await readApplied()).length, singleUndoRestored: true, stalePreviewRejected: true, staleReviewRejected: true, errors }));
  } catch (error) {
    if (browser) {
      const pages = await browser.pages(); const page = pages[pages.length - 1];
      if (page) { await page.screenshot({ path: evidence + "/failure.png", fullPage: true }); console.error("DESIGN_REVIEW_FAILURE", evidence, await page.evaluate(() => document.body.innerText)); }
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90_000);
