// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { OfflineStatus } from "./OfflineStatus";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function mount(waiting = false) {
  const worker = { postMessage: vi.fn() }, serviceWorker = new EventTarget();
  Object.assign(serviceWorker, { controller: {}, register: vi.fn(async () => Object.assign(new EventTarget(), { waiting: waiting ? worker : null })) });
  vi.stubGlobal("navigator", { onLine: true, serviceWorker }); vi.stubEnv("PROD", true);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(OfflineStatus)); });
  return { host, worker, serviceWorker };
}
async function promptInstall() {
  const event = new Event("beforeinstallprompt", { cancelable: true }), prompt = vi.fn(async () => {});
  Object.assign(event, { prompt }); await act(async () => { window.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true); return prompt;
}
async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
it("leaves no placeholder when hidden and renders offline status in the flow region", async () => {
  const { host } = await mount(); expect(host.childElementCount).toBe(0);
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  expect(host.querySelector('aside.offline-status [role="status"]')?.textContent).toContain("当前离线");
  expect(host.querySelector('.glint-toast-stack')).toBeNull();
  await act(async () => { window.dispatchEvent(new Event("online")); }); expect(host.childElementCount).toBe(0);
});
it("offers explicit keyboard-focusable installation and preserves 12 second dismissal", async () => {
  vi.useFakeTimers(); const { host } = await mount(); const prompt = await promptInstall();
  const install = [...host.querySelectorAll("button")].find(button => button.textContent === "安装 Glint")!;
  install.focus(); expect(document.activeElement).toBe(install); expect(prompt).not.toHaveBeenCalled();
  await click(host, "安装 Glint"); expect(prompt).toHaveBeenCalledTimes(1); expect(host.childElementCount).toBe(0);
  const ignored = await promptInstall(); await act(async () => { vi.advanceTimersByTime(11_999); }); expect(host.querySelector("button")).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(1); }); expect(host.childElementCount).toBe(0); expect(ignored).not.toHaveBeenCalled();
  await promptInstall(); await click(host, "暂不安装"); expect(host.childElementCount).toBe(0);
});
it("never activates or reloads a waiting worker without confirmation", async () => {
  const { host, worker, serviceWorker } = await mount(true), confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const reload = vi.fn(); vi.stubGlobal("location", { reload });
  await click(host, "重新加载"); expect(confirm).toHaveBeenCalledOnce(); expect(worker.postMessage).not.toHaveBeenCalled();
  serviceWorker.dispatchEvent(new Event("controllerchange")); expect(reload).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await click(host, "重新加载"); expect(worker.postMessage).toHaveBeenCalledWith("activate"); expect(reload).not.toHaveBeenCalled();
  serviceWorker.dispatchEvent(new Event("controllerchange")); expect(reload).toHaveBeenCalledTimes(1);
});
it("defers updates explicitly or after 15 seconds without losing the offline notice", async () => {
  vi.useFakeTimers(); const { host, worker } = await mount(true);
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  await click(host, "稍后更新"); expect(host.textContent).not.toContain("有新版本"); expect(host.textContent).toContain("当前离线"); expect(worker.postMessage).not.toHaveBeenCalled();
});
it("auto-defers a waiting update after the original 15 seconds", async () => {
  vi.useFakeTimers(); const { host, worker } = await mount(true);
  await act(async () => { vi.advanceTimersByTime(14_999); }); expect(host.textContent).toContain("有新版本");
  await act(async () => { vi.advanceTimersByTime(1); }); expect(host.childElementCount).toBe(0); expect(worker.postMessage).not.toHaveBeenCalled();
});
