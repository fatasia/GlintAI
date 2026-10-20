import { afterEach, expect, it } from "vitest";
import type { Server } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error JavaScript server module, exercised over HTTP rather than duplicated.
import { createWebServer } from "./index.mjs";
import { consumeAnswerStream } from "../src/answer-stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCheckStore } from "./checks.mjs";
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
  const server = createWebServer(options) as Server;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ask`;
}
function post(url: string, body: unknown, signal?: AbortSignal) {
  return fetch(url, { method: "POST", body: JSON.stringify(body), signal });
}
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
it("serves authored checks without answer keys and persists graded aggregates", async () => {
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
