// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalAgentAvailable, localAgentRequest, readLocalAgentList, readLocalAgentUpdate } from "./local-agent-client";

const agent = { id: "claude", name: "Claude Code", installed: true, status: "ready", enabled: false };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("desktop local agent transport", () => {
  it("explains desktop-only access without a network or credential fallback", async () => {
    vi.stubGlobal("glintDesktop", undefined);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const storage = vi.spyOn(Storage.prototype, "getItem");
    expect(isLocalAgentAvailable()).toBe(false);
    await expect(localAgentRequest({ action: "list" })).rejects.toThrow("请在桌面版使用本地智能体");
    expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  });
  it("passes exact JSON actions through the injected bridge with its receiver", async () => {
    const bridge = { request: vi.fn(async function (this: unknown, request: unknown) { expect(this).toBe(bridge); return { agents: [agent], request }; }) };
    vi.stubGlobal("glintDesktop", bridge);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(isLocalAgentAvailable()).toBe(true);
    expect(await localAgentRequest({ action: "list" })).toMatchObject({ agents: [agent] });
    await localAgentRequest({ action: "locate", agentId: "claude", path: "C:\\智能体 & tools\\claude.exe" });
    await localAgentRequest({ action: "configure", agentId: "claude", enabled: true });
    expect(bridge.request.mock.calls.map(call => call[0])).toEqual([
      { action: "list" }, { action: "locate", agentId: "claude", path: "C:\\智能体 & tools\\claude.exe" }, { action: "configure", agentId: "claude", enabled: true },
    ]);
    expect(write).not.toHaveBeenCalled();
  });
  it("supports the shared project-session action contract without rewriting payloads", async () => {
    const request = vi.fn(async () => ({ conversationId: "session-1", connected: true }));
    vi.stubGlobal("glintDesktop", { request });
    const payload = { action: "connect", agentId: "codex", projectId: "project-1", model: "gpt-test" };
    await expect(localAgentRequest<{ conversationId: string }>(payload)).resolves.toMatchObject({ conversationId: "session-1" });
    expect(request).toHaveBeenCalledWith(payload);
  });
  it.each([null, "not JSON", [], { error: "路径不存在" }, { ok: false, error: { message: "权限不足" } }])("rejects invalid or refused results: %j", async result => {
    vi.stubGlobal("glintDesktop", { request: vi.fn(async () => result) });
    await expect(localAgentRequest({ action: "list" })).rejects.toThrow();
  });
  it("allows connect seventy seconds while other actions keep twenty seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("glintDesktop", { request: () => new Promise(() => {}) });
    const connect = localAgentRequest({ action: "connect", agentId: "codex" });
    const rejected = expect(connect).rejects.toThrow("响应超时");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a hung bridge and ignores its late completion", async () => {
    vi.useFakeTimers(); let finish!: (value: unknown) => void;
    vi.stubGlobal("glintDesktop", { request: () => new Promise(resolve => { finish = resolve; }) });
    const request = localAgentRequest({ action: "list" });
    const rejected = expect(request).rejects.toThrow("响应超时");
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    finish({ agents: [agent] }); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("local agent response contract", () => {
  it("accepts an empty list and optional metadata but rejects duplicate and malformed agents", () => {
    expect(readLocalAgentList({ agents: [] })).toEqual([]);
    expect(readLocalAgentList({ agents: [agent], conversations: [] })).toEqual([agent]);
    for (const value of [{}, { agents: [agent, agent] }, { agents: [{ ...agent, installed: "yes" }] }, { agents: [{ ...agent, path: {} }] }]) {
      expect(() => readLocalAgentList(value)).toThrow("列表无效");
    }
  });
  it("reads direct, wrapped and list results without accepting the wrong agent", () => {
    expect(readLocalAgentUpdate(agent, "claude")).toEqual(agent);
    expect(readLocalAgentUpdate({ agent }, "claude")).toEqual(agent);
    expect(readLocalAgentUpdate({ agents: [agent] }, "claude")).toEqual(agent);
    expect(readLocalAgentUpdate({ ok: true }, "claude")).toBeUndefined();
    expect(readLocalAgentUpdate(agent, "codex")).toBeUndefined();
  });
});
