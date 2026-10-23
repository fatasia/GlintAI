import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { FileSessionStore } from "@glintai/session/node";
// @ts-expect-error JavaScript server exercised through real HTTP.
import { createWebServer } from "./index.mjs";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
// Opt-in: real compose + real draft render + composed-project readback.
it.skipIf(process.env.GLINT_QUICK_VIDEO_E2E !== "1")("one pasted passage becomes a finished draft video and an editable project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-quick-e2e-"));
  const sessions = new FileSessionStore(path.join(root, "sessions"), document => { parseProject(document); });
  const server = createWebServer({ distDir: dist, sessionStore: sessions }) as Server;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const source = "第一节：问题从哪里来。很多团队不是缺工具，而是缺一个能落地的流程。第二节：具体做法。先写一句话目标，再拆成三个可执行步骤，最后用真实数据验收。";
    const submitted = await (await fetch(`${base}/api/make`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, tts: "mock", music: "off", encoding: "draft", aspect: "16:9" }) })).json();
    expect(submitted.jobId).toMatch(/^idea-/);
    let job = { status: "queued" };
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      job = await (await fetch(`${base}/api/make/${submitted.jobId}`)).json();
      if (["done", "failed", "cancelled"].includes(job.status)) break;
    }
    expect(job.status, JSON.stringify(job).slice(0, 400)).toBe("done");
    const video = await fetch(`${base}/api/video/${submitted.jobId}`);
    expect(video.status).toBe(200);
    expect(Number(video.headers.get("content-length"))).toBeGreaterThan(10_000);
    const project = await (await fetch(`${base}/api/make/${submitted.jobId}/project`)).json();
    expect(project.project.scenes.length).toBeGreaterThan(0);
    expect(parseProject(project.project).id).toBe(submitted.jobId);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 320_000);
