import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { findSystemBrowser } from "../../studio/scripts/direct-browser/host";
// @ts-expect-error native server module
import { createProjectGitHost } from "./project-git-host.mjs";

const puppeteer = createRequire(new URL("../../studio/package.json", import.meta.url))("puppeteer-core");

it("真实 Chromium + 真实 Git：草稿备份、完整版本恢复、清理失败重启和独立副本", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "glint-git-browser-"));
  const host = createProjectGitHost({ dataDir });
  const projectId = "git-browser-project";
  const original = { schemaVersion: 1, id: projectId, title: "当前工程", aspect: "16:9", knowledgeSources: [],
    scenes: [{ id: "one", kind: "title", title: "当前镜头", narration: { text: "当前旁白", durationMs: 1000 } }] };
  const older = { ...original, title: "历史工程", scenes: [{ ...original.scenes[0], title: "历史镜头" }] };
  const scripts = (label: string) => [{ id: "script", title: `${label}脚本`, kind: "script", content: `${label}脚本正文`, updatedAt: 1 }];
  const workspace = (label: string) => ({ version: 1, projectId, designs: { version: 1, projectId, activeId: "design", documents: [{
    id: "design", title: `${label}设计`, kind: "page", activePageId: "page", updatedAt: 1,
    pages: [{ id: "page", title: `${label}页面`, html: `<main data-design-id="main">${label}设计正文</main>`, annotations: [{ id: "mark", text: `${label}批注`, x: 10, y: 20, createdAt: 1 }] }],
  }] }, brand: { name: `${label}品牌`, accent: "#abcdef", bg: "#111111", text: "#ffffff" }, assets: [{ name: "cover.png", url: "/assets/cover.png", bytes: 10 }], board: {positions:{"scene:one":{x:label === "历史" ? 80 : 400,y:50}},viewport:{x:10,y:20,zoom:0.8}}, generation: {
    canvas: {schemaVersion:1,nodes:[{id:"image-1",kind:"image",prompt:label+"封面",model:"image-model",state:"done",outputAsset:"/api/media/assets/cover.png",error:"",createdAt:"2026-11-01T00:00:00.000Z",updatedAt:"2026-11-01T00:00:00.000Z"}],edges:[]},
    positions:{"image-1":{x:label === "历史" ? 40 : 200,y:80}}, viewport:{x:10,y:20,zoom:0.7},
    receipts:{"image-1":{requestId:"request-1",taskId:"task-1",nodeCreatedAt:"2026-11-01T00:00:00.000Z",isFinal:true}},
  } });
  const request = (operation: string, payload = {}) => host.request({ action: "git", operation, projectId, kind: "scene", ...payload });
  const versions = [];
  for (const [snapshot, label] of [[older, "历史"], [original, "当前"]] as const) {
    const result = await request("commit", { snapshot, documents: scripts(label), workspace: workspace(label), message: `${label}完整版本` });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true }); versions.push(result.version);
  }
  const calls: Record<string, unknown>[] = [], errors: string[] = [];
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{SceneEditor}from'./SceneEditor';import{recoverGitWorkspace}from'./project-git-storage';
    import{projectDocumentsKey}from'./script-documents';import{designDocumentsKey}from'./design-artifacts';
    import{projectBrandKey,projectBrandRaw}from'./design-brand';import{projectAssetsKey}from'./design-assets';
    import './app-theme.css';
    const original=${JSON.stringify(original)},workspace=${JSON.stringify(workspace("当前"))},scripts=${JSON.stringify(scripts("当前"))};
    if(!localStorage.getItem('glint.workspace')){
      localStorage.setItem('glint.workspace',JSON.stringify({mode:'source',text:'资料必须保留',template:'explainer',aspect:'16:9',evidence:'原始证据',project:original}));
      localStorage.setItem(projectDocumentsKey(original.id),JSON.stringify({version:1,projectId:original.id,activeId:'script',documents:scripts}));
      localStorage.setItem(designDocumentsKey(original.id),JSON.stringify(workspace.designs));
      localStorage.setItem(projectBrandKey(original.id),projectBrandRaw(workspace.brand));
      localStorage.setItem(projectAssetsKey(original.id),JSON.stringify(workspace.assets));
      localStorage.setItem('glint:project-board:v1:'+original.id,JSON.stringify(workspace.board.positions));
      localStorage.setItem('glint:project-board:viewport:v1:'+original.id,JSON.stringify(workspace.board.viewport));
      localStorage.setItem('glint:gen-canvas:v1:'+original.id,JSON.stringify(workspace.generation.canvas));
      localStorage.setItem('glint:gen-canvas:layout:v1:'+original.id,JSON.stringify(workspace.generation.positions));
      localStorage.setItem('glint:gen-canvas:viewport:v1:'+original.id,JSON.stringify(workspace.generation.viewport));
      localStorage.setItem('glint:gen-canvas:receipt:'+original.id+':image-1',JSON.stringify(workspace.generation.receipts['image-1']));
    }
    window.glintDesktop={request:async input=>{
      const response=await fetch('/test/native',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      return response.json();
    }};
    const restored=recoverGitWorkspace();
    function App(){const[project,setProject]=useState(restored.project);return <>
      <output id="project-state" style={{display:'none'}}>{JSON.stringify(project)}</output>
      <SceneEditor project={project} onChange={setProject} onFork={setProject}/></>}
    createRoot(document.getElementById('app')).render(<App/>);
  `, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false,
    format: "iife", platform: "browser", jsx: "automatic", outdir: "browser-harness" });
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/test/native") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString()); calls.push(input);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(await host.request(input)));
      } else if (req.url === "/app.js" || req.url === "/app.css") {
        const css = req.url.endsWith("css"); res.setHeader("content-type", css ? "text/css" : "text/javascript");
        res.end(bundle.outputFiles.find(file => file.path.endsWith(css ? ".css" : ".js"))!.text);
      } else if (req.url === "/") {
        res.setHeader("content-type", "text/html;charset=utf-8");
        res.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>');
      } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ assets: [], thumbnails: {}, entries: [], configured: false })); }
    } catch (cause) { errors.push(String(cause)); res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser: any;
  try {
    browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
    const page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1100 }); page.setDefaultTimeout(20_000);
    const pageErrors: string[] = []; page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
    const click = async (text: string, scope = "#app") => {
      await page.waitForFunction((text: string, scope: string) => [...document.querySelectorAll<HTMLButtonElement>(scope + " button")].some(button => button.textContent === text && !button.disabled), {}, text, scope);
      for (const button of await page.$$(scope + " button")) if (await button.evaluate((el: Element) => el.textContent) === text) { await button.click(); return; }
      throw new Error(`找不到按钮 ${text}`);
    };
    const idle = () => page.waitForFunction(() => document.querySelector('[aria-label="Git 版本"]')?.getAttribute("aria-busy") === "false");
    const scriptSelector = '[aria-label="脚本文档正文"]', designSelector = '[aria-label="页面 HTML 源码"]';
    const edit = (selector: string, value: string) => page.$eval(selector, (node: HTMLTextAreaElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    const openHistory = async () => {
      for (const summary of await page.$$(".glint-editor-actions summary")) if ((await summary.evaluate((node: Element) => node.textContent))?.startsWith("版本")) { await summary.click(); break; }
      await click("Git 改动与历史…"); await idle(); await click("历史版本", ".project-git-panel");
      // 初始空闲状态不代表异步历史已呈现；先等真实条目，再等该版本的差异预览。
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".pg-version")]
        .some(button => button.querySelector("strong")?.textContent === "历史完整版本" && !button.disabled && button.getClientRects().length > 0));
      for (const button of await page.$$(".pg-version")) {
        if (await button.$eval("strong", (node: Element) => node.textContent) === "历史完整版本") { await button.click(); break; }
      }
      await page.waitForFunction(() => document.querySelector('[aria-label="选中版本预览"] h3')?.textContent === "历史完整版本"
        && [...document.querySelectorAll<HTMLButtonElement>('.pg-version[aria-pressed="true"]')]
          .some(button => button.querySelector("strong")?.textContent === "历史完整版本")
        && [...document.querySelectorAll<HTMLButtonElement>('[aria-label="选中版本预览"] button')]
          .some(button => button.textContent === "复制为新工程" && !button.disabled));
      await idle();
    };
    const disk = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
    const state = () => page.$eval("#project-state", (node: Element) => JSON.parse(node.textContent!));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(url); await click("收起预览"); await click("设计"); await click("HTML 源码"); await page.waitForSelector(designSelector);
    await edit(designSelector, '<main data-design-id="main">待备份设计草稿</main>');
    await click("脚本"); await page.waitForSelector(scriptSelector); await edit(scriptSelector, "待备份脚本草稿");
    await openHistory(); await click("恢复此版本", ".project-git-panel"); await idle();
    await page.waitForSelector('[aria-label="确认恢复版本"]');
    const backup = calls.find(input => input.operation === "commit" && input.message === "恢复前保存");
    expect(backup).toMatchObject({ documents: [expect.objectContaining({ content: "待备份脚本草稿" })], workspace: { designs: { documents: [expect.objectContaining({ pages: [expect.objectContaining({ html: expect.stringContaining("待备份设计草稿") })] })] } } });
    expect((await state()).title).toBe("当前工程");
    await page.evaluate(() => {
      const remove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) { if (key.startsWith("glint:git-restore.v1:")) throw new Error("测试注入日志清理失败"); return remove.call(this, key); };
    });
    await click("确认恢复到编辑区", ".project-git-panel");
    await page.waitForFunction(() => JSON.parse(document.querySelector("#project-state")!.textContent!).title === "历史工程");
    expect(JSON.parse((await disk())[`glint:project-board:v1:${projectId}`]!)).toEqual(workspace("历史").board.positions);
    const accepted = await disk();
    expect(JSON.parse(accepted["glint.workspace"])).toMatchObject({ text: "资料必须保留", evidence: "原始证据", project: older });
    expect(JSON.parse(accepted[`glint:git-project.v1:${projectId}`])).toEqual(older);
    expect(JSON.parse(accepted[`glint:git-restore.v1:${projectId}`]).state).toBe("committed");
    expect(await page.$eval(scriptSelector, (node: HTMLTextAreaElement) => node.value)).toBe("历史脚本正文");
    await click("关闭", ".project-git-panel"); await click("设计"); await click("HTML 源码");
    expect(await page.$eval(designSelector, (node: HTMLTextAreaElement) => node.value)).toBe(workspace("历史").designs.documents[0]!.pages[0]!.html);
    // Reload creates a fresh realm and exercises startup recovery, not the old parent state.
    await page.reload(); await click("收起预览");
    expect(await state()).toEqual(older);
    const reopened = await disk(); expect(reopened[`glint:git-restore.v1:${projectId}`]).toBeUndefined();
    expect(JSON.parse(reopened["glint.workspace"]).project).toEqual(older);
    await click("脚本"); await page.waitForSelector(scriptSelector);
    expect(await page.$eval(scriptSelector, (node: HTMLTextAreaElement) => node.value)).toBe("历史脚本正文");
    await openHistory(); await click("复制为新工程", ".project-git-panel"); await click("确认创建副本", ".project-git-panel");
    await page.waitForFunction((id: string) => JSON.parse(document.querySelector("#project-state")!.textContent!).id !== id, {}, projectId);
    const copy = await state(), copyDisk = await disk();
    expect(copy.title).toBe("历史工程"); expect(copy.id).not.toBe(projectId);
    expect(JSON.parse((await disk())[`glint:project-board:v1:${copy.id}`]!)).toEqual(workspace("历史").board.positions);
    expect(JSON.parse((await disk())[`glint:project-board:viewport:v1:${copy.id}`]!)).toEqual(workspace("历史").board.viewport);
    expect(JSON.parse((await disk())[`glint:gen-canvas:v1:${copy.id}`]!)).toEqual(workspace("历史").generation.canvas);
    expect(JSON.parse((await disk())[`glint:gen-canvas:layout:v1:${copy.id}`]!)).toEqual(workspace("历史").generation.positions);
    expect(JSON.parse((await disk())[`glint:gen-canvas:receipt:${copy.id}:image-1`]!)).toEqual(workspace("历史").generation.receipts["image-1"]);
    expect(JSON.parse(copyDisk[`glint:git-project.v1:${copy.id}`])).toEqual(copy);
    expect(JSON.parse(copyDisk["glint.workspace"]).project).toEqual(copy);
    expect(JSON.parse(copyDisk[`glint.project-designs.v1:${copy.id}`])).toMatchObject({ projectId: copy.id, documents: workspace("历史").designs.documents });
    expect(JSON.parse(copyDisk[`glint.project-designs.v1:${projectId}`]).projectId).toBe(projectId);
    expect((await host.request({ action: "git", operation: "history", projectId, kind: "scene" })).versions.map((item: any) => item.id)).toEqual(expect.arrayContaining(versions));
    expect(errors).toEqual([]); expect(pageErrors).toEqual([]);
  } finally {
    await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await host.dispose(); await rm(dataDir, { recursive: true, force: true });
  }
}, 120_000);

it("真实 IdeaStudio + Chromium + Git：副本登记、跨作品重开、保存去重与显式载入主快照及当前附件（共享服务未确认）", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "glint-idea-git-browser-"));
  const host = createProjectGitHost({ dataDir });
  let browser: any, server: ReturnType<typeof createServer> | undefined;
  try {
    const projectId = "idea-git-original";
    const original = { schemaVersion: 1, id: projectId, title: "原工程当前版", aspect: "16:9", knowledgeSources: [],
      scenes: [{ id: "one", kind: "title", title: "当前镜头", narration: { text: "当前旁白", durationMs: 1000 } }] };
    const older = { ...original, title: "Git 历史副本作品", scenes: [{ ...original.scenes[0], title: "历史镜头", narration: { text: "历史旁白", durationMs: 1000 } }] };
    const other = { ...original, id: "idea-git-other", title: "另一作品", scenes: [{ ...original.scenes[0], title: "另一作品镜头" }] };
    const scripts = (label: string) => [{ id: "script", title: `${label}脚本`, kind: "script", content: `${label}脚本正文`, updatedAt: 1 }];
    const workspace = (label: string, id = projectId) => ({ version: 1, projectId: id, designs: { version: 1, projectId: id, activeId: "design", documents: [{
      id: "design", title: `${label}设计`, kind: "page", activePageId: "page", updatedAt: 1,
      pages: [{ id: "page", title: `${label}页面`, html: `<main data-design-id="main">${label}设计正文</main>`, annotations: [{ id: "mark", text: `${label}批注`, x: 10, y: 20, createdAt: 1 }] }],
    }] }, brand: { name: `${label}品牌`, accent: "#abcdef", bg: "#111111", text: "#ffffff" }, assets: [{ name: `cover-${label === "历史" ? "history" : label === "当前" ? "current" : "other"}.png`, url: `/assets/cover-${label === "历史" ? "history" : label === "当前" ? "current" : "other"}.png`, bytes: 10 }] });
    const request = (operation: string, payload = {}) => host.request({ action: "git", operation, projectId, kind: "scene", ...payload });
    const versions: string[] = [];
    for (const [snapshot, label] of [[older, "历史"], [original, "当前"]] as const) {
      const result = await request("commit", { snapshot, documents: scripts(label), workspace: workspace(label), message: `${label}父级完整版本` });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, version: expect.stringMatching(/^[a-f0-9]{40}$/) });
      versions.push(result.version);
    }
    const historyBefore = await request("history"), statusBefore = await request("status");
    expect(historyBefore.versions.map((item: any) => item.id)).toEqual([...versions].reverse());
    expect(statusBefore).toMatchObject({ ok: true, current: versions[1], versionCount: 2, changedFiles: [] });
    const calls: Record<string, unknown>[] = [], errors: string[] = [], sessionCalls: Array<{ url: string; body: any }> = [];
    const bundle = await build({ stdin: { contents: `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{IdeaStudio}from'./IdeaStudio';import{saveProject}from'./project-history';
      import{projectDocumentsKey}from'./script-documents';import{designDocumentsKey}from'./design-artifacts';
      import{projectBrandKey,projectBrandRaw}from'./design-brand';import{projectAssetsKey}from'./design-assets';
      import './app-theme.css';import './ui-system.css';
      const original=${JSON.stringify(original)},other=${JSON.stringify(other)};
      const context={mode:'source',text:'原工程资料必须保留',template:'explainer',theme:'glint-dark',aspect:'16:9',evidence:'原始证据'};
      if(!localStorage.getItem('glint.workspace')){
        localStorage.setItem('glint.workspace',JSON.stringify({...context,project:original}));
        saveProject({...context,id:'original-list-entry',name:original.title,project:original});
        saveProject({...context,id:'other-list-entry',name:other.title,project:other,text:'另一作品资料',evidence:'另一作品证据'});
        for(const [project,workspace,scripts] of [
          [original,${JSON.stringify(workspace("当前"))},${JSON.stringify(scripts("当前"))}],
          [other,${JSON.stringify(workspace("另一", other.id))},${JSON.stringify(scripts("另一"))}]
        ]){
          localStorage.setItem(projectDocumentsKey(project.id),JSON.stringify({version:1,projectId:project.id,activeId:'script',documents:scripts}));
          localStorage.setItem(designDocumentsKey(project.id),JSON.stringify(workspace.designs));
          localStorage.setItem(projectBrandKey(project.id),projectBrandRaw(workspace.brand));
          localStorage.setItem(projectAssetsKey(project.id),JSON.stringify(workspace.assets));
        }
      }
      window.glintDesktop={request:async input=>{
        const response=await fetch('/test/native',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
        return response.json();
      }};
      createRoot(document.getElementById('app')).render(<IdeaStudio cardStyle={{}}/>);
    `, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" }, bundle: true, write: false,
      format: "iife", platform: "browser", jsx: "automatic", outdir: "browser-harness" });
    server = createServer(async (req, res) => {
      try {
        if (req.url === "/test/native") {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const input = JSON.parse(Buffer.concat(chunks).toString()); calls.push(input);
          res.setHeader("content-type", "application/json"); res.end(JSON.stringify(await host.request(input)));
        } else if (req.url && ["/showcase/coffee-still.webp", "/showcase/entropy-second-law.png", "/showcase/uncertainty-intro.png", "/showcase/entropy-intro.png"].includes(req.url)) {
          res.setHeader("content-type", req.url.endsWith(".webp") ? "image/webp" : "image/png");
          res.end(await readFile(fileURLToPath(new URL(`../public${req.url}`, import.meta.url))));
        } else if (req.url?.startsWith("/api/session/")) {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          sessionCalls.push({ url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null });
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "测试边界：共享服务未确认，仅验收真实 Git 与本机作品登记" }));
        } else if (req.url === "/app.js" || req.url === "/app.css") {
          const css = req.url.endsWith("css"); res.setHeader("content-type", css ? "text/css" : "text/javascript");
          res.end(bundle.outputFiles.find(file => file.path.endsWith(css ? ".css" : ".js"))!.text);
        } else if (req.url === "/") {
          res.setHeader("content-type", "text/html;charset=utf-8");
          res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>');
        } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ assets: [], thumbnails: {}, entries: [], configured: false, voices: ["mock"] })); }
      } catch (cause) { errors.push(String(cause)); res.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    browser = await puppeteer.launch({ executablePath: findSystemBrowser(), headless: true });
    const page = await browser.newPage(); await page.setViewport({ width: 1800, height: 1100 }); page.setDefaultTimeout(20_000);
    const pageErrors: string[] = []; page.on("pageerror", (error: Error) => pageErrors.push(String(error)));
    const click = async (text: string, scope = "#app") => {
      await page.waitForFunction((text: string, scope: string) => [...document.querySelectorAll<HTMLButtonElement>(scope + " button")]
        .some(button => button.textContent === text && !button.disabled && !button.closest("[hidden]") && button.getClientRects().length), {}, text, scope);
      for (const button of await page.$$(scope + " button")) {
        if (await button.evaluate((el: HTMLButtonElement, text: string) => el.textContent === text && !el.disabled && !el.closest("[hidden]") && el.getClientRects().length > 0, text)) { await button.click(); return; }
      }
      throw new Error(`找不到可见按钮 ${text}`);
    };
    const disk = (): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
    const projects = async () => JSON.parse((await disk())["glint.projects"]);
    const currentIdentity = async (id: string, title: string) => {
      await page.waitForFunction((id: string, title: string) => document.querySelector('.idea-studio')?.getAttribute('data-view') === 'workspace'
        && document.querySelector('.workspace-title')?.textContent === title
        && document.querySelector('[aria-label="共享工程编辑"] code')?.textContent === id
        && JSON.parse(localStorage.getItem('glint.workspace') ?? 'null')?.project?.id === id
        && document.querySelector('.workspace-save-status')?.textContent === '已自动保存到本机', {}, id, title);
    };
    const openRecent = async (title: string) => {
      await page.waitForSelector('.idea-studio[data-view="home"] .home-project', { visible: true });
      for (const button of await page.$$('.home-project')) {
        if (await button.$eval('strong', (el: Element) => el.textContent) === title) { await button.click(); return; }
      }
      throw new Error(`最近作品缺少 ${title}`);
    };
    const sharedUnconfirmed = async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="共享工程编辑"] [role="alert"]')]
        .some(node => node.textContent?.includes('共享保存未确认，草稿仍保留')));
      expect(await page.$eval('[aria-label="共享工程编辑"]', (el: Element) => el.textContent)).toContain("共享服务未确认");
    };
    const evidenceDir = fileURLToPath(new URL("../evidence/", import.meta.url));
    expect((await stat(evidenceDir)).isDirectory()).toBe(true);
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await openRecent(original.title); await currentIdentity(projectId, original.title); await sharedUnconfirmed();
    await click("收起预览");
    const beforeDisk = await disk(), beforeProjects = await projects();
    const attachmentKeys = [projectId, other.id].flatMap(id => [
      `glint.project-documents.v1:${id}`, `glint.project-designs.v1:${id}`, `glint:brand-project.v1:${id}`, `glint:project-assets.v1:${id}`,
    ]);
    for (const key of attachmentKeys) expect(beforeDisk[key], key).toBeDefined();
    for (const summary of await page.$$(".glint-editor-actions summary")) {
      if ((await summary.evaluate((node: Element) => node.textContent))?.startsWith("版本")) { await summary.click(); break; }
    }
    await click("Git 改动与历史…");
    const idle = () => page.waitForFunction(() => document.querySelector('[aria-label="Git 版本"]')?.getAttribute("aria-busy") === "false");
    await idle(); await click("历史版本", ".project-git-panel");
    // Initial status and history requests are independent; aria-busy=false alone need not mean history arrived.
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".pg-version")]
      .some(button => button.querySelector("strong")?.textContent === "历史父级完整版本" && !button.disabled));
    for (const button of await page.$$(".pg-version")) {
      if (await button.$eval("strong", (node: Element) => node.textContent) === "历史父级完整版本") { await button.click(); break; }
    }
    await page.waitForFunction(() => document.querySelector('[aria-label="选中版本预览"] h3')?.textContent === "历史父级完整版本");
    await idle();
    await click("复制为新工程", ".project-git-panel"); await click("确认创建副本", ".project-git-panel");
    // 此处之前不触发手动保存或登记，直接验证真实父级回调自动登记。
    await page.waitForFunction((id: string) => {
      const entries = JSON.parse(localStorage.getItem('glint.projects') ?? '[]');
      return entries.length === 3 && entries.some((entry: any) => entry.project?.id !== id && entry.name === 'Git 历史副本作品');
    }, {}, projectId);
    const copyDisk = await disk(), autoProjects = await projects();
    const registered = autoProjects.find((item: any) => item.name === older.title), copy = registered.project;
    expect(copy).toEqual({ ...older, id: copy.id }); expect(copy.id).not.toBe(projectId); expect(copy.id).not.toBe(other.id);
    expect(registered).toMatchObject({ id: copy.id, name: older.title, project: copy, text: "原工程资料必须保留", evidence: "原始证据" });
    expect(autoProjects.filter((item: any) => item.id === copy.id || item.project?.id === copy.id)).toHaveLength(1);
    for (const saved of beforeProjects) expect(autoProjects.find((item: any) => item.id === saved.id)).toEqual(saved);
    expect(JSON.parse(copyDisk["glint.workspace"])).toMatchObject({ project: copy, text: "原工程资料必须保留", evidence: "原始证据" });
    expect(JSON.parse(copyDisk[`glint:git-project.v1:${copy.id}`])).toEqual(copy);
    expect(JSON.parse(copyDisk[`glint.project-documents.v1:${copy.id}`])).toEqual({ version: 1, projectId: copy.id, activeId: "script", documents: scripts("历史") });
    expect(JSON.parse(copyDisk[`glint.project-designs.v1:${copy.id}`])).toEqual({ ...workspace("历史").designs, projectId: copy.id });
    const historicalBrand = workspace("历史").brand;
    expect(JSON.parse(copyDisk[`glint:brand-project.v1:${copy.id}`])).toEqual({ name: historicalBrand.name,
      colors: { accent: historicalBrand.accent, bg: historicalBrand.bg, text: historicalBrand.text } });
    expect(JSON.parse(copyDisk[`glint:project-assets.v1:${copy.id}`])).toEqual(workspace("历史").assets);
    for (const key of attachmentKeys) expect(copyDisk[key], key).toBe(beforeDisk[key]);
    expect(await request("history")).toEqual(historyBefore); expect(await request("status")).toEqual(statusBefore);
    expect(calls.filter(input => input.operation === "copy")).toEqual([expect.objectContaining({ projectId, version: versions[0] })]);
    expect(calls.filter(input => input.operation === "commit" || input.operation === "checkout" || input.operation === "discard")).toEqual([]);
    await currentIdentity(copy.id, copy.title); await sharedUnconfirmed();
    expect(await page.$eval('[aria-label="完整本机版本与作品列表"]', (el: Element) => el.textContent)).toContain("完整本机版本已登记到作品列表");
    await click("返回作品", '[aria-label="工程导航"]');
    await page.waitForSelector('.idea-studio[data-view="home"] .home-project', { visible: true });
    expect(await page.$$eval('.home-project strong', (nodes: Element[]) => nodes.map(node => node.textContent))).toEqual(expect.arrayContaining([original.title, other.title, copy.title]));
    await page.screenshot({ fullPage: true });
    await openRecent(other.title); await currentIdentity(other.id, other.title); await sharedUnconfirmed();
    expect(JSON.parse((await disk())["glint.workspace"])).toMatchObject({ project: other, text: "另一作品资料", evidence: "另一作品证据" });
    await click("返回作品", '[aria-label="工程导航"]'); await openRecent(copy.title);
    await currentIdentity(copy.id, copy.title); await sharedUnconfirmed();
    await click("收起预览"); await click("脚本");
    await page.waitForSelector('[aria-label="脚本文档正文"]', { visible: true });
    expect(await page.$eval('[aria-label="脚本文档正文"]', (node: HTMLTextAreaElement) => node.value)).toBe("历史脚本正文");
    await click("设计"); await click("HTML 源码");
    await page.waitForSelector('[aria-label="页面 HTML 源码"]', { visible: true });
    expect(await page.$eval('[aria-label="页面 HTML 源码"]', (node: HTMLTextAreaElement) => node.value)).toBe(workspace("历史").designs.documents[0]!.pages[0]!.html);
    const reopenedDisk = await disk();
    expect(JSON.parse(reopenedDisk["glint.workspace"])).toMatchObject({ project: copy, text: "原工程资料必须保留", evidence: "原始证据" });
    expect(await projects()).toEqual(autoProjects);
    await page.click('[aria-label="工程导航"] .workspace-more > summary');
    await click("历史版本", '[aria-label="工程导航"]'); await click("保存项目", '#workspace-tools section[aria-label="历史版本"]');
    await page.waitForFunction(() => document.querySelector('.workspace-save-status')?.textContent === '项目已保存');
    const savedProjects = await projects();
    expect(savedProjects).toHaveLength(3);
    expect(savedProjects.map((item: any) => item.id).sort()).toEqual(autoProjects.map((item: any) => item.id).sort());
    expect(savedProjects.filter((item: any) => item.id === copy.id || item.project?.id === copy.id)).toHaveLength(1);
    expect(savedProjects.find((item: any) => item.id === copy.id)).toMatchObject({ ...registered, updatedAt: expect.any(Number) });
    for (const saved of beforeProjects) expect(savedProjects.find((item: any) => item.id === saved.id)).toEqual(saved);
    await click("关闭", ".workspace-tools-heading");
    await sharedUnconfirmed();
    await page.screenshot({ fullPage: true });
    const finalDisk = await disk();
    for (const key of attachmentKeys) expect(finalDisk[key], key).toBe(beforeDisk[key]);
    for (const prefix of ["glint.project-documents.v1:", "glint.project-designs.v1:", "glint:brand-project.v1:", "glint:project-assets.v1:", "glint:git-project.v1:"]) {
      expect(finalDisk[`${prefix}${copy.id}`], prefix).toBe(copyDisk[`${prefix}${copy.id}`]);
    }
    expect(JSON.parse(finalDisk["glint.workspace"]).project).toEqual(copy);
    expect(await request("history")).toEqual(historyBefore); expect(await request("status")).toEqual(statusBefore);
    for (const id of [projectId, other.id, copy.id]) expect(sessionCalls.some(call => call.url === "/api/session/open" && call.body?.projectId === id)).toBe(true);

    // 副本附件已有后续编辑，显式载入必须读取当前本机值，而不是重放历史提交。
    await click("返回作品", '[aria-label="工程导航"]'); await openRecent(other.title);
    await currentIdentity(other.id, other.title); await sharedUnconfirmed();
    const stale = { ...copy, title: "副本旧列表分镜", scenes: [{ ...copy.scenes[0], title: "过期列表镜头", narration: { text: "过期列表旁白", durationMs: 1000 } }] };
    await page.evaluate((id: string, stale: any) => {
      const entries = JSON.parse(localStorage.getItem("glint.projects")!);
      localStorage.setItem("glint.projects", JSON.stringify(entries.map((entry: any) => entry.project?.id === id ? { ...entry, name: stale.title, project: stale } : entry)));
      const scriptKey = `glint.project-documents.v1:${id}`, designKey = `glint.project-designs.v1:${id}`;
      const scripts = JSON.parse(localStorage.getItem(scriptKey)!); scripts.documents[0].content = "副本当前附件脚本（Git 提交后编辑）";
      const designs = JSON.parse(localStorage.getItem(designKey)!); designs.documents[0].pages[0].html = '<main data-design-id="main">副本当前附件设计（Git 提交后编辑）</main>';
      localStorage.setItem(scriptKey, JSON.stringify(scripts, null, 2));
      localStorage.setItem(designKey, JSON.stringify(designs, null, 2));
      const brandKey = `glint:brand-project.v1:${id}`, assetsKey = `glint:project-assets.v1:${id}`;
      const brand = JSON.parse(localStorage.getItem(brandKey)!); brand.name = "副本当前附件品牌";
      const assets = JSON.parse(localStorage.getItem(assetsKey)!); assets[0].name = "copy-current.png"; assets[0].url = "/assets/copy-current.png";
      localStorage.setItem(brandKey, JSON.stringify(brand, null, 2)); localStorage.setItem(assetsKey, JSON.stringify(assets, null, 2));
    }, copy.id, stale);
    // 重载只刷新真实首页的列表状态，当前工作区仍是另一作品。
    await page.reload();
    await page.waitForFunction((id: string) => JSON.parse(localStorage.getItem("glint.workspace") ?? "null")?.project?.id === id
      && document.querySelector('.workspace-save-status')?.textContent === '已自动保存到本机', {}, other.id);
    const beforeLocalLoad = await disk();
    const preservedLocalKeys = [...attachmentKeys, ...["glint.project-documents.v1:", "glint.project-designs.v1:", "glint:brand-project.v1:", "glint:project-assets.v1:", "glint:git-project.v1:"].map(prefix => `${prefix}${copy.id}`)];
    const confirmAction = async (action: () => Promise<void>, message: string, accept: boolean) => {
      const handled = new Promise<string>((resolve, reject) => page.once("dialog", async (dialog: any) => {
        try { const text = dialog.message(); if (accept) await dialog.accept(); else await dialog.dismiss(); resolve(text); }
        catch (cause) { reject(cause); }
      }));
      await action(); expect(await handled).toContain(message);
    };
    await confirmAction(() => openRecent(stale.title), "仅载入作品列表的分镜快照", false);
    await page.waitForFunction(() => document.querySelector('[aria-label="完整本机版本与作品列表"]')?.textContent?.includes("列表分镜与上次 Git 完整版本不同"));
    expect(await page.$eval('.idea-studio', (node: Element) => node.getAttribute("data-view"))).toBe("home");
    expect(await page.$eval('.workspace-title', (node: Element) => node.textContent)).toBe(other.title);
    expect(await disk()).toEqual(beforeLocalLoad);

    await confirmAction(() => click("载入本机主快照与当前附件", '[aria-label="完整本机版本与作品列表"]'), "这不是某次 Git 提交的还原", true);
    await currentIdentity(copy.id, copy.title); await sharedUnconfirmed();
    expect(await page.$eval('[aria-label="完整本机版本与作品列表"]', (node: Element) => node.textContent)).toContain("未还原 Git 提交");
    const loadedDisk = await disk();
    expect(JSON.parse(loadedDisk["glint.workspace"])).toMatchObject({ project: copy, text: "原工程资料必须保留", evidence: "原始证据" });
    expect(loadedDisk["glint.projects"]).toBe(beforeLocalLoad["glint.projects"]);
    for (const key of preservedLocalKeys) expect(loadedDisk[key], key).toBe(beforeLocalLoad[key]);
    expect(JSON.parse(loadedDisk["glint.projects"]).find((entry: any) => entry.project?.id === copy.id).project).toEqual(stale);
    await click("收起预览"); await click("脚本");
    await page.waitForSelector('[aria-label="脚本文档正文"]', { visible: true });
    expect(await page.$eval('[aria-label="脚本文档正文"]', (node: HTMLTextAreaElement) => node.value)).toBe("副本当前附件脚本（Git 提交后编辑）");
    await click("设计"); await click("HTML 源码");
    await page.waitForSelector('[aria-label="页面 HTML 源码"]', { visible: true });
    expect(await page.$eval('[aria-label="页面 HTML 源码"]', (node: HTMLTextAreaElement) => node.value)).toBe('<main data-design-id="main">副本当前附件设计（Git 提交后编辑）</main>');
    // Local annotation text never enters pendingDesignDrafts until “保存批注”.
    // The retained, hidden editor must still veto remounting without a confirmation dialog.
    await click("可视编辑");
    const propertyOuter = await (await page.$('iframe[title="设计预览"]')).contentFrame();
    const propertyInner = await (await propertyOuter.$('iframe[title="设计页面内容"]')).contentFrame();
    await propertyInner.waitForSelector("main"); await propertyInner.click("main");
    await page.waitForSelector('[aria-label="圆角"]', { visible: true });
    for (const [label, value] of [["字体", "Arial, sans-serif"], ["圆角", "12px"], ["阴影", "0 4px 16px #00000033"], ["旋转", "15deg"]]) {
      const input = await page.$(`[aria-label="${label}"]`); await input.click({ clickCount: 3 });
      await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await input.type(value);
    }
    await click("应用属性", ".design-editor"); await click("保存", ".design-editor");
    expect(JSON.parse((await disk())[`glint.project-designs.v1:${copy.id}`]).documents[0].pages[0].html).toContain("rotate: 15deg");
    const appliedOuter = await (await page.$('iframe[title="设计预览"]')).contentFrame();
    const appliedInner = await (await appliedOuter.$('iframe[title="设计页面内容"]')).contentFrame();
    await appliedInner.waitForFunction(() => document.querySelector<HTMLElement>("main")?.style.rotate === "15deg");
    if (process.env.GLINT_EVIDENCE_DIR) {
      await mkdir(process.env.GLINT_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.GLINT_EVIDENCE_DIR, "design-extended-properties.png"), fullPage: true });
    }
    await page.click(".design-comment-toggle");
    const outer = await (await page.$('iframe[title="设计预览"]')).contentFrame();
    const inner = await (await outer.$('iframe[title="设计页面内容"]')).contentFrame();
    await inner.waitForSelector("main"); await inner.click("main");
    await page.waitForSelector('[aria-label="批注内容"]', { visible: true });
    await page.type('[aria-label="批注内容"]', "浏览器中尚未保存的批注");
    await click("作品", ".glint-view-switch");
    await page.waitForFunction(() => !document.querySelector('iframe[title="设计预览"]'));
    expect(page.frames()).not.toContain(inner);
    const guardedDisk = await disk(), unexpectedDialogs: string[] = [];
    const dismissUnexpected = async (dialog: any) => { unexpectedDialogs.push(dialog.message()); await dialog.dismiss(); };
    page.on("dialog", dismissUnexpected);
    await click("载入本机主快照与当前附件", '[aria-label="完整本机版本与作品列表"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="完整本机版本与作品列表"]')?.textContent?.includes("批注尚未保存"));
    expect(await disk()).toEqual(guardedDisk); expect(unexpectedDialogs).toEqual([]);
    expect(await page.$eval('[aria-label="批注内容"]', (node: HTMLTextAreaElement) => node.value)).toBe("浏览器中尚未保存的批注");
    if (process.env.GLINT_EVIDENCE_DIR) {
      await mkdir(process.env.GLINT_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.GLINT_EVIDENCE_DIR, "git-load-retained-annotation-blocked.png"), fullPage: true });
    }
    await click("设计", ".glint-view-switch"); await click("保存批注", ".design-editor"); await click("保存", ".design-editor");
    const savedDesign = JSON.parse((await disk())[`glint.project-designs.v1:${copy.id}`]);
    expect(savedDesign.documents[0].pages[0].annotations).toEqual(expect.arrayContaining([expect.objectContaining({ text: "浏览器中尚未保存的批注" })]));
    await click("脚本", ".glint-view-switch"); await click("新建", ".script-editor");
    await page.type('[aria-label="文档名称"]', "未提交的新脚本名"); await click("作品", ".glint-view-switch");
    const namedDisk = await disk();
    await click("载入本机主快照与当前附件", '[aria-label="完整本机版本与作品列表"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="完整本机版本与作品列表"]')?.textContent?.includes("名称尚未提交"));
    expect(await disk()).toEqual(namedDisk);
    await click("脚本", ".glint-view-switch"); await click("取消", ".script-editor");
    await page.$eval('[aria-label="脚本文档正文"]', (node: HTMLTextAreaElement) => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await click("作品", ".glint-view-switch");
    await click("载入本机主快照与当前附件", '[aria-label="完整本机版本与作品列表"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="完整本机版本与作品列表"]')?.textContent?.includes("完成中文输入"));
    expect(await disk()).toEqual(namedDisk); expect(unexpectedDialogs).toEqual([]);
    await page.$eval('[aria-label="脚本文档正文"]', (node: HTMLTextAreaElement) => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    page.off("dialog", dismissUnexpected);
    const beforeRegistration = await disk();
    await confirmAction(() => click("载入本机主快照与当前附件", '[aria-label="完整本机版本与作品列表"]'), "这不是某次 Git 提交的还原", true);
    await currentIdentity(copy.id, copy.title);
    expect((await disk())[`glint.project-designs.v1:${copy.id}`]).toBe(beforeRegistration[`glint.project-designs.v1:${copy.id}`]);
    await confirmAction(() => click("登记完整本机版本", '[aria-label="完整本机版本与作品列表"]'), "将作品列表中的该工程入口更新为当前完整本机版本", true);
    await page.waitForFunction(() => document.querySelector('[aria-label="完整本机版本与作品列表"]')?.textContent?.includes("完整本机版本已登记到作品列表"));
    const localFinalDisk = await disk(), localFinalProjects = await projects();
    expect(localFinalProjects).toHaveLength(3);
    expect(localFinalProjects.find((entry: any) => entry.id === copy.id)).toMatchObject({ ...registered, updatedAt: expect.any(Number) });
    for (const saved of beforeProjects) expect(localFinalProjects.find((entry: any) => entry.id === saved.id)).toEqual(saved);
    for (const key of preservedLocalKeys) expect(localFinalDisk[key], key).toBe(beforeRegistration[key]);
    expect(JSON.parse(localFinalDisk["glint.workspace"])).toMatchObject({ project: copy, text: "原工程资料必须保留", evidence: "原始证据" });
    // The copy remains discoverable after losing its list entry and restarting on another work.
    await page.waitForFunction((id: string) => localStorage.getItem(`glint:git-source.v1:${id}`) !== null, {}, copy.id);
    await click("返回作品", '[aria-label="工程导航"]'); await openRecent(other.title);
    await page.waitForFunction((id: string) => JSON.parse(localStorage.getItem('glint.workspace') || '{}').project?.id === id, {}, other.id);
    await page.evaluate((id: string) => {
      const entries = JSON.parse(localStorage.getItem('glint.projects') || '[]');
      localStorage.setItem('glint.projects', JSON.stringify(entries.filter((entry: any) => entry.project?.id !== id)));
    }, copy.id);
    await page.reload({ waitUntil: "networkidle0" });
    const orphanDisk = await disk();
    await page.evaluate(() => [...document.querySelectorAll('summary')].find(node => node.textContent === '查找待登记的本机 Git 工程')!.click());
    await page.waitForSelector('[aria-label="待核对的本机 Git 工程"] .ws-row');
    await page.evaluate((id: string) => {
      const row = [...document.querySelectorAll('[aria-label="待核对的本机 Git 工程"] .ws-row')].find(node => node.querySelector('code')?.textContent === id)!;
      [...row.querySelectorAll('button')].find(node => node.textContent === '核对此本机工程')!.click();
    }, copy.id);
    expect(await disk()).toEqual(orphanDisk);
    await confirmAction(() => click("载入本机主快照与当前附件", '[aria-label="完整本机版本与作品列表"]'), "这不是某次 Git 提交的还原", true);
    expect(JSON.parse((await disk())["glint.workspace"])).toMatchObject({ project: copy, text: "原工程资料必须保留", evidence: "原始证据" });
    await click("登记完整本机版本", '[aria-label="完整本机版本与作品列表"]');
    expect(JSON.parse((await disk())["glint.projects"]).filter((entry: any) => entry.project?.id === copy.id)).toHaveLength(1);
    expect(await request("history")).toEqual(historyBefore); expect(await request("status")).toEqual(statusBefore);
    expect(calls.filter(input => input.operation === "copy")).toHaveLength(1);
    expect(calls.filter(input => input.operation === "commit" || input.operation === "checkout" || input.operation === "discard")).toEqual([]);
    expect(errors).toEqual([]); expect(pageErrors).toEqual([]);
  } finally {
    try { await browser?.close(); }
    finally {
      try { if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); }
      finally { try { await host.dispose(); } finally { await rm(dataDir, { recursive: true, force: true }); } }
    }
  }
}, 120_000);
