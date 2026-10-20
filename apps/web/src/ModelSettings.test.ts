// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSettings } from "./ModelSettings";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads public connection settings without restoring a browser-stored secret", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ baseUrl: "https://service.test/v1", model: "model-a", protocol: "auto", configured: true })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => { act(() => root.unmount()); div.remove(); };
  await act(async () => root.render(createElement(ModelSettings)));
  await act(async () => { div.querySelector("button")!.click(); await Promise.resolve(); });
  expect((div.querySelector('[aria-label="模型服务地址"]') as HTMLInputElement).value).toBe("https://service.test/v1");
  expect((div.querySelector('[aria-label="模型 API 密钥"]') as HTMLInputElement).value).toBe("");
  expect(div.textContent).toContain("自动适配");
});
