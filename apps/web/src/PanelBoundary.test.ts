// @vitest-environment jsdom
import { act, Component, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PanelBoundary } from "./PanelBoundary";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
class Broken extends Component<{ children?: ReactNode }> {
  render(): ReactNode { throw new Error("chunk failed"); }
}
it("shows a reload fallback when a lazy panel fails instead of blanking the editor", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root.render(createElement(PanelBoundary, { label: "生成工具", children: createElement(Broken) })));
  const alert = div.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("生成工具加载失败");
  expect(alert?.textContent).toContain("不会丢失");
  expect([...div.querySelectorAll("button")].some(button => button.textContent === "刷新页面")).toBe(true);
});
it("renders children when nothing throws", async () => {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(PanelBoundary, { label: "风格", children: createElement("span", null, "ok") })));
  expect(div.textContent).toBe("ok");
});
