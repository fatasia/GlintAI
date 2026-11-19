// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCenter } from "./TaskCenter";
import type { CenterTask, TaskFamily } from "./task-center-client";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const row = (id = "one", family: TaskFamily = "media"): CenterTask => ({
  family,
  id,
  state: "running",
  isFinal: false,
  createdAt: null,
  cost: { amount: 0.5, unit: null },
});
const page = (tasks = [row()]) => ({ tasks, truncated: false, unreadable: 0 });
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(TaskCenter)));
  return host;
}
async function observe(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    check();
  });
}
async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}
it("loads task history without polling and requires confirmation before supported cancellation", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET" });
    return Response.json(
      url === "/api/tasks" ? page() : { taskId: "one", state: "cancelled", isFinal: true },
    );
  });
  const host = await mount();
  await observe(() => expect(host.textContent).toContain("单位未知"));
  expect(calls).toHaveLength(1);
  expect(host.textContent).not.toContain("¥");
  await click(host, "取消任务");
  expect(calls).toHaveLength(1);
  expect(host.textContent).toContain("上游仍可能完成并计费");
  await click(host, "确认取消");
  await observe(() => expect(host.textContent).toContain("取消请求已发出"));
  expect(calls.filter((call) => call.method === "POST")).toEqual([
    { url: "/api/media/cancel/one", method: "POST" },
  ]);
  await click(host, "恢复状态");
  await observe(() => expect(host.textContent).toContain("已取消本地任务"));
  expect(
    [...host.querySelectorAll("button")].some((button) => button.textContent === "取消任务"),
  ).toBe(false);
  expect(calls.some((call) => call.url.includes("submit"))).toBe(false);
});
it("shows unknown costs and truthful Comfy queue outcomes without marking completion", async () => {
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(
      url === "/api/tasks"
        ? page([{ ...row("comfy-one", "comfyui"), cost: { amount: null, unit: null } }])
        : { taskId: "comfy-one", outcome: "not-queued" },
    ),
  );
  const host = await mount();
  await observe(() => expect(host.textContent).toContain("费用回执未知"));
  await click(host, "取消任务");
  expect(host.textContent).toContain("已运行的任务不保证停止");
  await click(host, "确认取消");
  await observe(() => expect(host.textContent).toContain("未确认停止"));
  expect(host.textContent).toContain("执行中");
  expect(host.textContent).not.toContain("已完成");
});
it("recovers saved render status and derives the result link without a new submission", async () => {
  const network = vi.fn(async (url: string) =>
    Response.json(
      url === "/api/tasks" ? page([row("idea-one", "render")]) : { id: "idea-one", status: "done" },
    ),
  );
  vi.stubGlobal("fetch", network);
  const host = await mount();
  await observe(() => expect(host.textContent).toContain("idea-one"));
  await click(host, "恢复状态");
  await observe(() => expect(host.querySelector('a[href="/api/video/idea-one"]')).not.toBeNull());
  expect(network).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("已完成");
});
it("offers retry after failure and reports truncated or unreadable history", async () => {
  let count = 0;
  vi.stubGlobal("fetch", async () =>
    ++count === 1
      ? new Response("failed", { status: 500 })
      : Response.json({ ...page([]), truncated: true, unreadable: 2 }),
  );
  const host = await mount();
  await observe(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  await click(host, "刷新列表");
  await observe(() => expect(host.textContent).toContain("还没有任务"));
  expect(host.textContent).toContain("当前列表不代表全部历史");
  expect(host.textContent).toContain("原文件未改动");
});
it("aborts late actions on unmount and never rewrites task identities to local storage", async () => {
  let resolve: ((value: Response) => void) | undefined;
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (url === "/api/tasks") return Promise.resolve(Response.json(page()));
    signal = init.signal as AbortSignal;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  try {
    const host = await mount();
    await observe(() => expect(host.textContent).toContain("one"));
    await click(host, "恢复状态");
    dispose();
    dispose = () => {};
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      resolve?.(Response.json({ taskId: "one", state: "success", isFinal: true })),
    );
    expect(storage).not.toHaveBeenCalled();
  } finally {
    storage.mockRestore();
  }
});
