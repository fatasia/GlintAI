// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { buildDesignPreview, DESIGN_BRIDGE, readDesignBridgeMessage } from "./design-editor-bridge";
import { DesignPreview, DesignThumb } from "./design-editor-preview";
import type { BrandTheme } from "./design-brand";
import { AuthoringVisibility } from "./authoring-visibility";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const source = {} as Window;
const read = (data: Record<string, unknown>, sender = source, generation = "g") => readDesignBridgeMessage({ source: sender, data: { type: DESIGN_BRIDGE, generation: "g", ...data } } as MessageEvent, source, generation);

it("严格验证批注节点与图钉 action，丢弃不属于 action 的数据", () => {
  for (const nodeId of [null, {}, [], 1, "", "bad id!", "x".repeat(101)]) expect(read({ action: "comment", x: 10, y: 20, nodeId })).toBeUndefined();
  for (const x of [NaN, Infinity, -1, 101, "10"]) expect(read({ action: "comment", x, y: 20 })).toBeUndefined();
  expect(read({ action: "comment", x: 10, y: 20, nodeId: "hero-1" })).toMatchObject({ nodeId: "hero-1" });
  expect(read({ action: "comment", x: 10, y: 20 })).toMatchObject({ x: 10, y: 20 });
  expect(read({ action: "annotation", annotationId: "a1", nodeId: {} })).toEqual({ type: DESIGN_BRIDGE, generation: "g", action: "annotation", annotationId: "a1" });
  for (const annotationId of [null, {}, [], "", "x".repeat(2001)]) expect(read({ action: "annotation", annotationId })).toBeUndefined();
  expect(read({ action: "ready", nodeId: {}, code: "eval" })).toEqual({ type: DESIGN_BRIDGE, generation: "g", action: "ready" });
  expect(read({ action: "gesture", nodeId: "hero", nodeIds: ["hero"], dx: 0, dy: 1, height: 2 })).toBeUndefined();
  expect(read({ action: "comment", x: 1, y: 2 }, {} as Window)).toBeUndefined();
  expect(read({ action: "annotation", annotationId: "a1" }, source, "new")).toBeUndefined();
});

it("保留双层沙箱与网络 CSP，不把用户 HTML 或批注写回源文件", () => {
  const html = '<h1 data-design-id="hero">标题</h1><script>window.inline=true</script>';
  const outer = new DOMParser().parseFromString(buildDesignPreview(html, "g", false, {}, true), "text/html");
  const child = new DOMParser().parseFromString(outer.querySelector("iframe")!.srcdoc, "text/html");
  expect(outer.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts");
  expect(outer.querySelector("meta")!.content).toContain("frame-src 'self'");
  expect(child.querySelector("meta")!.content).toContain("frame-src 'none'");
  for (const doc of [outer, child]) expect(doc.querySelector("meta")!.content).toContain("connect-src 'none'");
  expect(child.querySelector("h1")!.textContent).toBe("标题");
  expect(html).not.toContain("data-design-overlay");
});

it("品牌独立更新会刷新 generation；图钉更新不重载 child；仅当前图钉调用编辑回调", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  const brand: BrandTheme = { name: "品牌", accent: "#123456", bg: "#ffffff", text: "#111111" };
  const onAnnotation = vi.fn(), onMessage = vi.fn(), mark = { id: "a1", x: 20, y: 30, text: "修改", createdAt: 1 };
  const render = async (accent: string, annotations = [mark]) => act(async () => root.render(createElement(DesignPreview, { html: "<h1>内容</h1>", viewport: "desktop", interactive: false, selected: [], brand: { ...brand, accent }, annotations, onMessage, onAnnotation })));
  await render(brand.accent); const frame = host.querySelector("iframe")!, first = frame.dataset.designGeneration;
  expect(frame.srcdoc).toContain("#123456"); await render("#654321");
  expect(frame.srcdoc).toContain("#654321"); expect(frame.dataset.designGeneration).not.toBe(first);
  const generation = frame.dataset.designGeneration, post = vi.spyOn(frame.contentWindow!, "postMessage");
  await render("#654321", [{ ...mark, text: "新意见" }]);
  const current = frame.dataset.designGeneration;
  expect(current).toBe(generation);
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: DESIGN_BRIDGE, generation: current, action: "ready" } })));
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ action: "annotations", annotations: [expect.objectContaining({ text: "新意见" })] }), "*");
  const send = async (id: string, g = current, sender = frame.contentWindow) => act(async () => window.dispatchEvent(new MessageEvent("message", { source: sender, data: { type: DESIGN_BRIDGE, generation: g, action: "annotation", annotationId: id } })));
  await send("unknown"); await send("a1", first); await send("a1", current, window); expect(onAnnotation).not.toHaveBeenCalled();
  await send("a1"); expect(onAnnotation).toHaveBeenCalledTimes(1); expect(onAnnotation).toHaveBeenCalledWith("a1");
  expect(host.querySelector(".design-pin")).toBeNull();
});

it("比较缩略图固定文档视口并响应品牌和视口参数", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); dispose = () => act(() => root.unmount());
  const render = async (accent: string, viewport: "desktop" | "slides") => act(async () => root.render(createElement(DesignThumb, { html: "<h1>页面</h1>", title: "缩略图", viewport, brand: { name: "品牌", accent, bg: "#ffffff", text: "#111111" } })));
  await render("#123456", "desktop"); const frame = host.querySelector("iframe")!;
  expect(frame.style.width).toBe("1280px"); expect(frame.style.height).toBe("800px"); expect(frame.tabIndex).toBe(-1);
  expect(frame.srcdoc).toContain("#123456"); await render("#654321", "slides");
  expect(frame.style.height).toBe("720px"); expect(frame.srcdoc).toContain("#654321");
});

it("隐藏任一父工作区即销毁预览和缩略图执行面，重新进入后拒绝旧消息并恢复相同源码", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host); dispose = () => act(() => root.unmount());
  const html = '<main data-design-id="hero">保留正文<script>setInterval(()=>{},1)</script><video autoplay loop></video></main>', onMessage = vi.fn();
  const render = async (outer: boolean, inner: boolean) => act(async () => root.render(createElement(AuthoringVisibility, { active: outer, children:
    createElement(AuthoringVisibility, { active: inner, children: [
      createElement(DesignPreview, { key: "preview", html, viewport: "desktop", interactive: true, selected: ["hero"], onMessage }),
      createElement(DesignThumb, { key: "thumb", html, title: "方向缩略图" }),
    ] }),
  })));
  await render(true, true);
  const old = host.querySelector<HTMLIFrameElement>('iframe[title="设计预览"]')!, sender = old.contentWindow, generation = old.dataset.designGeneration;
  expect(host.querySelectorAll("iframe")).toHaveLength(2);
  const clear = vi.spyOn(globalThis, "clearInterval");
  await render(true, false); expect(host.querySelectorAll("iframe")).toHaveLength(0); expect(clear).toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: sender, data: { type: DESIGN_BRIDGE, generation, action: "ready" } })));
  expect(onMessage).not.toHaveBeenCalled();
  await render(false, true); expect(host.querySelectorAll("iframe")).toHaveLength(0);
  await render(true, true);
  const current = host.querySelector<HTMLIFrameElement>('iframe[title="设计预览"]')!;
  expect(current).not.toBe(old); expect(current.dataset.designGeneration).not.toBe(generation);
  expect(current.srcdoc).toContain("保留正文"); expect(current.getAttribute("sandbox")).toBe("allow-scripts");
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: current.contentWindow, data: { type: DESIGN_BRIDGE, generation, action: "ready" } })));
  expect(onMessage).not.toHaveBeenCalled();
});

it("navigation validates target identity and does not accept foreign windows or generations",()=>{
 expect(read({action:"navigate",pageId:"details"})).toMatchObject({action:"navigate",pageId:"details"});
 for(const pageId of [null,{},""," ","x".repeat(201)])expect(read({action:"navigate",pageId})).toBeUndefined();
 expect(read({action:"navigate",pageId:"details"},{} as Window)).toBeUndefined();
 expect(read({action:"navigate",pageId:"details"},source,"old")).toBeUndefined();
});
