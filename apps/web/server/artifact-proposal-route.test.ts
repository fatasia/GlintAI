import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createWebServer } from "./index.mjs";

const roots: string[] = [], servers: Server[] = [];
const KEYS = ["GLINT_LLM_API_KEY", "GLINT_LLM_BASE_URL", "GLINT_LLM_MODEL", "GLINT_LLM_PROTOCOL"];
const previous = new Map<string, string | undefined>();
beforeEach(() => { for (const key of KEYS) previous.set(key, process.env[key]); });
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const key of KEYS) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const DOCUMENT = { id: "doc-artifact", title: "开场讲稿", kind: "script", content: "大家好，今天聊熵。", updatedAt: 1 };
const CHANGED = { ...DOCUMENT, content: "大家好，今天用三分钟聊熵。", updatedAt: 2 };

/** Starts the real HTTP server against a local OpenAI-compatible fixture, never a paid model. */
async function start({ configured = true, reply = () => ({ document: CHANGED, summary: "把开场白改得更直接。" }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-artifact-route-")); roots.push(root);
  const calls: Array<Record<string, unknown>> = [];
  const model = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    calls.push(JSON.parse(text));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply()) } }] }));
  });
  servers.push(model);
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  if (configured) {
    process.env.GLINT_LLM_API_KEY = "local-test-only";
    process.env.GLINT_LLM_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
    process.env.GLINT_LLM_MODEL = "fixture"; process.env.GLINT_LLM_PROTOCOL = "openai";
  } else delete process.env.GLINT_LLM_API_KEY;
  const server = createWebServer({ designExportDir: path.join(root, "exports"), distDir: path.join(root, "dist"),
    studioProject: (id: string) => path.join(root, "projects", `${id}.project.json`) });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/artifact/proposal`;
  return { url, root, calls };
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("returns the proposed document and summary without writing project files", async () => {
  const { url, root, calls } = await start();
  const response = await post(url, { projectId: "artifact-api", document: DOCUMENT, instruction: "把开场白改得更直接" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ document: CHANGED, summary: "把开场白改得更直接。" });
  expect(calls).toHaveLength(1);
  const system = (calls[0]!.messages as Array<{role:string;content:string}>).find(item=>item.role==="system")!.content;
  expect(system).toContain("API 返回 JSON");
  expect(system).not.toContain("输出完整原生 artifact 工程 envelope");
  const user = (calls[0]!.messages as Array<{ role: string; content: string }>).find(message => message.role === "user")!;
  expect(JSON.parse(user.content)).toMatchObject({ document: DOCUMENT, instruction: "把开场白改得更直接" });
  expect(fs.readdirSync(root)).toEqual([]);
});

it("rejects oversized bodies with 413 before calling the model", async () => {
  const { url, calls } = await start();
  const response = await post(url, { document: DOCUMENT, instruction: "x".repeat(2_200_000) });
  expect(response.status).toBe(413);
  expect(typeof (await response.json()).error).toBe("string");
  expect(calls).toHaveLength(0);
});

it("answers 503 when no text model is configured", async () => {
  const { url, calls } = await start({ configured: false });
  const response = await post(url, { document: DOCUMENT, instruction: "改写开场" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "请先配置文本模型，再生成文档提案。" });
  expect(calls).toHaveLength(0);
});

it("maps invalid instructions and documents to 400 without a provider call", async () => {
  const { url, calls } = await start();
  const blank = await post(url, { document: DOCUMENT, instruction: "   " });
  expect(blank.status).toBe(400);
  expect(await blank.json()).toEqual({ error: "请输入 1 到 32000 字的生成或修改要求。" });
  expect((await post(url, { document: DOCUMENT, instruction: "x".repeat(32_001) })).status).toBe(400);
  expect((await post(url, { document: { ...DOCUMENT, kind: "unknown" }, instruction: "改写开场" })).status).toBe(400);
  expect(calls).toHaveLength(0);
});

it("only accepts POST on the proposal path", async () => {
  const { url } = await start();
  expect((await fetch(url)).status).toBe(404);
});
