// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { buildTimeline } from "@glintai/scenescript";
import { RenderSummary, encodingLabel, ttsCost } from "./RenderSummary";
import { parseEditorProject } from "./editor-model";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const project = parseEditorProject({
  schemaVersion: 1,
  id: "summary-test",
  title: "预检测试",
  aspect: "16:9",
  knowledgeSources: [],
  scenes: [
    { id: "one", kind: "title", title: "One", narration: { text: "第一句" } },
    { id: "two", kind: "definition", term: "Two", definition: "第二句", narration: { text: "第二句" } },
  ],
});

let dispose = () => {};
afterEach(() => {
  dispose();
});

async function mount(element: ReturnType<typeof createElement>) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  dispose = () => {
    act(() => root.unmount());
    div.remove();
  };
  await act(async () => {
    root.render(element);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return div;
}

function Harness({ engine, disabled = false }: { engine: string; disabled?: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  return createElement(RenderSummary, {
    project,
    tts: engine,
    encoding: "draft",
    confirmed,
    disabled,
    onConfirmationChange: setConfirmed,
  });
}

it("classifies every configured engine without inventing prices", () => {
  expect(ttsCost("mock")).toMatchObject({ kind: "silent", requiresConfirmation: false });
  expect(ttsCost("mock").label).toContain("免费");
  expect(ttsCost("sapi")).toMatchObject({ kind: "local", requiresConfirmation: false });
  expect(ttsCost("qwen")).toMatchObject({ kind: "local", requiresConfirmation: false });
  const edge = ttsCost("edge");
  expect(edge.kind).toBe("edge");
  expect(edge.label).toContain("免费");
  expect(edge.label).toContain("联网");
  expect(edge.detail).toContain("联网");
  expect(edge.requiresConfirmation).toBe(false);
  for (const engine of ["openai", "elevenlabs", "fish", "minimax", "gateway"]) {
    const cost = ttsCost(engine);
    expect(cost.kind).toBe("paid");
    expect(cost.label).toContain("可能计费");
    expect(cost.detail).toContain("本机未配置价格表，费用由服务商决定");
    expect(cost.requiresConfirmation).toBe(true);
  }
  expect(ttsCost("unknown-engine")).toMatchObject({ kind: "paid", requiresConfirmation: true });
});

it("renders scene count, buildTimeline duration and the chosen options", async () => {
  const div = await mount(createElement(RenderSummary, {
    project, tts: "edge", encoding: "balanced", confirmed: false, onConfirmationChange: () => {},
  }));
  const summary = div.querySelector('[aria-label="出片前预检"]')!;
  expect(summary.querySelector('[aria-label="分镜数"]')!.textContent).toBe("2 个");
  expect(summary.querySelector('[aria-label="预计总时长"]')!.textContent).toBe(`${(buildTimeline(project).totalMs / 1000).toFixed(1)} 秒`);
  expect(summary.querySelector('[aria-label="配音引擎"]')!.textContent).toBe("Edge 配音 · 联网");
  expect(summary.querySelector('[aria-label="导出规格"]')!.textContent).toBe("均衡 · 全尺寸 / CRF20");
  expect(summary.querySelector('[aria-label="费用状态"]')!.textContent).toBe("免费：Edge 配音，但会联网");
  expect(summary.textContent).toContain("联网");
  expect(summary.querySelector('[aria-label="我确认可能产生费用"]')).toBeNull();
  expect(encodingLabel("unknown")).toBe("unknown");
});

it("shows an honest unknown summary before a project is composed", async () => {
  const div = await mount(createElement(RenderSummary, {
    project: null, tts: "mock", encoding: "draft", confirmed: false, onConfirmationChange: () => {},
  }));
  const summary = div.querySelector('[aria-label="出片前预检"]')!;
  expect(summary.querySelector('[aria-label="分镜数"]')!.textContent).toBe("待编排");
  expect(summary.querySelector('[aria-label="预计总时长"]')!.textContent).toBe("待编排");
  expect(summary.textContent).toContain("提交后按输入资料编排");
});

it("requires a real checkbox confirmation only for possibly billable engines", async () => {
  const div = await mount(createElement(Harness, { engine: "openai" }));
  const checkbox = div.querySelector<HTMLInputElement>('[aria-label="我确认可能产生费用"]')!;
  expect(checkbox.checked).toBe(false);
  expect(div.textContent).toContain("未勾选确认时，制作按钮保持禁用");
  await act(async () => { checkbox.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox.checked).toBe(true);
  expect(div.textContent).not.toContain("未勾选确认时，制作按钮保持禁用");
  await act(async () => { checkbox.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(checkbox.checked).toBe(false);
});

it("does not require or render confirmation for a free mock path", async () => {
  const div = await mount(createElement(Harness, { engine: "mock" }));
  expect(div.querySelector('[aria-label="我确认可能产生费用"]')).toBeNull();
  expect(div.querySelector('[aria-label="费用状态"]')!.textContent).toBe("免费：无声草稿（mock）");
});
