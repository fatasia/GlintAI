// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PreviewBoundary } from "./PreviewBoundary";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it("contains preview failures instead of unmounting the whole workspace", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const node = document.createElement("div"), root = createRoot(node);
  const Broken = () => { throw new Error("failed preview import"); };
  try {
    await act(async () => root.render(createElement(PreviewBoundary, null, createElement(Broken))));
    expect(node.textContent).toContain("预览加载失败");
    expect(node.querySelector("button")?.textContent).toBe("重新加载");
  } finally { act(() => root.unmount()); consoleError.mockRestore(); }
});
