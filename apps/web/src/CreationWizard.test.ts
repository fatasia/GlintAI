// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CreationWizard } from "./CreationWizard";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); });

const PLAN = {
  title: "咖啡店开业", hook: "这条街最香的开业", audience: "周边居民", platform: "16:9", theme: "glint-dark", totalSeconds: 15, takeaway: "来喝第一杯",
  scenes: [
    { goal: "开场钩子", narration: "这条街最香的开业，就在周六。", visual: "门店外观，人流", seconds: 3, kind: "title" },
    { goal: "核心卖点", narration: "手冲咖啡，前 50 位送一杯。", visual: "咖啡师冲煮特写", seconds: 6, kind: "bullets" },
  ],
};

async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  let composed: { source: string; options: Record<string, unknown> } | null = null;
  await act(async () => root.render(createElement(CreationWizard, { onCompose: (source, options) => { composed = { source, options }; } })));
  const type = async (label: string, value: string) => act(async () => {
    const input = div.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const setter = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(setter, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  return { div, type, click, get composed() { return composed; } };
}

it("plans from a goal, shows editable scenes and composes into the workbench", async () => {
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/plan") return Promise.resolve(Response.json({ plan: PLAN }));
    return Promise.resolve(Response.json({}));
  });
  vi.stubGlobal("fetch", fetcher);
  const view = await mount();
  await view.type("创作目标", "给咖啡店开业做一条 15 秒宣传");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(view.div.textContent).toContain("咖啡店开业");
  // The plan is data: editing a scene goal flows into composition.
  await view.type("镜头 2 目标", "核心卖点与到店礼");
  await view.click("用这个计划开始制作");
  expect(view.composed).not.toBeNull();
  expect(view.composed!.source).toContain("# 咖啡店开业");
  expect(view.composed!.source).toContain("## 核心卖点");
  expect(view.composed!.options).toMatchObject({ theme: "glint-dark", aspect: "16:9" });
  const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect(body).toMatchObject({ goal: "给咖啡店开业做一条 15 秒宣传", seconds: 15 });
});
it("surfaces a planning failure with the model message", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ error: "规划失败：模型超时" }, { status: 400 }))));
  const view = await mount();
  await view.type("创作目标", "任意目标");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(view.div.textContent).toContain("模型超时");
});
