// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerPlanPreview } from "./ContainerPlanPreview";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const reply = {
  version: 1 as const, projectId: "work", revision: 3, scope: "all" as const,
  impact: { totalNodes: 4, predicted: ["scene:s1", "scene:s2", "audio:mix", "container"], reusedCount: 0, estimatedMs: 1718, costCny: 0, costType: "quote-required" as const, quoteRequired: [{ nodeId: "scene:s2", sceneId: "s2" }], affectedObjects: ["doc-scene"] },
  timelineExports: [{ objectId: "doc-timeline", clips: 1, durationMs: 1500 }],
  unmappedIntents: [], notes: [],
};
async function mount(props: Record<string, unknown>, respond: () => Response) {
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/api/project/plan-preview") || init?.method !== "POST") throw new Error("unexpected request");
    return respond();
  });
  vi.stubGlobal("fetch", network);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(ContainerPlanPreview, props as never)); await tick(); });
  return { host, network };
}
// The preview fetches only when expanded: opening is the user's intent to see it.
async function expand(host: HTMLElement) {
  const details = host.querySelector<HTMLDetailsElement>("details.plan-preview");
  expect(details).toBeTruthy();
  await act(async () => {
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    await tick(); await tick();
  });
}

it("renders impact entries on expand: objects, nodes, time and cost type", async () => {
  const { host, network } = await mount({ projectId: "work", intent: { objectIds: ["doc-scene"] } }, () => Response.json(reply));
  expect(network).not.toHaveBeenCalled();
  await expand(host);
  expect(network.mock.calls[0]![0]).toBe("/api/project/plan-preview");
  expect(JSON.parse(String(network.mock.calls[0]![1]?.body))).toEqual({ projectId: "work", intent: { objectIds: ["doc-scene"] } });
  expect(network.mock.calls[0]![1]?.method).toBe("POST");
  expect(host.textContent).toContain("影响对象：1 个文档");
  expect(host.textContent).toContain("将重建 4 个节点，复用 0 个");
  expect(host.textContent).toContain("预计耗时约 2");
  expect(host.textContent).toContain("1 个 AIGC 镜头需先走媒体报价");
});

it("lists free local rendering and timeline export metrics without bias", async () => {
  const local = { ...reply, impact: { ...reply.impact, costType: "local-free" as const, quoteRequired: [] }, timelineExports: [{ objectId: "doc-timeline", clips: 3, durationMs: 4500 }] };
  const { host } = await mount({ projectId: "work" }, () => Response.json(local));
  await expand(host);
  expect(host.textContent).toContain("本地渲染");
  expect(host.textContent).toContain("3 个片段 · 时长 5 秒");
  expect(host.textContent).not.toContain("AIGC");
});

it("auto-expands for the preview-vs-actual line once the receipt carries a real elapsed time", async () => {
  const { host, network } = await mount({ projectId: "work", actualMs: 4200 }, () => Response.json(reply));
  await tick(); await tick();
  expect(host.querySelector<HTMLDetailsElement>("details.plan-preview")!.open).toBe(true);
  expect(network.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(host.textContent).toContain("预测 vs 实际");
  expect(host.textContent).toContain("导出实际耗时 4 秒");
});

it("degrades to a quiet note when the endpoint fails, and renders nothing without a project", async () => {
  const failing = await mount({ projectId: "work" }, () => Response.json({ error: "意图引用了不存在的镜头: ghost" }, { status: 400 }));
  await expand(failing.host);
  expect(failing.host.textContent).toContain("影响预览暂不可用");
  expect(failing.host.textContent).toContain("ghost");
  dispose();
  const empty = await mount({}, () => Response.json(reply));
  expect(empty.host.textContent).toBe("");
  expect(empty.network).not.toHaveBeenCalled();
});
