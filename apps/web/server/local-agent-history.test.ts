import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
// @ts-expect-error server module
import { createLocalAgentHost } from "./local-agent-host.mjs";
// @ts-expect-error server module
import { createLocalAgentStore, createConversation, appendEvent, pollEvents } from "./local-agent-store.mjs";

const fixture = fileURLToPath(new URL("./local-agent-fixture.mjs", import.meta.url));
const snapshot = { schemaVersion: 1, id: "demo", title: "历史工程", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "title", kind: "title", title: "Title", narration: { text: "Hello" } }] };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function directory() { const dir = await mkdtemp(path.join(os.tmpdir(), "agent-history-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir; }
function hostAt(dataDir: string) {
  const host = createLocalAgentHost({ dataDir, adapters: { codex: { command: process.execPath, args: [fixture] } } });
  cleanup.push(() => host.dispose()); return host;
}
async function connect(host: any, extra = {}) {
  const result = await host.request({ action: "connect", agentId: "codex", projectId: snapshot.id, kind: "scene", snapshot, ...extra });
  expect(result).toMatchObject({ ok: true }); return result.conversationId;
}
async function turn(host: any, id: string, text: string) {
  expect(await host.request({ action: "prompt", conversationId: id, text, snapshot })).toMatchObject({ ok: true });
  const end = Date.now() + 4000;
  while (Date.now() < end) { const result = await host.request({ action: "events", conversationId: id }); if (result.state === "idle") return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("fixture turn timed out");
}
async function allHistory(host: any, id: string, limit = 37) {
  const events: any[] = []; let before;
  do {
    const result: any = await host.request({ action: "history", conversationId: id, before, limit });
    expect(result).toMatchObject({ ok: true }); expect(result.events.length).toBeLessThanOrEqual(limit);
    events.unshift(...result.events); before = result.nextBefore;
    if (!result.hasMore) return { events, incomplete: result.incomplete };
    expect(typeof before).toBe("string");
  } while (true);
}
it("journals streaming chunks beyond the poll window; restart/pagination retain old text without replaying prompts", async () => {
  const dataDir = await directory(), host = hostAt(dataDir);
  await host.request({ action: "configure", agentId: "codex", enabled: true }); const id = await connect(host);
  const recent = await turn(host, id, "flood"); expect(recent.truncated).toBe(true);
  expect(recent.events.some((event: any) => event.type === "turn-started")).toBe(false);
  const history = await allHistory(host, id);
  expect(history.incomplete).toBe(false); expect(history.events.find(event => event.type === "turn-started").text).toBe("flood");
  const text = history.events.filter(event => event.update?.sessionUpdate === "agent_message_chunk").map(event => event.update.content.text);
  expect(text).toEqual(["正在生成提案", ...Array.from({ length: 300 }, (_, index) => String(index))]);
  expect(new Set(history.events.map(event => event.sequence)).size).toBe(history.events.length);
  const firstPage = await host.request({ action: "history", conversationId: id, limit: 10 });
  await host.dispose();
  const restored = hostAt(dataDir), oldHistory = await allHistory(restored, id);
  expect(oldHistory.events.slice(0, history.events.length)).toEqual(history.events);
  expect(await restored.request({ action: "history", conversationId: id, before: firstPage.nextBefore, limit: 10 })).toMatchObject({ ok: true });
  expect(await connect(restored, { conversationId: id })).toBe(id);
  const calls = (await readFile(path.join(dataDir, "agent-workspaces", id, "fixture-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(call => call.method === "session/prompt")).toHaveLength(1);
  expect(calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  const listed = (await restored.request({ action: "list" })).conversations.find((item: any) => item.conversationId === id);
  expect(listed).toMatchObject({ title: "flood", updatedAt: expect.any(Number), state: "idle" });
});
it("creates independent conversations for one project and explicitly selects the prior one without sending a prompt", async () => {
  const dataDir = await directory(), host = hostAt(dataDir);
  await host.request({ action: "configure", agentId: "codex", enabled: true });
  const first = await connect(host); await turn(host, first, "第一段对话");
  const second = await connect(host, { newConversation: true }); expect(second).not.toBe(first);
  await turn(host, second, "第二段对话");
  const listed = await host.request({ action: "list" });
  expect(listed.conversations.map((item: any) => item.title)).toEqual(["第一段对话", "第二段对话"]);
  await host.request({ action: "detach" }); expect(await connect(host, { conversationId: first })).toBe(first);
  expect((await allHistory(host, first)).events.filter(event => event.type === "turn-started").map(event => event.text)).toEqual(["第一段对话"]);
  expect((await allHistory(host, second)).events.filter(event => event.type === "turn-started").map(event => event.text)).toEqual(["第二段对话"]);
  for (const id of [first, second]) {
    const calls = await readFile(path.join(dataDir, "agent-workspaces", id, "fixture-calls.jsonl"), "utf8");
    expect(calls.match(/"method":"session\/prompt"/g)).toHaveLength(1);
  }
  expect(await host.request({ action: "connect", agentId: "codex", projectId: "demo", kind: "scene", snapshot, newConversation: true, conversationId: first })).toMatchObject({ ok: false });
});
it("preserves complete large Unicode bodies while excluding thoughts, synthetic keys and raw tool data from disk", async () => {
  const dataDir = await directory(), store = createLocalAgentStore(dataDir); await store.ready;
  const record = createConversation(store, { agentId: "codex", projectId: "demo", kind: "scene", snapshot });
  const userText = "正常用户正文“中文”🌏\n".repeat(1000), assistantText = "完整回答🌏\n".repeat(10000);
  appendEvent(record, { type: "turn-started", turnId: "turn", text: userText });
  appendEvent(record, { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private-thought-sentinel" } } });
  appendEvent(record, { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed", rawInput: { api_key: "private-key-sentinel" }, content: [{ type: "text", text: "private-tool-sentinel" }] } });
  appendEvent(record, { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: assistantText } } });
  appendEvent(record, { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "api_key=synthetic-secret" } } });
  for (let index = 0; index < 300; index++) appendEvent(record, { type: "state", state: "idle" });
  await store.save(); await store.flush(); expect(pollEvents(record).truncated).toBe(true);
  const events: any[] = []; let before;
  do { const page: any = await store.history(record, before, 13); events.unshift(...page.events); before = page.nextBefore; } while (before);
  expect(events.find(event => event.type === "turn-started").text).toBe(userText);
  expect(events.find(event => event.update?.content?.text === assistantText)).toBeDefined();
  for (const file of [path.join(dataDir, "local-agent-state", "conversations.json"), path.join(dataDir, "local-agent-state", "history", `${record.id}.jsonl`)]) {
    const persisted = await readFile(file, "utf8"); expect(persisted).not.toMatch(/private-thought-sentinel|private-key-sentinel|private-tool-sentinel|synthetic-secret/);
  }
});
it("migrates surviving legacy messages honestly, validates pagination and repairs a torn journal tail", async () => {
  const dataDir = await directory(), id = randomUUID(), root = path.join(dataDir, "local-agent-state"); await mkdir(root);
  const record = { id, agentId: "codex", projectId: "demo", kind: "scene", choices: {}, sessionId: "legacy-session", lastSequence: 900, state: "running",
    events: [{ sequence: 899, at: 1000, type: "turn-started", text: "仅剩的旧聊天" }, { sequence: 900, at: 1001, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "旧回答" } } }] };
  await writeFile(path.join(root, "conversations.json"), JSON.stringify({ version: 1, preferences: {}, conversations: [record] }));
  const host = hostAt(dataDir), history = await allHistory(host, id); expect(history.incomplete).toBe(true);
  expect(history.events.map(event => event.sequence)).toEqual([899, 900]);
  expect((await host.request({ action: "list" })).conversations[0]).toMatchObject({ title: "仅剩的旧聊天", updatedAt: 1001, state: "disconnected" });
  for (const input of [{ limit: 0 }, { limit: 101 }, { before: "-1" }, { before: "1" }, { before: "900000000" }]) expect(await host.request({ action: "history", conversationId: id, ...input })).toMatchObject({ ok: false });
  await host.dispose();
  const journal = path.join(root, "history", `${id}.jsonl`); await writeFile(journal, '{"partial":', { flag: "a" });
  const restored = hostAt(dataDir), repaired = await allHistory(restored, id);
  expect(repaired.incomplete).toBe(true); expect(repaired.events.slice(0, 2)).toEqual(history.events);
});
