// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentSettings } from "./LocalAgentSettings";
import type { LocalAgent, LocalAgentSettingsRequest } from "./local-agent-client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const claude: LocalAgent = { id: "claude", name: "Claude Code", installed: true, status: "ready", enabled: false, version: "2.1", path: "C:\\tools\\claude.exe" };
const codex: LocalAgent = { id: "codex", name: "Codex", installed: true, status: "disconnected", enabled: false };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function render(request?: (request: LocalAgentSettingsRequest) => Promise<unknown>, strict = false) {
  vi.stubGlobal("glintDesktop", request ? { request } : undefined);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => { act(() => root.unmount()); div.remove(); };
  await act(async () => root.render(strict ? createElement(StrictMode, null, createElement(LocalAgentSettings)) : createElement(LocalAgentSettings)));
  return div;
}
function button(container: Element, label: string) { const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); expect(result, label).toBeTruthy(); return result!; }
async function click(container: Element, label: string) { await act(async () => button(container, label).click()); }
const card = (div: Element, name: string) => div.querySelector<HTMLElement>(`li[aria-label="${name}"]`)!;

it("shows desktop guidance without calling fetch or storing credentials", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const write = vi.spyOn(Storage.prototype, "setItem");
  const div = await render();
  expect(div.textContent).toContain("在桌面版使用本地智能体"); expect(div.textContent).toContain("API 模型和媒体服务仍可正常");
  expect(div.querySelector("button")).toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it("renders loading immediately, refreshes a real list and exposes official links without installation", async () => {
  const first = deferred<unknown>();
  const request = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ agents: [claude] });
  const div = await render(request);
  expect(div.textContent).toContain("正在检测本机智能体"); expect(button(div, "检测中…").disabled).toBe(true);
  await act(async () => first.resolve({ agents: [{ ...codex, installed: false, status: "missing" }] }));
  expect(card(div, "Codex").textContent).toContain("未安装");
  expect(card(div, "Codex").querySelector("a")?.href).toBe("https://developers.openai.com/codex/cli/");
  expect(card(div, "Codex").querySelector('button[title*="启用"]')).toBeNull();
  await click(div, "刷新检测");
  expect(card(div, "Claude Code")).toBeTruthy(); expect(card(div, "Codex")).toBeNull();
  expect(request.mock.calls.map(call => call[0])).toEqual([{ action: "list" }, { action: "list" }]);
});

it("recovers list failures and empty states through real retry clicks", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("桌面服务离线")).mockResolvedValueOnce({ agents: [] }).mockResolvedValue({ agents: [claude] });
  const div = await render(request);
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("桌面服务离线");
  await click(div, "重试检测"); expect(div.textContent).toContain("尚未发现可用的智能体");
  expect([...div.querySelectorAll("a")].every(link => link.href.startsWith("https://"))).toBe(true);
  await click(div, "刷新检测"); expect(card(div, "Claude Code")).toBeTruthy();
});

it("probes status, enables and disables without a fake connection or logout", async () => {
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => input.action === "list" ? { agents: [claude] }
    : { agent: { ...claude, enabled: input.action === "configure" ? input.enabled : false, status: "ready" } });
  const div = await render(request), row = card(div, "Claude Code");
  await click(row, "检测状态"); expect(row.textContent).toContain("检测完成，状态已更新");
  await click(row, "启用"); expect(row.textContent).toContain("已启用；在工程会话中连接"); expect(button(row, "停用")).toBeTruthy();
  expect(row.textContent).not.toContain("已连接");
  await click(row, "停用"); expect(row.textContent).toContain("已停用"); expect(row.textContent).toContain("未退出本机账号");
  expect(request.mock.calls.map(call => call[0])).toEqual([
    { action: "list" }, { action: "status", agentId: "claude" },
    { action: "configure", agentId: "claude", enabled: true }, { action: "configure", agentId: "claude", enabled: false },
  ]);
});

it("keeps busy state per agent, deduplicates repeated clicks and retries failed actions", async () => {
  const pending = deferred<unknown>();
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => {
    if (input.action === "list") return { agents: [claude, codex] };
    if (input.agentId === "claude" && input.action === "configure") return pending.promise;
    return { agent: { ...codex, status: "ready", enabled: true } };
  });
  const div = await render(request), first = card(div, "Claude Code"), second = card(div, "Codex");
  await act(async () => { button(first, "启用").click(); button(first, "启用").click(); });
  expect(first.textContent).toContain("正在启用"); expect(button(first, "启用中…").disabled).toBe(true);
  expect(button(second, "检测状态").disabled).toBe(false); await click(second, "检测状态");
  expect(second.textContent).toContain("就绪");
  await act(async () => pending.reject(new Error("授权失败")));
  expect(first.querySelector('[role="alert"]')?.textContent).toContain("授权失败");
  request.mockImplementation(async input => ({ agent: { ...claude, enabled: input.action === "configure" ? input.enabled : false } }));
  await click(first, "重试"); expect(first.textContent).toContain("已启用");
  expect(request.mock.calls.filter(([input]) => input.action === "configure")).toHaveLength(2);
});

it("locates a full unicode path in collapsed details and closes details with Escape restoring focus", async () => {
  const longPath = `C:\\本地 智能体 & 工具\\${"a".repeat(210)}\\claude.exe`;
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => input.action === "list" ? { agents: [claude] } : { agent: { ...claude, path: input.action === "locate" ? input.path : claude.path } });
  const div = await render(request), row = card(div, "Claude Code"), details = row.querySelector("details")!, summary = details.querySelector("summary")!;
  expect(details.open).toBe(false);
  await act(async () => summary.click()); expect(details.open).toBe(true); expect(details.textContent).toContain("2.1");
  const input = details.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, longPath); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(details, "定位路径"); expect(request).toHaveBeenCalledWith({ action: "locate", agentId: "claude", path: longPath });
  expect(details.querySelector("code")?.textContent).toBe(longPath); expect(row.textContent).toContain("路径已更新");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(details.open).toBe(false); expect(document.activeElement).toBe(summary);
});

it("follows mutation acknowledgements with real status and never invents state", async () => {
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => input.action === "list" ? { agents: [claude] }
    : input.action === "configure" ? { ok: true } : { agent: { ...claude, enabled: true, status: "disconnected" } });
  const div = await render(request), row = card(div, "Claude Code");
  await click(row, "启用"); expect(request.mock.calls.at(-1)?.[0]).toEqual({ action: "status", agentId: "claude" });
  expect(row.textContent).toContain("未连接"); expect(row.textContent).not.toContain("已连接"); expect(button(row, "停用")).toBeTruthy();
});

it("does not report configuration success when the backend did not apply it", async () => {
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => input.action === "list" ? { agents: [claude] } : { agent: claude });
  const div = await render(request), row = card(div, "Claude Code");
  await click(row, "启用"); expect(row.querySelector('[role="alert"]')?.textContent).toContain("启用状态尚未生效");
  expect(row.textContent).not.toContain("已启用；"); expect(button(row, "启用")).toBeTruthy();
});

it("does not let a stale list overwrite newer agent configuration", async () => {
  const stale = deferred<unknown>(); let lists = 0;
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => input.action === "list"
    ? ++lists === 1 ? { agents: [claude] } : stale.promise
    : { agent: { ...claude, enabled: true } });
  const div = await render(request), row = card(div, "Claude Code");
  await click(div, "刷新检测"); await click(row, "启用");
  await act(async () => stale.resolve({ agents: [claude] }));
  expect(button(row, "停用")).toBeTruthy();
});

it("retains an active card when a refresh temporarily omits its agent", async () => {
  const operation = deferred<unknown>(); let lists = 0;
  const request = vi.fn(async (input: LocalAgentSettingsRequest) => input.action === "list"
    ? { agents: ++lists === 1 ? [claude] : [] } : operation.promise);
  const div = await render(request), row = card(div, "Claude Code");
  await click(row, "启用"); await click(div, "刷新检测");
  expect(card(div, "Claude Code")).toBe(row); expect(row.textContent).toContain("正在启用");
  await act(async () => operation.resolve({ agent: { ...claude, enabled: true } }));
  expect(button(row, "停用")).toBeTruthy();
});

it("reports malformed and wrong-agent status responses as retryable errors", async () => {
  const request = vi.fn().mockResolvedValueOnce({ agents: [claude, claude] }).mockResolvedValueOnce({ agents: [claude] }).mockResolvedValueOnce({ agent: codex }).mockResolvedValue({ agent: claude });
  const div = await render(request); expect(div.querySelector('[role="alert"]')?.textContent).toContain("列表无效");
  await click(div, "重试检测"); const row = card(div, "Claude Code");
  await click(row, "检测状态"); expect(row.querySelector('[role="alert"]')?.textContent).toContain("未收到该智能体");
  await click(row, "重试"); expect(row.querySelector('[role="alert"]')).toBeNull();
});

it("survives StrictMode remounts and ignores results after unmount", async () => {
  const pending = deferred<unknown>();
  const request = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue({ agents: [claude] });
  const div = await render(request, true); expect(card(div, "Claude Code")).toBeTruthy();
  await act(async () => pending.resolve({ agents: [codex] })); expect(card(div, "Codex")).toBeNull();
  const late = deferred<unknown>(); request.mockImplementation(() => late.promise);
  await click(div, "刷新检测"); cleanup(); cleanup = () => {};
  await act(async () => late.resolve({ agents: [codex] })); expect(document.querySelector(".local-agent-settings")).toBeNull();
});
