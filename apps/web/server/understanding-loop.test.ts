// OPS-10 教育来源问答试讲理解反馈 — 任务专项夹具（端到端，全部本地回环，零网关消费）。
// 链路：教育来源 → 问答(带引用/拒答) → 试讲(困惑定位+报告导出) → 定向重讲(HTTP 全链) → 导出一致性 → 持久化与异常恢复。
import { afterEach, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error JavaScript server module, exercised over real HTTP.
import { createWebServer } from "./index.mjs";
import { createCheckStore } from "./checks.mjs";
import { AnswerEngine, LexicalKnowledgeBase, loadMarkdown } from "@glintai/knowledge";
import { createLlmProvider } from "@glintai/llm";
import { defaultPersonas, rehearse } from "@glintai/listener";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { consumeAnswerStream } from "../src/answer-stream";

const EXAMPLE_DIR = fileURLToPath(new URL("../../../examples/entropy-lecture/", import.meta.url));

const servers: Server[] = [];
const directories: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GLINT_LLM_") && !(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function educationSource(): string {
  return fs.readFileSync(path.join(EXAMPLE_DIR, "source.md"), "utf8");
}
function educationProject(): SceneScriptProject {
  return parseProject(JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, "project.scenescript.json"), "utf8")));
}
function knowledgeBase(): LexicalKnowledgeBase {
  const kb = new LexicalKnowledgeBase();
  kb.addDocument(loadMarkdown(educationSource(), { docId: "entropy-lecture" }));
  return kb;
}
function openaiLike(base: string) {
  return createLlmProvider({ baseUrl: `${base}/v1`, apiKey: "local-test", model: "glint-loop-mock", protocol: "openai" });
}
async function startWeb(options: Record<string, unknown>): Promise<string> {
  const server = createWebServer(options) as Server;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function post(url: string, body: unknown, signal?: AbortSignal) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
}

interface ModelReplies {
  /** (question, callIndex) — 让拒答路径可复现。 */
  answer?: (question: string, call: number) => string;
  confusions?: unknown;
}
/** 本地回环 mock 模型：OpenAI 协议；按 system 提示分发到问答/试讲/重讲三种回复。 */
async function useLocalModel(replies: ModelReplies): Promise<string> {
  let qaCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let system = "", user = "", stream = false;
      try {
        const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }>; stream?: boolean };
        system = String(body.messages?.[0]?.content ?? "");
        user = String(body.messages?.[1]?.content ?? "");
        stream = body.stream === true;
      } catch { /* falls through to 500 */ }
      const payload = (): string | null => {
        if (system.includes("只依据给定资料回答问题")) return replies.answer ? replies.answer(user, qaCalls++) : "NOT_IN_SOURCE";
        if (system.includes("你正在「听」")) return JSON.stringify(replies.confusions ?? []);
        if (system.includes("重讲导演")) {
          const scene = extractScene(user);
          return scene ? JSON.stringify({ ...scene, narration: { text: "重讲后的旁白：把熵想象成一间房间越弄越乱的趋势。" } }) : null;
        }
        return null;
      };
      const text = payload();
      if (text === null) { res.writeHead(500); return res.end("{}"); }
      if (stream) {
        // 真实网关同款 SSE 增量：分两片发送并以 [DONE] 收尾。
        res.writeHead(200, { "content-type": "text/event-stream" });
        const half = Math.max(1, Math.ceil(text.length / 2));
        for (const piece of [text.slice(0, half), text.slice(half)]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [key, value] of Object.entries({ GLINT_LLM_API_KEY: "local-test", GLINT_LLM_BASE_URL: `${base}/v1`, GLINT_LLM_PROTOCOL: "openai" })) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  return base;
}
/** 从重讲请求的用户消息里取「待重写场景」的平衡 JSON。 */
function extractScene(userContent: string): Record<string, unknown> | null {
  const marker = userContent.indexOf("待重写场景:");
  const open = marker === -1 ? -1 : userContent.indexOf("{", marker);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < userContent.length; index++) {
    const char = userContent[index];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(userContent.slice(open, index + 1)) as Record<string, unknown>; } catch { return null; }
      }
    }
  }
  return null;
}

it("教育来源问答：真实入口返回带引用的落地回答，资料外问题落地为拒答", async () => {
  const model = await useLocalModel({
    answer: (question, call) => (call === 0 ? "熵衡量系统微观排列方式的数量，孤立系统的熵不会减少。" : "NOT_IN_SOURCE"),
  });
  const base = await startWeb({
    engineForProject: () => new AnswerEngine({ kb: knowledgeBase(), llm: openaiLike(model), topK: 4 }),
  });
  const answered = await consumeAnswerStream(await post(`${base}/api/ask`, { project: "entropy", question: "熵是什么？" }), new AbortController().signal);
  expect(answered.refused).toBe(false);
  expect(answered.answer).toContain("微观排列方式");
  expect(answered.citations.length).toBeGreaterThan(0);
  expect(answered.citations[0]?.docId).toBe("entropy-lecture");
  const declined = await consumeAnswerStream(await post(`${base}/api/ask`, { project: "entropy", question: "熵是什么？" }), new AbortController().signal);
  expect(declined.refused).toBe(true);
  expect(declined.refusalReason).toBe("model_declined");
  expect(declined.citations.length).toBeGreaterThan(0);
});

it("虚拟试讲：困惑定位到具体场景，报告可导出并完整回读", async () => {
  const base = await useLocalModel({ confusions: [{ sceneId: "second-law", confusion: "为什么必须是孤立系统？", suggestion: "补一个开放系统的反例" }] });
  const [report] = await rehearse(educationProject(), openaiLike(base), { personas: defaultPersonas("zh-CN").slice(0, 1), timeoutMs: 15_000 });
  expect(report?.persona.id).toBe("curious-student");
  expect(report?.confusions[0]?.sceneId).toBe("second-law");
  expect(report?.confusions[0]?.confusion).toBe("为什么必须是孤立系统？");
  // make 流水线同款导出：落盘 *.rehearsal.json → 读回无损。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ops10-rehearsal-")); directories.push(dir);
  const out = path.join(dir, "entropy-lecture.rehearsal.json");
  fs.writeFileSync(out, JSON.stringify([report], null, 2));
  const parsed = JSON.parse(fs.readFileSync(out, "utf8")) as Array<typeof report>;
  expect(parsed[0]?.confusions[0]).toEqual(report?.confusions[0]);
});

it("定向重讲：/api/edit-scene 只改目标场景，异常时原工程不变", async () => {
  await useLocalModel({});
  const base = await startWeb({});
  const original = educationProject();
  const response = await post(`${base}/api/edit-scene`, { project: original, sceneId: "what-is-entropy", instruction: "太抽象，用房间凌乱类比" });
  expect(response.status).toBe(200);
  const { project } = (await response.json()) as { project: SceneScriptProject };
  const target = project.scenes.find((scene) => scene.id === "what-is-entropy");
  expect(target?.kind).toBe("definition");
  expect(target?.narration.text).toContain("房间");
  expect(target?.narration.audioRef).toBeUndefined();
  expect(target?.narration.durationMs).toBeUndefined();
  expect(project.scenes.filter((scene) => scene.id !== "what-is-entropy")).toEqual(original.scenes.filter((scene) => scene.id !== "what-is-entropy"));
  expect(() => parseProject(project)).not.toThrow();
  // 异常恢复：目标不存在 → 400，服务继续可用，原工程未被改写。
  expect((await post(`${base}/api/edit-scene`, { project: original, sceneId: "no-such-scene", instruction: "改一下" })).status).toBe(400);
  const after = await post(`${base}/api/edit-scene`, { project: original, sceneId: "what-is-entropy", instruction: "再讲一遍" });
  expect(after.status).toBe(200);
});

it("导出一致性：重讲后的旁白进入 SRT 导出物", async () => {
  await useLocalModel({});
  const base = await startWeb({});
  const edited = (await (await post(`${base}/api/edit-scene`, { project: educationProject(), sceneId: "what-is-entropy", instruction: "用房间类比" })).json()) as { project: SceneScriptProject };
  const srt = (await (await post(`${base}/api/project/srt`, { project: edited.project })).json()) as { name: string; srt: string };
  expect(srt.name).toBe("entropy-lecture.srt");
  expect(srt.srt).toContain("把熵想象成一间房间越弄越乱的趋势");
  // 重讲前的旧旁白不再出现在导出物里。
  expect(srt.srt).not.toContain(educationProject().scenes[1]?.narration.text.slice(0, 12) ?? "");
});

it("理解反馈持久化与异常恢复：幂等重试、重启保留、坏行容忍", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-ops10-checks-")); directories.push(dir);
  const base = await startWeb({ checkStore: createCheckStore(dir) });
  const questions = (await (await fetch(`${base}/api/checks/entropy`)).json()) as Array<{ id: string }>;
  expect(questions.map((question) => question.id)).toEqual(["isolated", "life"]);
  const submit = (attemptId: string) => post(`${base}/api/checks/entropy`, { attemptId, answers: [{ id: "isolated", choice: 1 }, { id: "life", choice: 1 }] });
  const first = await (await submit("ops10-attempt-001")).json();
  expect(first.correct).toBe(2);
  // 响应丢失后重试同一次作答：结果一致且不重复计数。
  expect(await (await submit("ops10-attempt-001")).json()).toEqual(first);
  expect(((await (await fetch(`${base}/api/checks/entropy/stats`)).json()) as { attempts: number }).attempts).toBe(1);
  // 重启（同目录新 store）：作答记录保留。
  expect(createCheckStore(dir).stats("entropy")?.attempts).toBe(1);
  // 坏行容忍：混入损坏行不丢已有记录。
  fs.appendFileSync(path.join(dir, "checks.jsonl"), "corrupted-line\n");
  expect(createCheckStore(dir).stats("entropy")?.attempts).toBe(1);
  // 非法提交 400，不落盘。
  expect((await post(`${base}/api/checks/entropy`, {})).status).toBe(400);
  expect(createCheckStore(dir).stats("entropy")?.attempts).toBe(1);
});
