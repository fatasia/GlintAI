// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ComfyConnectionForm } from "./ComfyConnectionForm";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const result = (data: unknown, ok = true) => ({ ok, json: async () => data });
const config = { configured: true, endpoint: "http://127.0.0.1:8188", source: "saved" };
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll('button')].find(item => item.textContent === name)!;
async function click(element: HTMLElement) { await act(async () => { element.click(); await pause(); }); }
async function fill(host: HTMLElement, value: string) {
  const field = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function mount(fetcher: (url: string, init?: RequestInit) => Promise<unknown>, disabled = false) {
  const fetch = vi.fn(fetcher); vi.stubGlobal("fetch", fetch); const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host), configured = vi.fn(), busy = vi.fn();
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(ComfyConnectionForm, { disabled, onConfigured: configured, onBusyChange: busy })); await pause(); });
  return { host, fetch, configured, busy };
}
it("reads once, saves a loopback address, and resets to the default without claiming connectivity", async () => {
  const { host, fetch, configured } = await mount(async (_url, init) => {
    if (!init?.method) return result(config);
    const { endpoint } = JSON.parse(String(init.body)); return result(endpoint === null ? { configured: false, endpoint: null, source: "none" } : { ...config, endpoint });
  });
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe(config.endpoint); expect(fetch).toHaveBeenCalledTimes(1);
  await fill(host, "http://[::1]:8189"); await click(button(host, "保存连接"));
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ endpoint: "http://[::1]:8189" });
  expect(host.textContent).toContain("尚未验证服务连通性"); expect(configured).toHaveBeenLastCalledWith(true);
  await click(button(host, "恢复默认连接")); expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({ endpoint: null });
  expect(configured).toHaveBeenLastCalledWith(false); expect(host.querySelector<HTMLInputElement>('input')!.value).toBe("");
});
it("does not enable save for non-literal hosts, paths or credentials", async () => {
  const { host, fetch } = await mount(async () => result(config));
  for (const address of ["http://localhost:8188", "https://remote.invalid", "http://user:secret@127.0.0.1:8188", "http://127.0.0.1:8188/private", "http://127.0.0.1:99999"]) {
    await fill(host, address); expect(button(host, "保存连接").disabled).toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("keeps a failed save draft and disables generation until configuration is confirmed again", async () => {
  const { host, configured } = await mount(async (_url, init) => init?.method ? result({ error: "failure" }, false) : result(config));
  await fill(host, "http://127.0.0.1:8190"); await click(button(host, "保存连接"));
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe("http://127.0.0.1:8190"); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(configured).toHaveBeenLastCalledWith(false);
  await click(button(host, "重新读取配置")); expect(configured).toHaveBeenLastCalledWith(true); expect(host.querySelector<HTMLInputElement>('input')!.value).toBe(config.endpoint);
});
it("locks address changes while a task is tracked without issuing a cancellation", async () => {
  const { host, fetch } = await mount(async () => result(config), true);
  expect(host.querySelector<HTMLInputElement>('input')!.disabled).toBe(true); expect([...host.querySelectorAll('button')].every(item => item.disabled)).toBe(true);
  await click(button(host, "恢复默认连接")); expect(fetch).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("不会停止上游任务");
});
it("blocks duplicate saves and ignores a late response after unmount", async () => {
  let finish!: (value: unknown) => void;
  const { host, fetch, configured } = await mount(async (_url, init) => init?.method ? new Promise(resolve => { finish = resolve; }) : result(config));
  await click(button(host, "保存连接")); await click(button(host, "保存连接")); expect(fetch).toHaveBeenCalledTimes(2);
  dispose(); dispose = () => {}; await act(async () => { finish(result({ ...config, configured: false })); await pause(); });
  expect(configured).toHaveBeenCalledTimes(1);
});
