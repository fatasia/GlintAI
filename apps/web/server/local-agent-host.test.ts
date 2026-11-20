import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error server module
import { createLocalAgentHost } from "./local-agent-host.mjs";

const fixture = fileURLToPath(new URL("./local-agent-fixture.mjs", import.meta.url));
const scene = { schemaVersion: 1, id: "demo", title: "Demo", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "title", kind: "title", title: "Title", narration: { text: "Hello" } }] };
const nle = { schemaVersion: 1, id: "demo", title: "Demo", fps: 30, width: 1280, height: 720, tracks: [{ id: "text", kind: "text", name: "Text", locked: true, clips: [{ id: "clip", kind: "text", text: "Original", startMs: 0, durationMs: 1000 }] }] };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
async function setup(extra: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "glint-agent-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = createLocalAgentHost({ dataDir, adapters: { codex: { command: process.execPath, args: [fixture] } }, ...extra });
  cleanup.push(() => host.dispose());
  await host.request({ action: "configure", agentId: "codex", enabled: true });
  return { host, dataDir };
}
async function connect(host: any, snapshot = scene, kind = "scene") {
  const result = await host.request({ action: "connect", agentId: "codex", projectId: snapshot.id, kind, snapshot });
  expect(result).toMatchObject({ ok: true, state: "idle", info: { name: "offline-mock" } }); return result.conversationId;
}
async function waitFor(host: any, conversationId: string, predicate: (result: any) => boolean) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const result = await host.request({ action: "events", conversationId }); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("mock ACP result timed out");
}
it("runs real mock ACP process, returns a turn immediately, polls validated proposal and model config", async () => {
  const { host, dataDir } = await setup(); const id = await connect(host);
  expect(await host.request({ action: "status", agentId: "codex" })).toMatchObject({ status: "ready" });
  const start = Date.now(); const turn = await host.request({ action: "prompt", conversationId: id, text: "slow", snapshot: scene });
  expect(turn).toMatchObject({ ok: true, state: "running" }); expect(Date.now() - start).toBeLessThan(400);
  expect(await host.request({ action: "prompt", conversationId: id, text: "duplicate", snapshot: scene })).toMatchObject({ ok: false, error: { code: "busy-or-disconnected" } });
  const result = await waitFor(host, id, result => result.state === "idle");
  expect(result.events.find((event: any) => event.type === "proposal")).toMatchObject({ project: { id: "demo", title: "提案标题" }, baseDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const work = path.join(dataDir, "agent-workspaces", id);
  expect(JSON.parse(await readFile(path.join(work, "project.json"), "utf8"))).toEqual(scene);
  expect((await host.request({ action: "events", conversationId: id, after: result.lastSequence })).events).toEqual([]);
  expect(await host.request({ action: "setConfig", conversationId: id, configId: "model", value: "large" })).toMatchObject({ ok: true, modelOptions: [{ currentValue: "large" }] });
  expect(await host.request({ action: "setConfig", conversationId: id, configId: "approval", value: true })).toMatchObject({ ok: false, error: { code: "unsafe-config" } });
});
it("turns permission into a request card, denies invalid/permanent options, and accepts explicit one-shot choice", async () => {
  const { host } = await setup(); const id = await connect(host);
  await host.request({ action: "prompt", conversationId: id, text: "permission", snapshot: scene });
  const polled = await waitFor(host, id, result => result.events.some((event: any) => event.type === "request"));
  const requestId = polled.events.find((event: any) => event.type === "request").requestId;
  for (const optionId of ["unknown", "always"]) expect(await host.request({ action: "answer", conversationId: id, requestId, optionId })).toMatchObject({ ok: false, error: { code: "invalid-option" } });
  expect(await host.request({ action: "answer", conversationId: id, requestId, optionId: "once" })).toMatchObject({ ok: true, answered: true });
  const final = await waitFor(host, id, result => result.state === "idle"); expect(final.events.some((event: any) => event.type === "proposal")).toBe(true);
  expect(await host.request({ action: "answer", conversationId: id, requestId, optionId: "once" })).toMatchObject({ ok: false, error: { code: "request-expired" } });
});
it("defaults unanswered permissions to deny and validates question answers", async () => {
  const { host } = await setup({ permissionTimeoutMs: 40 }); const id = await connect(host);
  await host.request({ action: "prompt", conversationId: id, text: "permission", snapshot: scene });
  const denied = await waitFor(host, id, result => result.state === "idle");
  expect(denied.events.some((event: any) => event.type === "request-expired")).toBe(true);
  expect(denied.events.some((event: any) => event.type === "proposal")).toBe(false);
  await host.request({ action: "prompt", conversationId: id, text: "question", snapshot: scene });
  const pending = await waitFor(host, id, result => result.events.some((event: any) => event.requestType === "question"));
  const requestId = pending.events.find((event: any) => event.requestType === "question").requestId;
  expect(await host.request({ action: "answer", conversationId: id, requestId, answers: { title: 3 } })).toMatchObject({ ok: false, error: { code: "invalid-answer" } });
  expect(await host.request({ action: "answer", conversationId: id, requestId, answers: { title: "你好" } })).toMatchObject({ ok: true });
  await waitFor(host, id, result => result.state === "idle");
});
it.each(["invalid", "wrong-id"])("rejects %s proposal, never emitting an applicable project", async text => {
  const { host } = await setup(); const id = await connect(host);
  await host.request({ action: "prompt", conversationId: id, text, snapshot: scene });
  const result = await waitFor(host, id, result => result.state === "error");
  expect(result.events.some((event: any) => event.type === "proposal")).toBe(false); expect(result.events.some((event: any) => event.type === "error")).toBe(true);
});
it("preserves NLE locked tracks and rejects an unlocking proposal", async () => {
  const { host } = await setup(); const id = await connect(host, nle as any, "nle");
  await host.request({ action: "prompt", conversationId: id, text: "normal", snapshot: nle });
  const good = await waitFor(host, id, result => result.state === "idle"); expect(good.events.find((event: any) => event.type === "proposal").project.tracks).toEqual(nle.tracks);
  await host.request({ action: "prompt", conversationId: id, text: "locked", snapshot: nle });
  const bad = await waitFor(host, id, result => result.state === "error"); expect(bad.events.at(-2)).toMatchObject({ type: "error", code: "locked-item" });
});
it("cancels pending requests, drops late proposal, and detach is resumable without replay", async () => {
  const { host, dataDir } = await setup(); const id = await connect(host);
  await host.request({ action: "prompt", conversationId: id, text: "slow", snapshot: scene });
  expect(await host.request({ action: "cancel", conversationId: id })).toMatchObject({ ok: true, state: "cancelled" });
  await new Promise(resolve => setTimeout(resolve, 600));
  expect((await host.request({ action: "events", conversationId: id })).events.some((event: any) => event.type === "proposal")).toBe(false);
  expect(await connect(host)).toBe(id);
  await host.request({ action: "prompt", conversationId: id, text: "permission", snapshot: scene });
  const pending = await waitFor(host, id, result => result.events.some((event: any) => event.type === "request"));
  const requestId = pending.events.find((event: any) => event.type === "request").requestId;
  expect(await host.request({ action: "detach" })).toMatchObject({ ok: true, detached: true });
  expect(await host.request({ action: "answer", conversationId: id, requestId, optionId: "once" })).toMatchObject({ ok: false });
  expect(await connect(host)).toBe(id);
  const calls = (await readFile(path.join(dataDir, "agent-workspaces", id, "fixture-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.filter(item => item.method === "session/new")).toHaveLength(1); expect(calls.filter(item => item.method === "session/resume")).toHaveLength(2);
  // The cancelled turn may or may not reach the fixture before cancellation lands; a replay would exceed two prompts.
  const prompts = calls.filter(item => item.method === "session/prompt"); expect(prompts.length).toBeGreaterThanOrEqual(1); expect(prompts.length).toBeLessThanOrEqual(2);
});
it("restores persisted conversation and model selection without an automatic prompt", async () => {
  const { host, dataDir } = await setup(); const id = await connect(host);
  await host.request({ action: "setConfig", conversationId: id, configId: "model", value: "large" }); await host.dispose();
  const restored = createLocalAgentHost({ dataDir, adapters: { codex: { command: process.execPath, args: [fixture] } } }); cleanup.push(() => restored.dispose());
  expect(await connect(restored)).toBe(id);
  expect(await restored.request({ action: "models", conversationId: id })).toMatchObject({ modelOptions: [{ currentValue: "large" }] });
  const calls = await readFile(path.join(dataDir, "agent-workspaces", id, "fixture-calls.jsonl"), "utf8");
  expect(calls).not.toContain('"method":"session/prompt"'); expect(calls).toContain('"method":"session/resume"');
});
it.each(["hang", "exit"])("handles %s failure with bounded timeout/exit feedback", async text => {
  const { host } = await setup({ turnTimeoutMs: 100 }); const id = await connect(host);
  await host.request({ action: "prompt", conversationId: id, text, snapshot: scene });
  const result = await waitFor(host, id, result => result.state === "error"); expect(result.events.some((event: any) => event.type === "error")).toBe(true);
});
it("bounds poll history and rejects delegated filesystem access", async () => {
  const { host } = await setup(); const id = await connect(host);
  await host.request({ action: "prompt", conversationId: id, text: "flood", snapshot: scene });
  const result = await waitFor(host, id, result => result.state === "idle"); expect(result.events.length).toBeLessThanOrEqual(256); expect(result.truncated).toBe(true);
  await host.request({ action: "prompt", conversationId: id, text: "filesystem", snapshot: scene });
  const denied = await waitFor(host, id, result => result.state === "idle"); expect(JSON.stringify(denied.events)).toContain('\\"denied\\":true');
});
it("detach revokes in-flight and queued connect before a delayed SDK load can leak a process", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sdkUrl = path.join(path.dirname(fixture), "..", "node_modules", "@agentclientprotocol", "sdk", "dist", "v1", "stable", "acp.js");
  const { host } = await setup({ sdkLoader: async () => { entered(); await gate; return import(/* @vite-ignore */ `file:///${sdkUrl.replace(/\\/g, "/")}`); } });
  const first = host.request({ action: "connect", agentId: "codex", projectId: "demo", kind: "scene", snapshot: scene });
  await started;
  const queued = host.request({ action: "connect", agentId: "codex", projectId: "demo", kind: "scene", snapshot: scene });
  await host.request({ action: "detach" }); release();
  expect(await first).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(await queued).toMatchObject({ ok: false, error: { code: "cancelled" } });
  const list = await host.request({ action: "list" }); expect(list.conversations.every((record: any) => record.state !== "idle")).toBe(true);
});
it("reports login-required without attempting auth and rejects untrusted actions/paths", async () => {
  const { host } = await setup();
  expect(await host.request({ action: "connect", agentId: "codex", projectId: "demo", kind: "scene", snapshot: { ...scene, title: "login" } })).toMatchObject({ ok: false, error: { code: "login-required" } });
  expect(await host.request({ action: "status", agentId: "codex" })).toMatchObject({ status: "login-required" });
  expect(await host.request({ action: "locate", agentId: "other", path: process.execPath })).toMatchObject({ ok: false, error: { code: "unknown-agent" } });
  expect(await host.request({ action: "locate", agentId: "codex", path: "relative.exe" })).toMatchObject({ ok: false, error: { code: "invalid-path" } });
  expect(await host.request({ action: "exec", command: "anything" })).toMatchObject({ ok: false });
  expect(await host.request({ action: "configure", agentId: "codex", enabled: false })).toMatchObject({ enabled: false });
  expect(await host.request({ action: "connect", agentId: "codex", projectId: "demo", kind: "scene", snapshot: scene })).toMatchObject({ ok: false, error: { code: "disabled" } });
});
