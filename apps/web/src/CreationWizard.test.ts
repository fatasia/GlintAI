// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CreationWizard } from "./CreationWizard";
import type { VideoPlan } from "@glintai/composer/plan";
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
  let composed: { source: string; options: Record<string, unknown>; plan: VideoPlan } | null = null;
  await act(async () => root.render(createElement(CreationWizard, { onCompose: (source, options, plan) => { composed = { source, options, plan }; } })));
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

it("edits duration and shot order before submitting the structured plan", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: PLAN }))));
  const view = await mount();
  await view.type("创作目标", "新的发布视频"); await view.click("生成计划");
  await view.type("镜头 1 时长", "5");
  expect(view.div.textContent).toContain("11s");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="上移镜头 2"]')!.click());
  expect(view.div.querySelector<HTMLInputElement>('[aria-label="镜头 1 目标"]')!.value).toBe("核心卖点");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="复制镜头 1"]')!.click());
  expect(view.div.querySelectorAll("li")).toHaveLength(3);
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="删除镜头 2"]')!.click());
  await view.click("用这个计划开始制作");
  expect(view.composed!.options).not.toHaveProperty("template");
  expect(view.composed!.plan.totalSeconds).toBe(11);
  expect(view.composed!.plan.scenes.map(scene => scene.seconds)).toEqual([6, 5]);
  expect(view.composed!.plan.scenes.map(scene => scene.kind)).toEqual(["bullets", "title"]);
  expect(view.composed!.source.indexOf("核心卖点")).toBeLessThan(view.composed!.source.indexOf("开场钩子"));
});
it("rejects invalid plans from the model rather than crashing the editor", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: { scenes: [] } }))));
  const view = await mount(); await view.type("创作目标", "新的发布视频"); await view.click("生成计划");
  expect(view.div.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.div.querySelectorAll("li")).toHaveLength(0);
});

it("restores the draft from localStorage on the next visit", async () => {
  const fetcher = vi.fn(() => Promise.resolve(Response.json({ plan: PLAN })));
  vi.stubGlobal("fetch", fetcher);
  const first = await mount();
  await first.type("创作目标", "给咖啡店开业做一条 15 秒宣传");
  await first.type("素材要点", "周六开业 前 50 位送一杯");
  await first.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  // A fresh mount (page refresh) restores both the goal and the plan.
  const second = await mount();
  expect(second.div.querySelector<HTMLTextAreaElement>('[aria-label="创作目标"]')!.value).toBe("给咖啡店开业做一条 15 秒宣传");
  expect(second.div.querySelector<HTMLTextAreaElement>('[aria-label="素材要点"]')!.value).toBe("周六开业 前 50 位送一杯");
  expect(second.div.textContent).toContain("咖啡店开业");
  expect(second.div.textContent).toContain("已恢复上次草稿");
});

it("keeps a corrupt draft from crashing the wizard", async () => {
  localStorage.setItem("glint:wizard-draft:v1", "{not json");
  const view = await mount();
  expect(view.div.querySelector<HTMLTextAreaElement>('[aria-label="创作目标"]')!.value).toBe("");
});

it("passes the optional budget to the plan API and persists it across a refresh (CREATE-02)", async () => {
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/plan") return Promise.resolve(Response.json({ plan: { ...PLAN, budgetCny: 500 } }));
    return Promise.resolve(Response.json({}));
  });
  vi.stubGlobal("fetch", fetcher);
  const first = await mount();
  await first.type("创作目标", "预算内短片");
  await first.type("制作预算", "500");
  await first.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect(body.budgetCny).toBe(500);
  // A fresh mount (page refresh) restores the budget alongside the goal.
  const second = await mount();
  expect(second.div.querySelector<HTMLInputElement>('[aria-label="制作预算"]')!.value).toBe("500");
  // Empty budget stays undefined in the API body, never 0 or NaN.
  await second.type("制作预算", "");
  await second.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const lastCall = JSON.parse(String((fetcher.mock.calls[fetcher.mock.calls.length - 1] as unknown as [string, RequestInit])[1].body));
  expect(lastCall.budgetCny).toBeUndefined();
});

it("degrades to session-only drafting when storage is full and recovers later (CREATE-06)", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: PLAN }))));
  const view = await mount();
  await view.type("创作目标", "配额验证");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(view.div.textContent).toContain("草稿已自动保存");
  // Quota exhausted: the wizard keeps working, the draft just stops persisting.
  const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("exceeded the quota", "QuotaExceededError"); });
  await view.type("创作目标", "配额验证之后继续编辑");
  expect(view.div.textContent).toContain("本地存储不可用，草稿仅本次浏览保留");
  expect(view.div.textContent).toContain("配额验证之后继续编辑"); // editing still works
  quota.mockRestore();
  await view.type("创作目标", "配额恢复后再编辑");
  expect(view.div.textContent).toContain("草稿已自动保存");
  expect(JSON.parse(localStorage.getItem("glint:wizard-draft:v1")!).goal).toBe("配额恢复后再编辑");
});

it("blocks image shots with an actionable path instead of a server rejection", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: { ...PLAN, scenes: [...PLAN.scenes, { goal: "招牌", narration: "看图", visual: "门店照片", seconds: 3, kind: "image" as const }] } }))));
  const view = await mount();
  await view.type("创作目标", "含图片镜头的计划"); await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await view.click("用这个计划开始制作");
  expect(view.composed).toBeNull();
  expect(view.div.textContent).toContain("镜头 3 需要先绑定真实素材");
});

it("reuses one requestId while the plan is unchanged and rotates it after edits", async () => {
  const fetcher = vi.fn((url: string) => {
    if (url === "/api/plan") return Promise.resolve(Response.json({ plan: PLAN }));
    return Promise.resolve(Response.json({ project: { schemaVersion: 1, id: "p", title: "t", aspect: "16:9", scenes: [] } }));
  });
  vi.stubGlobal("fetch", fetcher);
  const requests: string[] = [];
  let composed: (() => void) | null = null;
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(CreationWizard, { onCompose: async (_source, _options, _plan, requestId) => { requests.push(requestId); } })));
  const type = async (label: string, value: string) => act(async () => {
    const input = div.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const setter = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(setter, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  await type("创作目标", "目标");
  await click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await click("用这个计划开始制作");
  await click("用这个计划开始制作");
  await type("镜头 1 目标", "改过的目标");
  await click("用这个计划开始制作");
  expect(requests).toHaveLength(3);
  expect(requests[0]).toBe(requests[1]);
  expect(requests[2]).not.toBe(requests[0]);
  void composed;
});

it("keeps alternative plans side by side for comparison instead of replacing them", async () => {
  const alt = { ...PLAN, title: "版本二", scenes: [{ ...PLAN.scenes[0], narration: "换一个开场。", seconds: 4 }, PLAN.scenes[1]] };
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: call++ === 0 ? PLAN : alt }))));
  const view = await mount();
  await view.type("创作目标", "对比两个方案");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(view.div.textContent).toContain("咖啡店开业");
  // Regenerating appends a comparable option; the first one is still reachable.
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(view.div.textContent).toContain("方案 2/2");
  expect(view.div.textContent).toContain("版本二");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="上一个方案"]')!.click());
  expect(view.div.textContent).toContain("咖啡店开业");
  // Editing one option never leaks into the other.
  await view.type("镜头 1 口播", "只改这个方案");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="下一个方案"]')!.click());
  expect(view.div.textContent).toContain("换一个开场。");
  // Composing submits the option currently on screen.
  await view.click("用这个计划开始制作");
  expect(view.composed!.plan.title).toBe("版本二");
  // Dropping the current option leaves the remaining one selected.
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="删除当前方案"]')!.click());
  expect(view.div.textContent).toContain("咖啡店开业");
});

it("restores a dropped plan intact through the undo-drop control (CREATE-03)", async () => {
  const alt = { ...PLAN, title: "版本二", scenes: [{ ...PLAN.scenes[0], narration: "版本二独有的开场。", seconds: 4 }, PLAN.scenes[1]] };
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: call++ === 0 ? PLAN : alt }))));
  const view = await mount();
  await view.type("创作目标", "丢弃与撤销");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  // Version 2 is on screen; editing marks it before the drop.
  await view.type("镜头 1 口播", "版本二独有的开场。改后");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="删除当前方案"]')!.click());
  expect(view.div.textContent).not.toContain("版本二");
  expect(view.div.textContent).not.toContain("方案 2");
  // The dropped variant comes back in its original slot with the edit intact.
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="撤销丢弃方案"]')!.click());
  expect(view.div.textContent).toContain("方案 2/2");
  expect(view.div.textContent).toContain("版本二独有的开场。改后");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="上一个方案"]')!.click());
  expect(view.div.textContent).toContain("这条街最香的开业，就在周六。");
});

it("keeps plan edits isolated across switches (CREATE-03)", async () => {
  const alt = { ...PLAN, title: "版本二", scenes: [{ ...PLAN.scenes[0], narration: "另一版开场。" }, { ...PLAN.scenes[1], seconds: 9 }] };
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: call++ === 0 ? PLAN : alt }))));
  const view = await mount();
  await view.type("创作目标", "独立性验证");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  // Edit plan 1's timing, then leave and come back: the edit survives.
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="上一个方案"]')!.click());
  await view.type("镜头 1 时长", "5");
  expect(view.div.textContent).toContain("11s");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="下一个方案"]')!.click());
  expect(view.div.textContent).toContain("12s"); // plan 2 untouched (3 + 9)
  // Plan 2 still shows its own copy, not plan 1's edited or original text.
  expect(view.div.querySelector<HTMLInputElement>('[aria-label="镜头 1 口播"]')!.value).toBe("另一版开场。");
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="上一个方案"]')!.click());
  expect(view.div.textContent).toContain("11s");
  await view.click("用这个计划开始制作");
  expect(view.composed!.plan.scenes.map(scene => scene.seconds)).toEqual([5, 6]);
});

it("keeps at most five plans, dropping the oldest (CREATE-03)", async () => {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ plan: { ...PLAN, title: `方案${++call}` } }))));
  const view = await mount();
  await view.type("创作目标", "上限验证");
  for (let index = 0; index < 6; index++) {
    await view.click("生成计划");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  expect(view.div.textContent).toContain("方案 5/5");
  expect(view.div.textContent).toContain("方案6"); // newest survives
  expect(view.div.textContent).not.toContain("方案1"); // oldest was trimmed
});

it("plays a zero-cost storyboard preview without calling any API", async () => {
  const fetcher = vi.fn(() => Promise.resolve(Response.json({ plan: PLAN })));
  vi.stubGlobal("fetch", fetcher);
  const view = await mount();
  await view.type("创作目标", "试片验证");
  await view.click("生成计划");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await view.click("▶ 播放试片（零成本）");
  const stage = view.div.querySelector('[aria-label="分镜试片"]')!;
  expect(stage.textContent).toContain("镜头 1/2");
  expect(stage.textContent).toContain("门店外观，人流");
  // CREATE-08 visual planner badges follow the staged shot.
  const badges = stage.querySelector('[aria-label="视觉规划"]')!;
  expect(badges.textContent).toContain("居中");
  expect(badges.textContent).toContain("推进");
  // Manual stepping moves between shots; no fetch beyond /api/plan happened.
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="暂停试片"]')!.click());
  await act(async () => view.div.querySelector<HTMLButtonElement>('[aria-label="下一个镜头"]')!.click());
  expect(stage.textContent).toContain("镜头 2/2");
  expect(view.div.querySelector('[aria-label="视觉规划"]')!.textContent).toContain("层级");
  // CREATE-08: the wizard exposes per-shot visual planning with an automatic fallback.
  const group = view.div.querySelector('[aria-label="镜头 2 视觉规划"]')!;
  const layoutSelect = group.querySelector<HTMLSelectElement>('[aria-label="镜头 2 布局"]')!;
  expect(layoutSelect.value).toBe("");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(layoutSelect, "grid-2");
    layoutSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const after = view.div.querySelector('[aria-label="视觉规划"]')!;
  expect(after.textContent).toContain("两栏");
  expect(fetcher).toHaveBeenCalledTimes(1);
  // The preview closes cleanly; the button is found by its visible text.
  await act(async () => [...view.div.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "关闭")!.click());
  expect(view.div.querySelector('[aria-label="分镜试片"]')).toBeNull();
});
