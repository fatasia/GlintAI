// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import StyleCatalog from "./StyleCatalog";
import { readStyleTrial } from "./style-trial";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseProject({ schemaVersion: 1, id: "trial-test", title: "试片", aspect: "16:9", theme: "glint-dark", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "标题", narration: { text: "旁白", durationMs: 2000 } }] });
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); });

async function mount(submit: () => Promise<unknown>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/make" && init?.method === "POST") { calls.push(JSON.parse(String(init.body)).requestId); return submit(); }
    if (url.startsWith("/api/make/request/")) return { ok: true, json: async () => ({ id: "idea-recovered", status: "done", log: [] }) };
    return { ok: true, json: async () => ({ entries: [] }) };
  }));
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(StyleCatalog, { project, selected: "glint-dark", onChange: vi.fn() })));
  const click = async (text: string) => act(async () => {
    const button = [...div.querySelectorAll("button")].find(element => element.textContent === text);
    expect(button?.disabled).toBe(false); button!.click();
  });
  return { div, calls, click };
}

it.each([400, 413, 503])("allows a new trial after explicit rejection %i and clears its receipt", async status => {
  const h = await mount(async () => ({ ok: false, status, json: async () => ({ error: "private error" }) }));
  await h.click("生成当前工程试片");
  expect(h.div.textContent).toContain("试片未提交，请检查工程和本地渲染服务后重试。");
  expect(h.div.textContent).not.toContain("private error");
  expect(h.div.textContent).not.toContain("恢复查询");
  expect(readStyleTrial(project.id)).toBeNull();
  await h.click("重新生成试片");
  expect(h.calls).toHaveLength(2); expect(h.calls[0]).not.toBe(h.calls[1]);
  expect(readStyleTrial(project.id)).toBeNull();
});

it("keeps the receipt and blocks resubmission when the outcome is uncertain", async () => {
  const h = await mount(async () => { throw new TypeError("network interrupted"); });
  await h.click("生成当前工程试片");
  expect(h.div.textContent).toContain("提交回执未确认");
  expect(readStyleTrial(project.id)?.requestId).toBe(h.calls[0]);
  expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "生成当前工程试片")?.disabled).toBe(true);
  await h.click("恢复查询");
  expect(h.div.textContent).toContain("试片状态：已完成");
  expect(h.calls).toHaveLength(1);
});
