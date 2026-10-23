import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error JavaScript server module, exercised over HTTP rather than duplicated.
import { createWebServer } from "./index.mjs";
import { consumeAnswerStream } from "../src/answer-stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCheckStore } from "./checks.mjs";
import { createMediaJobs } from "./media-jobs.mjs";
import { FileSessionStore } from "@glintai/session/node";
import { parseProject } from "@glintai/scenescript";
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function start(options: Record<string, unknown>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-session-")); directories.push(directory);
  const server = createWebServer({ sessionStore: new FileSessionStore(directory, document => { parseProject(document); }), ...options }) as Server;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ask`;
}
function post(url: string, body: unknown, signal?: AbortSignal) {
  return fetch(url, { method: "POST", body: JSON.stringify(body), signal });
}
it("serves one creation pack catalog and materializes unique pinned editable projects", async () => {
  const url = (await start({})).replace("/api/ask", "/api/creation-packs");
  const catalog = await (await fetch(`${url}?query=数据`)).json();
  expect(catalog.packs.map((pack: { id: string }) => pack.id)).toEqual(["data-insight"]);
  const instanceUrl = `${url}/instantiate`;
  const a = await (await post(instanceUrl, { id: "product-launch", inputs: { productName: "真实商品" } })).json();
  const b = await (await post(instanceUrl, { id: "product-launch", inputs: { productName: "真实商品" } })).json();
  expect(parseProject(a.project).creationPack).toEqual(a.pack);
  expect(a.project.id).not.toBe(b.project.id);
  expect(JSON.stringify(a.project)).toContain("真实商品");
  expect((await post(instanceUrl, { id: "../run-script", inputs: {} })).status).toBe(400);
  expect((await post(instanceUrl, { id: "product-launch", inputs: { unexpected: "bad" } })).status).toBe(400);
  expect((await fetch(instanceUrl)).status).toBe(405);
  expect((await fetch(instanceUrl, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
});
it("checks only completed server-owned video paths and strips diagnostics from delivery replies", async () => {
  let received: { videoPath: string; audio: string; signal: AbortSignal } | undefined;
  const url = (await start({ makeRunner: { videoFile: (id: string) => id === "idea-ready" ? "C:/private/owned.mp4" : null },
    deliveryChecker: async (input: typeof received) => { received = input; return { pass: false, bytes: 42, sha256: "abc", duration: 1, checks: [{ name: "decode", pass: false, detail: "PRIVATE subprocess secret" }] }; },
  })).replace("/api/ask", "/api/delivery-check/idea-ready");
  const response = await post(url, { videoPath: "C:/arbitrary.mp4" });
  expect(response.status).toBe(200); const text = await response.text();
  expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("private/owned");
  expect(received?.videoPath).toBe("C:/private/owned.mp4"); expect(received?.audio).toBe("optional");
  expect((await post(url.replace("idea-ready", "idea-unknown"), {})).status).toBe(404);
  expect((await fetch(url)).status).toBe(405);
});
it("serves Unicode questions and final answers over real local HTTP", async () => {
  const url = await start({ engineForProject: () => ({ async *streamAnswer(question: string) {
    yield { type: "done", answer: { answer: question, refused: false, refusalReason: null, citations: [] } };
  } }) });
  const response = await post(url, { project: "entropy", question: "中文😀" });
  expect((await consumeAnswerStream(response, new AbortController().signal)).answer).toBe("中文😀");
});
it("rejects invalid JSON, oversized bodies, empty questions, unknown projects and unavailable engines", async () => {
  const url = await start({ engineForProject: () => null });
  expect((await fetch(url, { method: "POST", body: "{" })).status).toBe(400);
  expect((await post(url, { question: "x".repeat(21000) })).status).toBe(413);
  expect((await post(url, { question: " " })).status).toBe(400);
  expect((await post(url, { question: "x", project: "toString" })).status).toBe(400);
  expect((await post(url, { question: "x", project: "entropy" })).status).toBe(503);
});
it("does not leak provider errors after headers", async () => {
  const url = await start({ engineForProject: () => ({ async *streamAnswer() { throw new Error("SECRET provider body"); yield; } }) });
  const response = await post(url, { project: "entropy", question: "x" });
  const text = await response.text();
  expect(text).toContain('"type":"error"');
  expect(text).not.toContain("SECRET");
});
it("turns a model deadline into a terminal error", async () => {
  const url = await start({ timeoutMs: 40, engineForProject: () => ({ async *streamAnswer(_q: string, { signal }: { signal: AbortSignal }) {
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); yield;
  } }) });
  const response = await post(url, { project: "entropy", question: "x" });
  expect(await response.text()).toContain("timed out");
});
it("disconnect aborts upstream work", async () => {
  let aborted!: () => void;
  const abortSeen = new Promise<void>((resolve) => { aborted = resolve; });
  const url = await start({ engineForProject: () => ({ async *streamAnswer(_q: string, { signal }: { signal: AbortSignal }) {
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { aborted(); reject(signal.reason); }, { once: true })); yield;
  } }) });
  const controller = new AbortController();
  const response = await post(url, { project: "entropy", question: "x" }, controller.signal);
  controller.abort();
  await response.body?.cancel().catch(() => {});
  await abortSeen;
});
it("rejects nonlocal Hosts and cross-origin mutations", async () => {
  const url = await start({ engineForProject: () => null });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers: { host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  expect(status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { origin: "https://attacker.example" }, body: "{}" })).status).toBe(403);
});
it("serves full, partial, suffix, HEAD and attachment responses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-video-")); directories.push(dir);
  const file = path.join(dir, "test.mp4"), bytes = Buffer.alloc(128, 42); fs.writeFileSync(file, bytes);
  const url = (await start({ makeRunner: { videoFile: () => file } })).replace("/api/ask", "/api/video/idea-test");
  const ranged = await fetch(url, { headers: { range: "bytes=10-19" } });
  expect(ranged.status).toBe(206); expect(ranged.headers.get("content-range")).toBe("bytes 10-19/128");
  expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(10, 20));
  expect((await fetch(url, { headers: { range: "bytes=-10" } })).headers.get("content-range")).toBe("bytes 118-127/128");
  expect((await fetch(url, { headers: { range: "bytes=128-" } })).status).toBe(416);
  expect((await fetch(url, { headers: { range: "bytes=0-1,3-4" } })).status).toBe(416);
  const head = await fetch(`${url}?download=1`, { method: "HEAD" });
  expect(head.headers.get("content-disposition")).toContain("attachment"); expect(head.headers.get("content-length")).toBe("128");
  expect((await head.arrayBuffer()).byteLength).toBe(0);
});
it("serves library MP4 bytes with strict ranges and HEAD while retaining image GET", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-library-")); directories.push(dir);
  const bytes = Buffer.from(Array.from({ length: 128 }, (_, index) => index));
  fs.writeFileSync(path.join(dir, "clip.mp4"), bytes); fs.writeFileSync(path.join(dir, "image.jpg"), "image bytes");
  fs.writeFileSync(path.join(dir, "empty.mp4"), ""); fs.mkdirSync(path.join(dir, "directory.mp4"));
  fs.symlinkSync(path.join(dir, process.platform === "win32" ? "directory.mp4" : "clip.mp4"), path.join(dir, "link.mp4"), process.platform === "win32" ? "junction" : "file");
  const base = (await start({ mediaJobs: createMediaJobs(dir, {}) })).replace("/api/ask", "/api/media/assets/");
  const url = `${base}clip.mp4`, full = await fetch(url);
  expect(full.status).toBe(200); expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(full.headers.get("accept-ranges")).toBe("bytes"); expect(full.headers.get("content-length")).toBe("128");
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  for (const [range, start, end] of [["bytes=10-19", 10, 19], ["bytes=120-", 120, 127], ["bytes=-10", 118, 127], ["bytes=120-999", 120, 127], ["bytes=-999", 0, 127]] as const) {
    const response = await fetch(url, { headers: { range } });
    expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/128`);
    expect(response.headers.get("content-length")).toBe(String(end - start + 1));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=", "bytes=-", "bytes=-0", "bytes=128-", "bytes=20-10", "bytes=0-1,3-4", "bytes=a-b", "items=0-2", "bytes=0-9007199254740992", "bytes=-9007199254740992"]) {
    const response = await fetch(url, { headers: { range } });
    expect(response.status, range).toBe(416); expect(response.headers.get("content-range")).toBe("bytes */128");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  }
  for (const range of [undefined, "bytes=10-19", "bytes=128-"]) {
    const response = await fetch(url, { method: "HEAD", headers: range ? { range } : {} });
    expect(response.status).toBe(range === "bytes=128-" ? 416 : range ? 206 : 200);
    expect(response.headers.get("content-length")).toBe(range === "bytes=128-" ? "0" : range ? "10" : "128");
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  }
  const empty = await fetch(`${base}empty.mp4`); expect(empty.status).toBe(200); expect((await empty.arrayBuffer()).byteLength).toBe(0);
  expect((await fetch(`${base}empty.mp4`, { headers: { range: "bytes=0-" } })).status).toBe(416);
  const image = await fetch(`${base}image.jpg`); expect(image.headers.get("content-type")).toBe("image/jpeg"); expect(await image.text()).toBe("image bytes");
  for (const name of ["missing.mp4", "directory.mp4", "link.mp4"]) expect((await fetch(`${base}${name}`)).status).toBe(404);
});
it("returns the composed project for a finished job so the workbench can keep editing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-project-")); directories.push(dir);
  const file = path.join(dir, "idea-abc123.project.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, id: "idea-abc123", title: "Composed", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "One", narration: { text: "一镜", durationMs: 1000 } }] }));
  const base = (await start({ studioProject: (id: string) => id === "idea-abc123" ? file : path.join(dir, "missing.json") })).replace("/api/ask", "/api/make/idea-abc123/project");
  const response = await fetch(base);
  expect(response.status).toBe(200);
  expect((await response.json()).project).toMatchObject({ id: "idea-abc123", title: "Composed" });
  expect((await fetch(base.replace("idea-abc123", "idea-missing1"))).status).toBe(404);
  expect((await fetch(base, { method: "POST" })).status).toBe(405);
});it("lists installed local skills with descriptions", async () => {
  const url = (await start({})).replace("/api/ask", "/api/skills");
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body.skills)).toBe(true);
  expect(body.skills.some((skill: { id: string; description: string }) => skill.id === "glint-video" && skill.description.length > 10)).toBe(true);
});
it("includes junctioned or symlinked skills and reports their registry source", async () => {
  const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "skills");
  const linked = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isSymbolicLink()).map(entry => entry.name);
  if (linked.length === 0) return;
  const body = await (await fetch((await start({})).replace("/api/ask", "/api/skills"))).json();
  const ids = body.skills.map((skill: { id: string }) => skill.id);
  expect(ids).toEqual(expect.arrayContaining(linked));
  expect(body.skills.filter((skill: { source: string }) => skill.source !== "local").length).toBeGreaterThan(0);
});
it("rejects unsupported project export formats before rendering", async () => {
  const url = (await start({})).replace("/api/ask", "/api/project/export");
  const project = { schemaVersion: 1, id: "export-check", title: "Export", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "一", narration: { text: "一", durationMs: 1000 } }] };
  expect((await post(url, { project, format: "mp4" })).status).toBe(400);
});
it("renders server-side SVG thumbnails for structured scenes and skips media scenes", async () => {
  const url = (await start({})).replace("/api/ask", "/api/project/thumbnails");
  const project = { schemaVersion: 1, id: "thumbs", title: "Thumbs", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "第一镜", narration: { text: "第一句", durationMs: 1200 } },
    { id: "pic", kind: "image", src: "assets/photo.png", narration: { text: "图", durationMs: 1000 } },
  ] };
  const response = await post(url, { project });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.thumbnails.one.startsWith("data:image/svg+xml;base64,")).toBe(true);
  expect(body.thumbnails.pic).toBeUndefined();
  expect((await post(url, { project: {} })).status).toBe(400);
});it("builds an SRT from the posted project and rejects invalid storyboards", async () => {
  const url = (await start({})).replace("/api/ask", "/api/project/srt");
  const project = { schemaVersion: 1, id: "captions", title: "Captions", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "第一镜", narration: { text: "第一句字幕", durationMs: 1200 } },
    { id: "two", kind: "title", title: "第二镜", narration: { text: "第二句字幕", durationMs: 800 } },
  ] };
  const response = await post(url, { project });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.name).toBe("captions.srt");
  expect(body.srt).toContain("00:00:00,000 --> 00:00:01,200");
  expect(body.srt).toContain("第一句字幕");
  expect(body.srt).toContain("第二句字幕");
  expect((await post(url, { project: { nope: true } })).status).toBe(400);
});it("turns a library reference video into an editable project through the injected builder", async () => {
  const url = (await start({ referenceBuilder: async ({ name }: { name: string }) => {
    if (!/\.mp4$/.test(name)) throw Object.assign(new Error("Choose an MP4 from the media library"), { status: 400 });
    return { project: { schemaVersion: 1, id: "reference-1", title: "参考重建（推断）", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "ref-shot-001", kind: "image", src: "assets/ref-1-001.jpg", narration: { text: "参考镜头 1", durationMs: 1000 } }] }, shots: 1, inferred: true, limits: { scope: "cuts-thumbnails-and-motion" } };
  } })).replace("/api/ask", "/api/reference/build");
  const response = await post(url, { name: "clip.mp4" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.inferred).toBe(true); expect(body.shots).toBe(1);
  expect(body.project.scenes[0].src).toBe("assets/ref-1-001.jpg");
  expect((await post(url, { name: "voice.mp3" })).status).toBe(400);
});it("streams a reference upload into the media library and caps the size", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-upload-")); directories.push(dir);
  const jobs = createMediaJobs(dir, {});
  const url = (await start({ mediaJobs: jobs })).replace("/api/ask", "/api/reference/upload");
  const response = await fetch(url, { method: "POST", body: Buffer.from("fake mp4 bytes") });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.name).toMatch(/^upload-[a-f0-9]{12}\.mp4$/);
  expect(fs.readFileSync(path.join(dir, body.name), "utf8")).toBe("fake mp4 bytes");
  expect((await fetch(url, { method: "POST", body: Buffer.alloc(0) })).status).toBe(400);
});it("reads, saves and clears media gateway settings without returning the key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-media-settings-")); directories.push(dir);
  const jobs = createMediaJobs(dir, {});
  const applyEnv = vi.spyOn(jobs, "applyEnv");
  let state = { configured: false, baseUrl: "", keyHint: "", source: "none" };
  const settings = {
    read: () => state,
    save: (value: { baseUrl: string; apiKey: string }) => { state = { configured: true, baseUrl: value.baseUrl, keyHint: `…${value.apiKey.slice(-4)}`, source: "saved" }; return state; },
    clear: () => { state = { configured: false, baseUrl: "", keyHint: "", source: "none" }; return state; },
    env: () => ({ baseUrl: "https://media.example.com", apiKey: "sk-test-local", protocol: "skills" }),
  };
  const base = (await start({ mediaJobs: jobs, mediaSettings: settings })).replace("/api/ask", "/api/settings/media");
  const initial = await (await fetch(base)).json();
  expect(initial).toEqual({ configured: false, baseUrl: "", keyHint: "", source: "none" });
  const saved = await (await post(base, { baseUrl: "https://media.example.com", apiKey: "sk-test-local" })).json();
  expect(saved.configured).toBe(true); expect(saved.keyHint).toBe("…ocal");
  expect(applyEnv).toHaveBeenCalledWith({ GLINT_MEDIA_BASE_URL: "https://media.example.com", GLINT_MEDIA_API_KEY: "sk-test-local", GLINT_MEDIA_PROTOCOL: "skills" });
  expect(JSON.stringify(saved)).not.toContain("sk-test-local");
  expect((await fetch(base, { method: "DELETE" })).status).toBe(200);
  expect(applyEnv).toHaveBeenLastCalledWith({ GLINT_MEDIA_BASE_URL: process.env.GLINT_MEDIA_BASE_URL, GLINT_MEDIA_API_KEY: process.env.GLINT_MEDIA_API_KEY, GLINT_MEDIA_PROTOCOL: process.env.GLINT_MEDIA_PROTOCOL ?? "skills" });
});it("serves authored checks without answer keys and persists graded aggregates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-http-checks-")); directories.push(dir);
  const base = (await start({ checkStore: createCheckStore(dir) })).replace("/api/ask", "/api/checks/entropy");
  const response = await fetch(base), questions = await response.json();
  expect(questions[0].answer).toBeUndefined();
  const result = await (await post(base, { attemptId: "http-test-1234", answers: [{ id: "isolated", choice: 1 }, { id: "life", choice: 1 }] })).json();
  expect(result.correct).toBe(2);
  expect((await (await fetch(`${base}/stats`)).json()).attempts).toBe(1);
  expect((await post(base, {})).status).toBe(400);
});
it("serves a validated persona catalog and download-only JSON packs", async()=>{
 const url=(await start({})).replace('/api/ask','/api/personas');
 const response=await fetch(url),catalog=await response.json();expect(catalog.entries).toHaveLength(3);
 const pack=await fetch(`${url}/technical-review`);expect(pack.headers.get('content-disposition')).toContain('technical-review.json');
 expect((await pack.json()).personas).toHaveLength(2);
 expect((await fetch(`${url}/missing`)).status).toBe(404);
});
it("recovers an accepted request id over HTTP without another POST",async()=>{
 const job={id:'idea-recovered',status:'done',log:[]};
 const url=(await start({makeRunner:{findRequest:(id:string)=>id==='request-1234'?job:null}})).replace('/api/ask','/api/make/request/');
 expect((await (await fetch(url+'request-1234')).json()).id).toBe(job.id);
 expect((await fetch(url+'request-missing')).status).toBe(404);
});
import { brotliCompressSync, gzipSync } from "node:zlib";
it("composes editable scenes and returns evidence review over HTTP", async () => {
  const base = (await start({})).replace("/api/ask", "");
  const response = await post(`${base}/api/compose`, { source: "# 编辑项目\n\n## 依据\n系统不自动编造数据。", template: "explainer" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.project.scenes.length).toBeGreaterThan(1);
  expect(body.review.sentences.length).toBeGreaterThan(0);
  body.project.scenes[1].narration.text = "系统自动编造 999 条数据。";
  const reviewed = await (await post(`${base}/api/review`, { source: body.source, project: body.project })).json();
  expect(reviewed.flagged).toBeGreaterThan(0);
  expect((await post(`${base}/api/compose`, { source: "x", idea: "y" })).status).toBe(400);
  expect((await post(`${base}/api/compose`, { source: "# T\n\nNo methods", template: "paper" })).status).toBe(400);
});
it("shares a versioned project session between product and Skill callers", async () => {
  const base = (await start({})).replace("/api/ask", "");
  const project = { schemaVersion: 1, id: "session-demo", title: "旧标题", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "scene-1", kind: "title", title: "原始", narration: { text: "旁白" } }] };
  const transaction = { id: "skill-edit-1", projectId: "session-demo", baseRevision: 0, actor: "skill", scope: {}, operations: [{ kind: "set", path: ["title"], value: "新标题" }], intent: "修改标题" };
  expect((await post(`${base}/api/session/open`, { projectId: project.id, project })).status).toBe(200);
  const applied = await post(`${base}/api/session/apply`, { projectId: "session-demo", transaction });
  expect(applied.status).toBe(200);
  const appliedBody = await applied.json();
  expect(appliedBody.receipt.stage).toBe("verified");
  expect(appliedBody.project.title).toBe("新标题");
  const inspected = await (await post(`${base}/api/session/inspect`, { projectId: "session-demo", path: ["title"] })).json();
  expect(inspected.value).toBe("新标题");
  const looked = await (await fetch(`${base}/api/session/look?projectId=session-demo`)).json();
  expect(looked.revision).toBe(1);
  const stale = await post(`${base}/api/session/apply`, { projectId: "session-demo", transaction: { ...transaction, id: "skill-edit-stale", operations: [{ kind: "set", path: ["title"], value: "覆盖" }] } });
  expect(stale.status).toBe(409);
  expect((await stale.json()).receipt.stage).toBe("refused");
});
it("serves byte-identical precompressed static files, HEAD, ETags and revalidation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-static-")); directories.push(dir);
  const bytes = Buffer.from("export const value = '" + "test".repeat(1000) + "';");
  const name = "entry-abcdefgh.js";
  fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(path.join(dir, `${name}.br`), brotliCompressSync(bytes));
  fs.writeFileSync(path.join(dir, `${name}.gz`), gzipSync(bytes));
  const base = (await start({ distDir: dir })).replace("/api/ask", "");
  const response = await fetch(`${base}/${name}`, { headers: { "accept-encoding": "br" } });
  expect(response.headers.get("content-encoding")).toBe("br");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect((await fetch(`${base}/${name}`, { headers: { "accept-encoding": "br", "if-none-match": response.headers.get("etag")! } })).status).toBe(304);
  const head = await fetch(`${base}/${name}`, { method: "HEAD", headers: { "accept-encoding": "gzip;q=0, br;q=0" } });
  expect(head.headers.get("content-encoding")).toBeNull();
  expect(Number(head.headers.get("content-length"))).toBe(bytes.length);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
});
it("exposes health capabilities without credentials or local paths", async () => {
  const url = (await start({})).replace("/api/ask", "/api/health");
  const value = await (await fetch(url)).json();
  expect(value.status).toBe("ok"); expect(value.voices).toContain("mock");
  expect(JSON.stringify(value)).not.toMatch(/apiKey|referenceAudio|modelDir/);
});
it("rejects unavailable, silent and oversized voice previews before synthesis", async () => {
  const url = (await start({})).replace("/api/ask", "/api/voice-preview");
  for (const input of [{ engine: "mock", text: "Test" }, { engine: "unknown", text: "Test" }, { engine: "edge", text: "a".repeat(301) }, { engine: "edge", text: "Test", speakingRate: 3 }]) {
    expect((await post(url, input)).status).toBe(400);
  }
  expect((await fetch(url, { method: "POST", headers: { origin: "https://other.test" }, body: JSON.stringify({ engine: "edge", text: "Test" }) })).status).toBe(403);
});
it("validates NLE format and returns the generated edit list with its master", async () => {
  const seen: string[] = [];
  const url = (await start({ nleExporter: async ({ format }: { format: string }) => { seen.push(format); return { id: "aabbccddeeff0011", file: `aabbccddeeff0011.${format}`, bytes: 512, cuts: 2, url: `/api/project/export/aabbccddeeff0011/aabbccddeeff0011.${format}`, master: { file: "aabbccddeeff0011.mp4", bytes: 2048, url: "/api/project/export/aabbccddeeff0011/aabbccddeeff0011.mp4" } }; } })).replace("/api/ask", "/api/project/nle");
  const project = { schemaVersion: 1, id: "nle-http", title: "NLE", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "一", narration: { text: "一", durationMs: 1000 } }] };
  const response = await post(url, { project, format: "fcpxml" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ cuts: 2, master: { bytes: 2048 } });
  expect(seen).toEqual(["fcpxml"]);
  expect((await post(url, { project, format: "aaf" })).status).toBe(400);
  expect((await post(url, { project: {}, format: "fcpxml" })).status).toBe(400);
});
it("validates NLE projects and returns the rendered MP4", async () => {
  const seen: string[] = [];
  const url = (await start({ nleVideoRenderer: async ({ project }: { project: { id: string } }) => { seen.push(project.id); return { id: "aabbccddeeff0011", file: "aabbccddeeff0011.mp4", bytes: 4096, url: "/api/project/export/aabbccddeeff0011/aabbccddeeff0011.mp4" }; } })).replace("/api/ask", "/api/nle/render");
  const project = { schemaVersion: 1, id: "nle-http", title: "NLE", fps: 30, width: 1280, height: 720, tracks: [{ id: "v1", kind: "text", name: "文字", clips: [{ id: "t", kind: "text", text: "hi", startMs: 0, durationMs: 1000 }] }] };
  const response = await post(url, { project });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ bytes: 4096, file: "aabbccddeeff0011.mp4" });
  expect(seen).toEqual(["nle-http"]);
  expect((await post(url, { project: { ...project, tracks: [{ ...project.tracks[0], clips: [{ ...project.tracks[0]!.clips[0], kind: "audio" }] }] } })).status).toBe(400);
});
