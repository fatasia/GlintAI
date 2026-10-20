// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useFontGate } from "./useFontGate";
const gates = vi.hoisted(() => ({ delayRender: vi.fn(() => Math.random()), continueRender: vi.fn(), cancelRender: vi.fn() }));
vi.mock("remotion", () => gates);
const cleanups: (() => void)[] = [];
beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(strict = false) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Content({ fonts }: { fonts: string[] }) { useFontGate(fonts); return createElement("div", null, "中文 content"); }
  const render = (fonts: string[]) => act(() => root.render(strict
    ? createElement(StrictMode, null, createElement(Content, { fonts })) : createElement(Content, { fonts })));
  render(["sans-serif"]);
  const unmount = () => { act(() => root.unmount()); container.remove(); };
  cleanups.push(unmount);
  return { container, render };
}
function fonts(load: Promise<void>, ready = Promise.resolve()) {
  const api = { load: vi.fn(() => load), ready };
  Object.defineProperty(document, "fonts", { configurable: true, value: api });
  return api;
}
describe("composition font readiness", () => {
  it("keeps content mounted but holds capture through load AND document readiness", async () => {
    const loading = deferred(); const ready = deferred(); const api = fonts(loading.promise, ready.promise);
    const m = mount();
    expect(m.container.textContent).toBe("中文 content");
    expect(api.load).toHaveBeenCalledWith("36px sans-serif", "中文 Aa 123");
    expect(gates.continueRender).not.toHaveBeenCalled();
    await act(async () => { loading.resolve(); });
    expect(gates.continueRender).not.toHaveBeenCalled();
    await act(async () => { ready.resolve(); });
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
  });
  it("allocates a live handle for StrictMode replay, not a previously released one", async () => {
    const loading = deferred(); fonts(loading.promise); mount(true);
    expect(gates.delayRender).toHaveBeenCalledTimes(2);
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
    await act(async () => { loading.resolve(); });
    expect(gates.continueRender).toHaveBeenCalledTimes(2);
    expect(gates.continueRender.mock.calls[1]![0]).toBe(gates.delayRender.mock.results[1]!.value);
  });
  it("re-gates theme changes while equal family lists do not restart loading", async () => {
    const loading = deferred(); fonts(loading.promise); const m = mount();
    m.render(["sans-serif"]); expect(gates.delayRender).toHaveBeenCalledTimes(1);
    m.render(["serif"]); expect(gates.delayRender).toHaveBeenCalledTimes(2);
    expect(gates.continueRender).toHaveBeenCalledTimes(1);
    await act(async () => { loading.resolve(); });
    expect(gates.continueRender).toHaveBeenCalledTimes(2);
  });
  it("cancels rejected font loads without releasing a bad frame", async () => {
    const loading = deferred(); fonts(loading.promise); mount();
    await act(async () => { loading.reject(new Error("broken font")); });
    expect(gates.cancelRender).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("broken font") }));
    expect(gates.continueRender).not.toHaveBeenCalled();
  });
});
