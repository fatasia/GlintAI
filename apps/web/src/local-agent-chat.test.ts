// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { parseProject, parseNleProject, type SceneScriptProject } from "@glintai/scenescript";
import { LocalAgentChat } from "./LocalAgentChat";
import { mergeEvents, projectEvents, type AgentEvent, type ChatContext, type ChatKind } from "./local-agent-chat-model";
import { captureProject, makeChatProposal, projectDigest, validateChatProposal } from "./local-agent-chat-proposal";
import { parseArtifactProject, type ArtifactProject, type ArtifactSelection } from "./artifact-project";
import * as chatProposal from "./local-agent-chat-proposal";
import { EditorAssistant } from "./EditorAssistant";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseProject({ schemaVersion: 1, id: "local-chat", title: "测试工程", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "原标题", narration: { text: "一句旁白", durationMs: 1000 } },
  { id: "two", kind: "title", title: "第二镜", narration: { text: "继续", durationMs: 1000 } },
] });
const modelOptions = [{ id: "model", name: "Model", category: "model", currentValue: "small", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] }];
let root: Root | undefined, container: HTMLDivElement, serial = 0;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const deferred = () => { let resolve!: (value: unknown) => void; return { promise: new Promise(yes => { resolve = yes; }), resolve }; };
function fixture(known = false, kind: ChatKind = "scene", projectId = project.id) {
  const id = `conversation-${++serial}`;
  let state = known ? "disconnected" : "idle", sequence = 0, turn = 0;
  const events: AgentEvent[] = [];
  const add = (event: Omit<AgentEvent, "sequence">) => events.push({ ...event, sequence: ++sequence });
  const request = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => {
    if (input.action === "list") return { agents: [{ id: "codex", name: "Codex", installed: true, enabled: true, status: "installed" }], conversations: known ? [{ conversationId: id, agentId: "codex", projectId, kind, state, lastSequence: sequence }] : [] };
    if (input.action === "connect") { state = "idle"; add({ type: "connected", modelOptions }); return { conversationId: id, state, modelOptions }; }
    if (input.action === "events") return { events: events.filter(event => event.sequence > Number(input.after)), lastSequence: sequence, state };
    if (input.action === "history") return { events, nextBefore: null, hasMore: false, incomplete: false, state };
    if (input.action === "prompt") { const turnId = `turn-${++turn}`; state = "running"; add({ type: "turn-started", turnId, text: String(input.text) }); return { turnId, state }; }
    if (input.action === "cancel" || input.action === "disconnect") { state = input.action === "cancel" ? "cancelled" : "disconnected"; add({ type: "state", state }); return { state, treeStopped: true }; }
    if (input.action === "answer") { add({ type: "request-answered", requestId: String(input.requestId) }); return { answered: true }; }
    if (input.action === "setConfig") return { modelOptions: [{ ...modelOptions[0], currentValue: input.value }] };
    return {};
  });
  Object.assign(window, { glintDesktop: { request } });
  return { id, request, add, events, state: (next: string) => { state = next; } };
}
async function mount(value = project, component: typeof LocalAgentChat | typeof EditorAssistant = LocalAgentChat) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const changes: unknown[] = [], onApply = vi.fn((next: unknown) => { changes.push(next); });
  const render = async (next = value) => { await act(async () => root!.render(component === LocalAgentChat ? createElement(LocalAgentChat, { project: next, kind: "scene", context: { sceneId: "one" }, onApply }) : createElement(EditorAssistant, { project: next, sceneId: "one", onChange: onApply }))); };
  await render();
  return { render, changes, onApply };
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };
const tick = async () => { await act(async () => vi.advanceTimersByTimeAsync(500)); };
async function input(text: string, selector = "textarea") {
  await act(async () => { const element = container.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(value: string, selector: string) {
  await act(async () => { const element = container.querySelector<HTMLSelectElement>(selector)!; element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
const edited = () => { const next = captureProject(project) as SceneScriptProject; (next.scenes[0] as { title: string }).title = "更短的标题"; return next; };

describe("local agent interactive chat", () => {
  it("streams journal text incrementally, deduplicates prompts and applies only after a readable preview, once", async () => {
    const host = fixture(), h = await mount(); await click("开始对话"); await input("让第一镜更简洁");
    await act(async () => { container.querySelector("form.lac-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); container.querySelector("form.lac-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(host.request.mock.calls.filter(([call]) => call.action === "prompt")).toHaveLength(1);
    expect(container.textContent).toContain("让第一镜更简洁"); expect(h.changes).toHaveLength(0);
    host.add({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我会先" } } }); await tick();
    expect(container.textContent).toContain("我会先");
    host.add({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "缩短标题。" } } });
    host.add({ type: "proposal", turnId: "turn-1", project: edited(), baseDigest: await projectDigest(project) });
    host.add({ type: "turn-ended", turnId: "turn-1" }); host.state("idle"); await tick();
    expect(container.textContent).toContain("我会先缩短标题。"); expect(h.changes).toHaveLength(0);
    await click("查看修改差异"); expect(container.textContent).toContain("镜头 1 · 标题"); expect(container.textContent).toContain("原来：原标题");
    await act(async () => { button("确认应用修改").click(); button("确认应用修改")?.click(); });
    expect(h.changes).toHaveLength(1); expect(container.textContent).toContain("可用编辑器撤销");
    const prompt = host.request.mock.calls.find(([call]) => call.action === "prompt")![0];
    expect(prompt.snapshot).toEqual(project); expect(prompt.context).toEqual({ sceneId: "one" });
    expect(host.request.mock.calls.filter(([call]) => call.action === "events").map(([call]) => call.after)).toEqual(expect.arrayContaining([0, 1, 3]));
  });
  it("pins the send snapshot and refuses a proposal after a local edit", async () => {
    const host = fixture(), h = await mount(); await click("开始对话"); await input("修改"); await click("发送 ↑");
    await h.render({ ...project, title: "本地新版本" });
    host.add({ type: "proposal", turnId: "turn-1", project: edited() }); host.add({ type: "turn-ended" }); host.state("idle"); await tick();
    await click("查看修改差异"); expect(button("确认应用修改").disabled).toBe(true); expect(container.textContent).toContain("已过期"); expect(h.changes).toHaveLength(0);
  });
  it("answers permission and typed questions in place without permanent approval", async () => {
    const host = fixture(); await mount(); await click("开始对话"); await input("开始"); await click("发送 ↑");
    host.add({ type: "request", requestId: "permission", requestType: "permission", toolCall: { toolCallId: "write", title: "写入提案" }, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Allow always", kind: "allow_always" }] }); await tick();
    expect(container.textContent).not.toContain("Allow always"); await click("允许这一次");
    expect(host.request).toHaveBeenCalledWith({ action: "answer", conversationId: host.id, requestId: "permission", optionId: "once" });
    host.add({ type: "request", requestId: "question", requestType: "question", message: "想要什么标题？", requestedSchema: { required: ["title", "count"], properties: { title: { type: "string", title: "标题", minLength: 1 }, count: { type: "integer", title: "数量", minimum: 1 } } } }); await tick();
    await input("新标题", '.lac-request input[type="text"]'); await input("2", '.lac-request input[type="number"]');
    await act(async () => container.querySelector(".lac-request form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.request).toHaveBeenCalledWith({ action: "answer", conversationId: host.id, requestId: "question", answers: { title: "新标题", count: 2 } }); expect(container.textContent).toContain("回答已送达");
  });
  it("cancels immediately even while prompt acknowledgement is late, reconnects known conversation and never resends", async () => {
    const host = fixture(), waiting = deferred(); const original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async call => call.action === "prompt" ? waiting.promise : original(call));
    await mount(); await click("开始对话"); await input("慢任务"); await click("发送 ↑");
    const stopping = deferred(); host.request.mockImplementation(async call => call.action === "cancel" ? stopping.promise : original(call));
    await click("取消本次"); expect(container.textContent).toContain("已取消 · 需恢复连接"); expect(button("恢复连接").disabled).toBe(true);
    await act(async () => { waiting.resolve({ turnId: "late", state: "running" }); stopping.resolve({ treeStopped: true }); });
    await click("恢复连接");
    expect(host.request.mock.calls.filter(([call]) => call.action === "prompt")).toHaveLength(1);
    expect(host.request.mock.calls.filter(([call]) => call.action === "connect").at(-1)![0].conversationId).toBe(host.id);
  });
  it("recovers backend history without sending, supports model change and collapsed tools with Escape", async () => {
    const host = fixture(true); host.add({ type: "turn-started", turnId: "old", text: "上次的问题" }); host.add({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "上次的回复" } } });
    host.add({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: "read", title: "读取工程", status: "completed" } }); host.add({ type: "turn-ended" });
    await mount(); expect(container.textContent).toContain("上次的回复"); expect(host.request.mock.calls.some(([call]) => call.action === "prompt")).toBe(false);
    await click("恢复连接"); await select("large", '[aria-label="智能体模型 Model"]'); expect(container.textContent).toContain("模型已切换");
    await click("查看工具活动 · 1"); expect(container.textContent).toContain("读取工程");
    await act(async () => container.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(button("查看工具活动 · 1").getAttribute("aria-expanded")).toBe("false");
  });
  it("keeps IME candidate Enter and Shift+Enter from submitting, rejects whitespace", async () => {
    const host = fixture(); await mount(); await click("开始对话"); await input("中文输入");
    const textarea = container.querySelector("textarea")!;
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })); textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); });
    expect(host.request.mock.calls.some(([call]) => call.action === "prompt")).toBe(false);
    await input("   "); expect(button("发送 ↑").disabled).toBe(true);
    await input("中文输入"); await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(host.request.mock.calls.filter(([call]) => call.action === "prompt")).toHaveLength(1);
  });
  it("pauses failed polling and offers read-only retry, never a prompt retry", async () => {
    const host = fixture(true), original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async call => { if (call.action === "events") throw new Error("本机服务断开"); return original(call); });
    await mount(); expect(container.textContent).toContain("读取对话中断"); await tick();
    expect(host.request.mock.calls.filter(([call]) => call.action === "events")).toHaveLength(1);
    host.request.mockImplementation(original); await click("重新读取对话"); expect(host.request.mock.calls.filter(([call]) => call.action === "events")).toHaveLength(2);
    expect(host.request.mock.calls.some(([call]) => call.action === "prompt")).toBe(false);
  });
  it("restores a historical proposal only when the current digest matches", async () => {
    vi.useRealTimers();
    const host = fixture(true), h = await mount(); host.add({ type: "proposal", turnId: "historic", project: edited(), baseDigest: await projectDigest(project) });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
    for (let attempt = 0; attempt < 10 && !button("查看修改差异"); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    await click("查看修改差异"); await click("确认应用修改"); expect(h.changes).toHaveLength(1);
  });
  it("rejects a stale poll state that was captured before a newer prompt", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!, waiting = deferred();
    await mount(); await click("开始对话");
    host.request.mockImplementation(async call => call.action === "events" ? waiting.promise : original(call));
    await tick(); await input("新任务"); await click("发送 ↑");
    await act(async () => waiting.resolve({ events: [], lastSequence: 1, state: "idle" }));
    expect(container.textContent).toContain("正在回复"); expect(button("取消本次")).toBeTruthy();
  });
  it("keeps a timed-out prompt as uncertain and never retries it automatically", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async call => { if (call.action === "prompt") throw new Error("响应超时"); return original(call); });
    await mount(); await click("开始对话"); await input("不要重复"); await click("发送 ↑"); await tick();
    expect(container.textContent).toContain("未自动重试"); expect(container.textContent).toContain("不要重复");
    expect(host.request.mock.calls.filter(([call]) => call.action === "prompt")).toHaveLength(1); expect(button("发送 ↑").disabled).toBe(true);
    await click("重新读取对话"); expect(container.textContent).toContain("原要求不会重发");
    expect(host.request.mock.calls.filter(([call]) => call.action === "prompt")).toHaveLength(1);
  });
  it("drops late results from the previous project without applying anything", async () => {
    const host = fixture(), h = await mount(), waiting = deferred(), original = host.request.getMockImplementation()!;
    await click("开始对话"); host.request.mockImplementation(async call => call.action === "prompt" ? waiting.promise : original(call));
    await input("旧工程任务"); await click("发送 ↑"); await h.render({ ...project, id: "other-project" });
    await act(async () => waiting.resolve({ turnId: "old", state: "running" }));
    expect(container.textContent).not.toContain("旧工程任务"); expect(container.textContent).toContain("未连接"); expect(h.changes).toHaveLength(0);
  });
  it("hides expired questions and refuses a historical digest mismatch", async () => {
    vi.useRealTimers();
    const host = fixture(true); host.add({ type: "request", requestId: "expired", requestType: "question", message: "旧问题" });
    host.add({ type: "request-expired", requestId: "expired" }); host.add({ type: "proposal", project: edited(), baseDigest: "wrong" });
    await mount(); await act(async () => { await Promise.resolve(); });
    for (let attempt = 0; attempt < 10 && !container.textContent?.includes("历史提案不能安全恢复"); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(container.textContent).not.toContain("旧问题"); expect(container.textContent).toContain("历史提案不能安全恢复"); expect(button("确认应用修改")).toBeUndefined();
  });
  it("explains a non-native environment without calling any host", async () => {
    delete (window as Window & { glintDesktop?: unknown }).glintDesktop;
    await mount(); expect(container.textContent).toContain("在桌面版继续聊"); expect(container.querySelector("textarea")).toBeNull();
  });
  it("shows login or connection failures without sending or reconnecting automatically", async () => {
    const host = fixture(), original = host.request.getMockImplementation()!;
    host.request.mockImplementation(async call => { if (call.action === "connect") throw new Error("请先在官方 CLI 中登录"); return original(call); });
    await mount(); await click("开始对话"); await tick();
    expect(container.textContent).toContain("请先在官方 CLI 中登录"); expect(button("发送 ↑").disabled).toBe(true);
    expect(host.request.mock.calls.filter(([call]) => call.action === "connect")).toHaveLength(1); expect(host.request.mock.calls.some(([call]) => call.action === "prompt")).toBe(false);
  });
  it("keeps browser API mode available and disables the native-only executor", async () => {
    delete (window as Window & { glintDesktop?: unknown }).glintDesktop;
    await mount(project, EditorAssistant);
    expect(container.querySelector<HTMLOptionElement>('[aria-label="创作助手执行者"] option[value="local"]')?.disabled).toBe(true);
    expect(container.querySelector('[aria-label="分镜修改指令"]')).toBeTruthy();
  });
  it("selects project history read-only, pages JSONL and returns to a running task without cancelling it", async () => {
    const host = fixture(true), original = host.request.getMockImplementation()!, h = await mount();
    const old = { conversationId: "older-chat", agentId: "codex", projectId: project.id, kind: "scene", state: "running", lastSequence: 12, title: "继续剪第一版", updatedAt: 100 };
    const recent = { ...old, conversationId: host.id, state: "disconnected", title: "昨天的讨论", updatedAt: 200 };
    host.request.mockImplementation(async call => {
      if (call.action === "list") return { agents: [{ id: "codex", name: "Codex", enabled: true, installed: true, status: "installed" }], conversations: [old, recent] };
      if (call.conversationId === old.conversationId && call.action === "history") return call.before
        ? { events: [{ sequence: 1, type: "turn-started", turnId: "early", text: "最早的要求" }], nextBefore: null, hasMore: false, incomplete: false, state: "running" }
        : { events: [{ sequence: 11, type: "turn-started", turnId: "later", text: "继续处理" }], nextBefore: "800", hasMore: true, incomplete: false, state: "running" };
      if (call.conversationId === old.conversationId && call.action === "events") return { events: [], lastSequence: 12, state: "running", truncated: Number(call.after) === 0 };
      return original(call);
    });
    await click("历史对话");
    const entries = [...container.querySelectorAll<HTMLButtonElement>(".lac-history li button")];
    expect(entries.map(entry => entry.querySelector("strong")!.textContent)).toEqual(["昨天的讨论", "继续剪第一版"]);
    expect(container.textContent).toContain("进行中 · 后台继续执行");
    await act(async () => entries[1]!.click()); expect(container.textContent).toContain("正在只读查看历史"); expect(container.textContent).toContain("继续处理");
    expect(host.request.mock.calls.some(([call]) => ["connect", "prompt", "cancel", "disconnect"].includes(String(call.action)))).toBe(false);
    await click("查看更早记录"); expect(container.textContent).toContain("最早的要求"); expect(host.request).toHaveBeenCalledWith({ action: "history", conversationId: old.conversationId, limit: 50, before: "800" });
    await h.render({ ...project, id: "other" }); await h.render(project); expect(container.textContent).toContain("继续处理");
    await click("继续此任务"); expect(button("取消本次")).toBeTruthy();
    expect(host.request.mock.calls.some(([call]) => ["connect", "prompt", "cancel", "disconnect"].includes(String(call.action)))).toBe(false);
  });
  it("creates a new conversation explicitly and ignores a late history page from the previous chat", async () => {
    const host = fixture(true), original = host.request.getMockImplementation()!, waiting = deferred();
    await mount(); host.request.mockImplementation(async call => {
      if (call.action === "history" && call.conversationId === host.id) return waiting.promise;
      if (call.action === "connect" && call.newConversation === true) return { conversationId: "fresh-chat", state: "idle", modelOptions };
      if (call.action === "events" && call.conversationId === "fresh-chat") return { events: [], lastSequence: 0, state: "idle" };
      if (call.action === "history" && call.conversationId === "fresh-chat") return { events: [], nextBefore: null, hasMore: false, incomplete: false, state: "idle" };
      return original(call);
    });
    await click("新对话");
    const call = host.request.mock.calls.find(([entry]) => entry.action === "connect")![0]; expect(call.newConversation).toBe(true); expect(call.conversationId).toBeUndefined();
    await act(async () => waiting.resolve({ events: [{ sequence: 1, type: "turn-started", text: "不可串入新聊天" }], nextBefore: null, hasMore: false, incomplete: false, state: "idle" }));
    expect(container.textContent).not.toContain("不可串入新聊天"); expect(container.textContent).toContain("新对话已就绪");
    expect(host.request.mock.calls.some(([entry]) => ["cancel", "disconnect", "prompt"].includes(String(entry.action)))).toBe(false);
  });
  it("retains API default and exposes local mode only on native", async () => {
    const host = fixture(); await mount(project, EditorAssistant); expect(container.querySelector('[aria-label="分镜修改指令"]')).toBeTruthy();
    await select("local", '[aria-label="创作助手执行者"]'); expect(container.querySelector('[aria-label="本地智能体聊天"]')).toBeTruthy(); expect(host.request).toHaveBeenCalledWith({ action: "list" });
  });
});

const artifactFixture = (kind: "design" | "script") => {
  const base = parseArtifactProject({ schemaVersion: 1, id: `selection-${++serial}`, title: "选区工程", document: kind === "design"
    ? { id: "doc", kind: "page", title: "页面", updatedAt: 1, activePageId: "page", pages: [{ id: "page", title: "第一页", html: '<main data-design-id="root"><h1 data-design-id="one">原文</h1><p data-design-id="two">保留</p></main>' }] }
    : { id: "doc", kind: "script", title: "脚本", updatedAt: 1, content: "前缀原文保留" } });
  const selection: ArtifactSelection = kind === "design"
    ? { documentId: "doc", pageId: "page", nodeId: "one", nodeIds: ["one"], text: "原文", editable: true }
    : { documentId: "doc", start: 2, end: 4, text: "原文" };
  const change = (outside = false) => {
    const next = captureProject(base) as ArtifactProject;
    if ("pages" in next.document) next.document.pages[0]!.html = next.document.pages[0]!.html.replace(outside ? "保留" : "原文", "改写");
    else next.document.content = next.document.content.replace(outside ? "保留" : "原文", "改写");
    return next;
  };
  return { base, selection, change };
};
async function mountArtifact(kind: "design" | "script", base: ArtifactProject, initialContext?: ChatContext) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const onApply = vi.fn((_next: unknown): void | boolean => {});
  const render = async (context: ChatContext | undefined = initialContext) => {
    await act(async () => root!.render(createElement(LocalAgentChat, { project: base, kind, context, onApply })));
  };
  await render(); return { render, onApply };
}

describe("本地智能体每轮选区保护", () => {
  for (const kind of ["design", "script"] as const) {
    it(`${kind} 在预览与确认应用都验证选区，并允许本地 API 的正常提案`, async () => {
      const { base, selection, change } = artifactFixture(kind), host = fixture(false, kind, base.id);
      const validate = vi.spyOn(chatProposal, "validateChatProposal"), make = vi.spyOn(chatProposal, "makeChatProposal");
      const h = await mountArtifact(kind, base, { selection }); await click("开始对话"); await input("只改选区"); await click("发送 ↑");
      host.add({ type: "proposal", turnId: "turn-1", project: change() }); host.state("idle"); await tick();
      expect(make).toHaveBeenCalledWith(expect.any(Number), kind, base, change(), selection);
      await click("查看修改差异"); await click("确认应用修改");
      expect(validate).toHaveBeenCalledWith(kind, base, change(), selection);
      expect(h.onApply).toHaveBeenCalledTimes(1); expect(h.onApply).toHaveBeenCalledWith(change());
      expect(host.request.mock.calls.find(([call]) => call.action === "prompt")![0].context).toEqual({ selection });
    });
    it.each(["改变", "取消"])(`${kind} %s UI 选区后仍拒绝原轮选区外恶意修改`, async action => {
      const { base, selection, change } = artifactFixture(kind), host = fixture(false, kind, base.id);
      const context = { selection }, h = await mountArtifact(kind, base, context);
      await click("开始对话"); await input("只改原文"); await click("发送 ↑");
      const changed = "nodeId" in selection
        ? { ...selection, nodeId: "two", nodeIds: ["two"], text: "保留" }
        : { ...selection, start: 4, end: 6, text: "保留" };
      if (action === "改变") Object.assign(selection, changed);
      else delete (context as ChatContext).selection;
      await h.render(action === "改变" ? context : {});
      host.add({ type: "proposal", turnId: "turn-1", project: change(true) }); host.state("idle"); await tick();
      expect(container.textContent).toContain("选区以外"); expect(button("确认应用修改")).toBeUndefined(); expect(h.onApply).not.toHaveBeenCalled();
    });
    it(`${kind} 预览完成后取消 UI 选区，应用仍携带原轮约束`, async () => {
      const { base, selection, change } = artifactFixture(kind), host = fixture(false, kind, base.id), h = await mountArtifact(kind, base, { selection });
      const validate = vi.spyOn(chatProposal, "validateChatProposal");
      await click("开始对话"); await input("修改"); await click("发送 ↑");
      host.add({ type: "proposal", turnId: "turn-1", project: change() }); host.state("idle"); await tick();
      await h.render({}); await click("查看修改差异"); await click("确认应用修改");
      expect(validate).toHaveBeenCalledWith(kind, base, change(), selection); expect(h.onApply).toHaveBeenCalledTimes(1);
    });
    it(`${kind} 预览后提案对象被改写，确认应用仍拒绝选区外内容`, async () => {
      const { base, selection, change } = artifactFixture(kind), host = fixture(false, kind, base.id), h = await mountArtifact(kind, base, { selection });
      await click("开始对话"); await input("修改"); await click("发送 ↑");
      const next = change(); host.add({ type: "proposal", turnId: "turn-1", project: next }); host.state("idle"); await tick();
      await click("查看修改差异"); await h.render({});
      if ("pages" in next.document) next.document.pages[0]!.html = next.document.pages[0]!.html.replace("保留", "恶意改写");
      else next.document.content = next.document.content.replace("保留", "恶意改写");
      await click("确认应用修改"); expect(container.textContent).toContain("选区以外"); expect(h.onApply).not.toHaveBeenCalled();
    });
    it(`${kind} 区分已知 undefined 全文上下文和无法恢复的历史上下文`, async () => {
      const { base, change } = artifactFixture(kind), host = fixture(false, kind, base.id), h = await mountArtifact(kind, base);
      await click("开始对话"); await input("全文改写"); await click("发送 ↑");
      host.add({ type: "proposal", turnId: "turn-1", project: change(true) }); host.state("idle"); await tick();
      await click("查看修改差异"); await click("确认应用修改"); expect(h.onApply).toHaveBeenCalledTimes(1);
      await act(async () => root!.unmount()); root = undefined;
      const historical = fixture(true, kind, base.id);
      historical.add({ type: "proposal", turnId: "unknown", project: change(true), baseDigest: await projectDigest(base) });
      const remounted = await mountArtifact(kind, base);
      expect(container.textContent).toContain("原始选区上下文"); expect(container.textContent).toContain("重新生成");
      expect(button("确认应用修改")).toBeUndefined(); expect(remounted.onApply).not.toHaveBeenCalled();
    });
  }
  it("同一对话的多轮分别冻结 selection，不复用新一轮范围", async () => {
    const { base, selection, change } = artifactFixture("design"), host = fixture(false, "design", base.id), h = await mountArtifact("design", base, { selection });
    await click("开始对话"); await input("改第一处"); await click("发送 ↑");
    host.add({ type: "turn-ended", turnId: "turn-1" }); host.state("idle"); await tick();
    await h.render({ selection: { documentId: "doc", pageId: "page", nodeId: "two", nodeIds: ["two"], text: "保留", editable: true } });
    await input("改第二处"); await click("发送 ↑");
    host.add({ type: "proposal", turnId: "turn-1", project: change(true) });
    host.add({ type: "proposal", turnId: "turn-2", project: change(true) }); host.state("idle"); await tick();
    expect(container.querySelectorAll(".lac-proposal")[0]!.textContent).toContain("选区以外");
    await click("查看修改差异"); await click("确认应用修改"); expect(h.onApply).toHaveBeenCalledWith(change(true));
  });
  it("深拷贝 nodeIds，外部原地扩展数组不能扩大原轮范围", async () => {
    const { base, selection, change } = artifactFixture("design"), host = fixture(false, "design", base.id), h = await mountArtifact("design", base, { selection });
    await click("开始对话"); await input("只改一个节点"); await click("发送 ↑");
    if ("nodeIds" in selection) selection.nodeIds!.push("two");
    host.add({ type: "proposal", turnId: "turn-1", project: change(true) }); host.state("idle"); await tick();
    expect(container.textContent).toContain("选区以外"); expect(h.onApply).not.toHaveBeenCalled();
    expect((host.request.mock.calls.find(([call]) => call.action === "prompt")![0].context as ChatContext).selection).toMatchObject({ nodeIds: ["one"] });
  });
  it("onApply 抛异常不会永久占用 used，可再次确认", async () => {
    const { base, selection, change } = artifactFixture("design"), host = fixture(false, "design", base.id), h = await mountArtifact("design", base, { selection });
    h.onApply.mockImplementationOnce(() => { throw new Error("编辑器暂时失败"); });
    await click("开始对话"); await input("修改"); await click("发送 ↑");
    host.add({ type: "proposal", turnId: "turn-1", project: change() }); host.state("idle"); await tick();
    await click("查看修改差异"); await click("确认应用修改");
    expect(container.textContent).toContain("编辑器暂时失败"); expect(button("确认应用修改").disabled).toBe(false);
    await click("确认应用修改"); expect(h.onApply).toHaveBeenCalledTimes(2); expect(container.textContent).toContain("修改已应用");
  });
  it("发送确认丢失后从事件恢复原始上下文，不把旧 turn-started 当作本轮", async () => {
    const { base, selection, change } = artifactFixture("design"), host = fixture(false, "design", base.id), original = host.request.getMockImplementation()!;
    host.add({ type: "turn-started", turnId: "old", text: "旧要求" });
    host.request.mockImplementation(async call => {
      if (call.action === "prompt") { await original(call); throw new Error("确认丢失"); }
      return original(call);
    });
    const h = await mountArtifact("design", base, { selection }); await click("开始对话"); await input("新要求"); await click("发送 ↑");
    await h.render({}); await click("重新读取对话");
    host.add({ type: "proposal", turnId: "old", project: change() });
    host.add({ type: "proposal", turnId: "turn-1", project: change(true) }); host.state("idle"); await tick();
    expect(container.textContent).toContain("原始选区上下文"); expect(container.textContent).toContain("选区以外"); expect(h.onApply).not.toHaveBeenCalled();
    host.add({ type: "proposal", turnId: "turn-1", project: change() }); await tick();
    await click("查看修改差异"); await click("确认应用修改"); expect(h.onApply).toHaveBeenCalledTimes(1);
    expect(host.request.mock.calls.filter(([call]) => call.action === "prompt")).toHaveLength(1);
  });
  it("相同 turnId 在不同 conversation 不串上下文，切回原对话保留约束", async () => {
    const { base, selection, change } = artifactFixture("design"), host = fixture(false, "design", base.id), original = host.request.getMockImplementation()!;
    const h = await mountArtifact("design", base, { selection }); await click("开始对话"); await input("第一轮"); await click("发送 ↑");
    host.add({ type: "proposal", turnId: "turn-1", project: change() }); host.state("idle"); await tick();
    host.request.mockImplementation(async call => {
      if (call.action === "connect" && call.newConversation) return { conversationId: "separate", state: "idle" };
      if (call.conversationId === "separate" && call.action === "events") return { events: [{ sequence: 1, type: "proposal", turnId: "turn-1", project: change(true) }], lastSequence: 1, state: "idle" };
      if (call.conversationId === "separate" && call.action === "history") return { events: [], nextBefore: null, hasMore: false, incomplete: false };
      if (call.action === "list") return { agents: [{ id: "codex", name: "Codex", installed: true, enabled: true }], conversations: [{ conversationId: host.id, agentId: "codex", projectId: base.id, kind: "design", state: "idle", title: "原对话" }] };
      return original(call);
    });
    await h.render({}); await click("新对话"); expect(container.textContent).toContain("原始选区上下文");
    await click("历史对话"); await click("原对话Codex · 较早对话已连接");
    await click("查看修改差异"); expect(button("确认应用修改").disabled).toBe(true);
    await click("恢复连接"); await click("确认应用修改"); expect(h.onApply).toHaveBeenCalledTimes(1); expect(h.onApply).toHaveBeenCalledWith(change());
  });
});

describe("proposal and journal safety family", () => {
  it.each(["design", "script"] as const)("%s 生成与再次校验都拒绝选区外修改", kind => {
    const { base, selection, change } = artifactFixture(kind);
    expect(() => makeChatProposal(1, kind, base, change(true), selection)).toThrow("选区以外");
    expect(() => validateChatProposal(kind, base, change(true), selection)).toThrow("选区以外");
    expect(validateChatProposal(kind, base, change(), selection)).toEqual(change());
  });
  it("rejects identity, frozen project, locked scene start shifts and approved changes", () => {
    expect(() => makeChatProposal(1, "scene", project, { ...edited(), id: "other" })).toThrow("其他工程");
    expect(() => makeChatProposal(1, "scene", { ...project, frozen: true }, edited())).toThrow("冻结");
    const base = structuredClone(project); base.scenes[1]!.locked = true;
    const shifted = structuredClone(base); shifted.scenes[0]!.narration.durationMs = 2000;
    expect(() => makeChatProposal(1, "scene", base, shifted)).toThrow("已锁定");
    const next = structuredClone(base); next.scenes[1]!.locked = false;
    expect(() => makeChatProposal(1, "scene", base, next)).toThrow("已锁定");
  });
  it("reuses NLE diff and rejects locked track mutations or moves", () => {
    const base = parseNleProject({ schemaVersion: 1, id: "nle", title: "时间线", fps: 30, width: 1920, height: 1080, tracks: [{ id: "titles", name: "字幕", kind: "text", clips: [{ id: "title", kind: "text", text: "原文", startMs: 0, durationMs: 1000 }] }] });
    const next = structuredClone(base); (next.tracks[0]!.clips[0] as { text: string }).text = "新文";
    expect(makeChatProposal(1, "nle", base, next).changes[0]).toMatchObject({ label: "修改 · 轨道「字幕」 · 片段 1 · 文字", timeMs: 0 });
    base.tracks[0]!.locked = true; expect(() => makeChatProposal(1, "nle", base, next)).toThrow("已锁定");
  });
  it("deduplicates events, strips ANSI, hides expired permissions and separates interleaved replies", () => {
    const first: AgentEvent = { type: "turn-started", turnId: "one", text: "问", sequence: 1 };
    const events = mergeEvents([first], [first, { type: "update", sequence: 2, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\u001b[31m回复" } } }, { type: "request", requestType: "permission", requestId: "p", sequence: 3 }, { type: "request-expired", requestId: "p", sequence: 4 }]);
    const result = projectEvents(events); expect(result.messages).toHaveLength(2); expect(result.messages[1]!.text).toBe("回复"); expect(result.requests).toHaveLength(0);
  });
});
