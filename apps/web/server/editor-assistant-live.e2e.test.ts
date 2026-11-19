import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
// @ts-expect-error JavaScript server exercised through real HTTP.
import { createWebServer } from "./index.mjs";

it.skipIf(process.env.GLINT_TEXT_LIVE_E2E !== "1")("requests exactly one live model edit against an isolated latest project", async () => {
  const receipt = process.env.GLINT_TEXT_LIVE_RECEIPT;
  if (!receipt || !path.isAbsolute(receipt) || !process.env.GLINT_LLM_API_KEY || !process.env.GLINT_LLM_BASE_URL || !process.env.GLINT_LLM_MODEL) throw new Error("Live test requires explicit configuration and an absolute new receipt path");
  // Reserve before sending: an interrupted or uncertain call must not be repeated.
  fs.writeFileSync(receipt, JSON.stringify({ state: "reserved", at: new Date().toISOString() }), { flag: "wx" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-live-edit-"));
  const server = createWebServer({ requestLogDir: path.join(root, "logs") }) as Server;
  const project = { schemaVersion: 1, id: "live-edit-test", title: "讲解演示", aspect: "16:9", knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "如何给盆栽浇水", narration: { text: "浇水前先检查盆土，干燥时再浇。", durationMs: 2400 } },
    { id: "two", kind: "title", title: "结尾", narration: { text: "结束。", durationMs: 1000 } },
  ] };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/edit-scene`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(75_000),
      body: JSON.stringify({ project, sceneId: "one", instruction: "请将标题精简，但保持原有主题；其他镜头不要修改。" }),
    });
    const body = await response.json();
    const result = { state: response.ok ? "completed" : "http_error", status: response.status, elapsedMs: Date.now() - started,
      title: response.ok ? body.project?.scenes?.[0]?.title : undefined };
    fs.writeFileSync(receipt, JSON.stringify(result, null, 2));
    expect(response.status).toBe(200);
    expect(typeof body.project.scenes[0].title).toBe("string");
    expect(body.project.scenes[0].id).toBe("one");
    expect(body.project.scenes[1]).toEqual(project.scenes[1]);
    expect(body.project.title).toBe(project.title);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90000);
