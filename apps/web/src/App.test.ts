// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { useAuthoringVisible } from "./authoring-visibility";

const lifecycle = vi.hoisted(() => ({ mounts: {} as Record<string, number>, unmounts: {} as Record<string, number> }));
function Panel({ name, onClose, active }: { name: string; onClose?(): void; active?: boolean }) {
  const visibleAuthoring = useAuthoringVisible();
  const [edits, setEdits] = useState(0);
  useEffect(() => {
    lifecycle.mounts[name] = (lifecycle.mounts[name] ?? 0) + 1;
    return () => { lifecycle.unmounts[name] = (lifecycle.unmounts[name] ?? 0) + 1; };
  }, [name]);
  return createElement("section", { "aria-label": `${name}内容`, "data-active": active, "data-authoring-visible": visibleAuthoring },
    createElement("button", { onClick: () => setEdits(value => value + 1) }, `修改${name}`),
    createElement("output", null, `${name}修改 ${edits}`),
    onClose && createElement("button", { onClick: onClose }, "返回首页"));
}
vi.mock("./IdeaStudio", () => ({ IdeaStudio: () => createElement(Panel, { name: "项目" }) }));
vi.mock("./OfflineStatus", () => ({ OfflineStatus: () => null }));
vi.mock("./MediaWorkshop", () => ({ MediaWorkshop: () => createElement(Panel, { name: "素材" }) }));
vi.mock("./BrandStudio", () => ({ BrandStudio: () => createElement(Panel, { name: "品牌" }) }));
vi.mock("./VoiceReview", () => ({ VoiceReview: () => createElement(Panel, { name: "声音" }) }));
vi.mock("./PersonaLibrary", () => ({ PersonaLibrary: () => createElement(Panel, { name: "画像" }) }));
vi.mock("./UnderstandingCheck", () => ({ UnderstandingCheck: () => createElement(Panel, { name: "理解检查" }) }));
vi.mock("./GenCanvasBoard", () => ({ GenCanvasBoard: () => createElement(Panel, { name: "画布" }) }));
vi.mock("./SkillCatalog", () => ({ SkillCatalog: () => createElement(Panel, { name: "技能" }) }));
vi.mock("./BatchWorkshop", () => ({ BatchWorkshop: () => createElement(Panel, { name: "批量" }) }));
vi.mock("./ModelSettings", () => ({ ModelSettings: () => createElement(Panel, { name: "模型" }) }));
vi.mock("./NleEditor", () => ({ NleEditor: ({ onClose, active }: { onClose(): void; active: boolean }) => createElement(Panel, { name: "剪辑", onClose, active }) }));
vi.mock("./DocsPage", () => ({ default: () => createElement("div", { className: "docs-page" }, "使用文档正文") }));
vi.mock("./ProjectPreview", () => ({ default: () => createElement("div", null, "示例播放器") }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let dispose = () => {};
beforeEach(() => {
  lifecycle.mounts = {}; lifecycle.unmounts = {};
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ available: false })));
});
afterEach(() => {
  dispose(); dispose = () => {};
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div);
  dispose = () => { act(() => root.unmount()); div.remove(); };
  await act(async () => { root.render(createElement(App)); await tick(); });
  return div;
}
function button(div: HTMLElement, label: string) {
  const found = [...div.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  if (!found) throw new Error(`没有找到按钮：${label}`);
  return found;
}
async function click(div: HTMLElement, label: string) {
  await act(async () => { button(div, label).click(); await tick(); });
}
async function hash(value: string) {
  await act(async () => { window.location.hash = value; window.dispatchEvent(new HashChangeEvent("hashchange")); await tick(); });
}
function visible(element: Element | null) { return Boolean(element && !element.closest("[hidden]")); }
function panel(div: HTMLElement, name: string) { return div.querySelector(`[aria-label="${name}内容"]`); }
// Example tools are a lazy chunk so they stay out of the first screen; wait for it like any lazy workspace.
async function loadExamples() { await act(async () => { await import("./ExampleTools"); await tick(); }); }
async function openExamples(div: HTMLElement) { await click(div, "素材"); await click(div, "示例与高级"); await loadExamples(); }
// Help links and appearance moved from a page footer into the rail's help popover
// (a lazy chunk, portalled to body).
async function openHelp(div: HTMLElement) {
  await click(div, "帮助");
  await act(async () => { await import("./shell/HelpPopover"); await tick(); });
  return document.body;
}
async function question(div: HTMLElement, value: string) {
  const input = div.querySelector<HTMLInputElement>('[aria-label="对示例提问"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

it("keeps hidden workspaces hidden even when navigation uses an explicit grid display", () => {
  const css = document.createElement("style");
  css.textContent = readFileSync(resolve(process.cwd(), "apps/web/src/app-navigation.css"), "utf8");
  document.head.appendChild(css);
  const shell = document.createElement("div");
  shell.className = "app-shell app-navigation"; shell.hidden = true;
  const page = document.createElement("div"); page.className = "workspace-page"; page.hidden = true;
  shell.appendChild(page); document.body.appendChild(shell);
  try {
    expect(getComputedStyle(shell).display).toBe("none");
    expect(getComputedStyle(page).display).toBe("none");
  } finally { shell.remove(); css.remove(); }
});

it("shows a directly editable project and clear navigation without mounting tools or repeating a home CTA", async () => {
  localStorage.setItem("glint.chat-history", "保留历史聊天");
  const div = await mount();
  expect(visible(panel(div, "项目"))).toBe(true);
  expect(lifecycle.mounts).toEqual({ 项目: 1 });
  expect(div.querySelector('[aria-label="主导航"]')?.textContent).toBe("项目素材自动化");
  expect(div.textContent).not.toContain("展开工具");
  expect(div.querySelector("main [aria-label='项目链接']")).toBeNull();
  expect([...div.querySelectorAll("button")].filter(item => item.textContent === "剪辑台")).toHaveLength(1);
  expect(localStorage.getItem("glint.chat-history")).toBe("保留历史聊天");
  await click(div, "素材");
  expect(visible(div.querySelector("#tool-tab-create"))).toBe(true);
  expect(visible(panel(div, "素材"))).toBe(true);
  expect(lifecycle.mounts).toEqual({ 项目: 1, 素材: 1 });
});

it("keeps project, media, brand, voice, automation and settings state across every navigation family", async () => {
  const div = await mount(); const project = panel(div, "项目");
  await click(div, "修改项目");
  await click(div, "素材"); await click(div, "修改素材");
  await click(div, "品牌与声音"); await click(div, "修改品牌"); await click(div, "修改声音");
  await click(div, "自动化"); await click(div, "修改画布");
  await click(div, "技能目录"); await click(div, "修改技能");
  await click(div, "批量混剪"); await click(div, "修改批量");
  await click(div, "设置"); await click(div, "修改模型");
  expect(visible(panel(div, "模型"))).toBe(true);
  await click(div, "素材");
  expect(visible(panel(div, "品牌"))).toBe(true);
  expect(panel(div, "品牌")?.textContent).toContain("品牌修改 1");
  expect(panel(div, "声音")?.textContent).toContain("声音修改 1");
  await click(div, "素材工坊"); expect(panel(div, "素材")?.textContent).toContain("素材修改 1");
  await click(div, "自动化"); expect(visible(panel(div, "批量"))).toBe(true);
  await click(div, "生成画布"); expect(panel(div, "画布")?.textContent).toContain("画布修改 1");
  await click(div, "技能目录"); expect(panel(div, "技能")?.textContent).toContain("技能修改 1");
  await click(div, "项目");
  expect(panel(div, "项目")).toBe(project);
  expect(project?.textContent).toContain("项目修改 1");
  expect(lifecycle.unmounts).toEqual({});
  expect(Object.values(lifecycle.mounts).every(count => count === 1)).toBe(true);
});

it("项目隐藏于其他工作区、剪辑台或文档时暂停执行面，但不卸载项目状态", async () => {
  const div = await mount(), project = panel(div, "项目") as HTMLElement;
  await click(div, "修改项目"); expect(project.dataset.authoringVisible).toBe("true");
  for (const tab of ["素材", "自动化", "设置"]) {
    await click(div, tab); expect(project.dataset.authoringVisible).toBe("false");
    await click(div, "项目"); expect(project.dataset.authoringVisible).toBe("true");
  }
  await click(div, "剪辑台"); expect(project.dataset.authoringVisible).toBe("false");
  // The edit area is a regular rail destination now; leaving it is a normal navigation.
  await click(div, "项目"); expect(project.dataset.authoringVisible).toBe("true");
  await act(async () => { window.location.hash = "/docs"; window.dispatchEvent(new HashChangeEvent("hashchange")); await tick(); });
  expect(project.dataset.authoringVisible).toBe("false");
  await act(async () => { window.location.hash = ""; window.dispatchEvent(new HashChangeEvent("hashchange")); await tick(); });
  expect(project.dataset.authoringVisible).toBe("true"); expect(panel(div, "项目")).toBe(project);
  expect(project.textContent).toContain("项目修改 1"); expect(lifecycle.unmounts.项目).toBeUndefined();
});

it("keeps NLE mounted after closing and preserves all workspaces while entering NLE or docs", async () => {
  const div = await mount(); await click(div, "修改项目");
  await click(div, "剪辑台"); await click(div, "修改剪辑");
  const nle = panel(div, "剪辑");
  expect(visible(panel(div, "项目"))).toBe(false);
  expect(visible(nle)).toBe(true);
  expect(nle?.getAttribute("data-active")).toBe("true");
  await hash("#/docs/install");
  expect(nle?.getAttribute("data-active")).toBe("false");
  expect(visible(div.querySelector(".docs-page"))).toBe(true);
  expect(div.querySelector(".app-shell")?.hasAttribute("hidden")).toBe(true);
  expect(lifecycle.unmounts).toEqual({});
  await hash("#studio"); await click(div, "返回首页");
  expect(visible(nle)).toBe(false);
  expect(nle?.getAttribute("data-active")).toBe("false");
  expect(panel(div, "项目")?.textContent).toContain("项目修改 1");
  await click(div, "剪辑台");
  expect(panel(div, "剪辑")).toBe(nle);
  expect(nle?.textContent).toContain("剪辑修改 1");
  expect(nle?.getAttribute("data-active")).toBe("true");
  await click(div, "素材");
  expect(visible(nle)).toBe(false);
  expect(nle?.getAttribute("data-active")).toBe("false");
  expect(visible(panel(div, "素材"))).toBe(true);
  expect(lifecycle.unmounts).toEqual({});
});

it("keeps docs routing, local download links and theme persistence without destructive storage writes", async () => {
  localStorage.setItem("glint:theme", "light");
  localStorage.setItem("glint.workspace", "project draft");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ available: true })));
  window.history.replaceState(null, "", "/#/docs/model");
  const div = await mount();
  expect(visible(div.querySelector(".docs-page"))).toBe(true);
  expect(document.documentElement.dataset.theme).toBe("light");
  await hash("#studio");
  const help = await openHelp(div);
  expect(help.querySelector('[aria-label="项目链接"] a[download]')?.getAttribute("href")).toBe("/api/download/client");
  await act(async () => { help.querySelector<HTMLButtonElement>('[aria-label="切换深色主题"]')!.click(); });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("glint:theme")).toBe("dark");
  expect(localStorage.getItem("glint.workspace")).toBe("project draft");
});

it("falls back to release downloads when the status API is offline", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
  const div = await mount();
  const help = await openHelp(div);
  expect(help.querySelector('[aria-label="项目链接"] a:last-child')?.getAttribute("href")).toContain("/releases");
  await click(div, "素材"); expect(visible(panel(div, "素材"))).toBe(true);
  await click(div, "项目"); expect(visible(panel(div, "项目"))).toBe(true);
});

it("opens the command palette with Ctrl/⌘+K, runs a navigation command, and toggles shut again", async () => {
  const div = await mount();
  const press = (init: KeyboardEventInit) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); await tick(); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await press({ key: "k", ctrlKey: true });
  await act(async () => { await import("./shell/CommandPalette"); await tick(); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === "品牌与声音")!;
  await act(async () => { option.click(); await tick(); await tick(); });
  expect(window.location.hash).toBe("#/library/brand");
  expect(visible(panel(div, "品牌"))).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await press({ key: "k", metaKey: true });
  await act(async () => { await tick(); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await press({ key: "k", metaKey: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await press({ key: "k", ctrlKey: true, shiftKey: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("restores the area and tab from the address and remembers the last tab per area", async () => {
  window.history.replaceState(null, "", "/#/automation/batch");
  const div = await mount();
  expect(visible(panel(div, "批量"))).toBe(true);
  expect(div.querySelector('[aria-current="page"]')?.textContent).toBe("自动化");
  await click(div, "设置");
  expect(window.location.hash).toBe("#/settings");
  await hash("#/library/brand");
  expect(visible(panel(div, "品牌"))).toBe(true);
  await click(div, "自动化");
  expect(window.location.hash).toBe("#/automation/batch");
  await hash("#/p/..%2Fescape");
  expect(visible(panel(div, "项目"))).toBe(true);
});

it("supports manual keyboard tab activation with arrow, Home and End focus navigation", async () => {
  const div = await mount(); await click(div, "素材");
  const first = div.querySelector<HTMLButtonElement>("#tool-tab-create")!;
  first.focus();
  await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(document.activeElement?.id).toBe("tool-tab-brand");
  expect(first.getAttribute("aria-selected")).toBe("true");
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  expect(document.activeElement?.id).toBe("tool-tab-examples");
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  expect(document.activeElement).toBe(first);
  await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  expect(document.activeElement?.id).toBe("tool-tab-examples");
  await click(div, "示例与高级"); await loadExamples();
  expect(visible(panel(div, "理解检查"))).toBe(true);
  expect(visible(panel(div, "画像"))).toBe(true);
  expect(lifecycle.mounts.技能).toBeUndefined();
});

it("retains an in-flight example question and its answer when switching workspaces", async () => {
  let resolveAnswer!: (value: Response) => void;
  const fetcher = vi.fn((url: string) => url === "/api/ask" ? new Promise<Response>(resolve => { resolveAnswer = resolve; }) : Promise.resolve(Response.json({ available: false })));
  vi.stubGlobal("fetch", fetcher);
  const div = await mount(); await openExamples(div); await question(div, "熵增的前提？"); await click(div, "提问");
  expect(button(div, "思考中…").disabled).toBe(true);
  await click(div, "自动化");
  const answer = { answer: "需要明确系统边界。", refused: false, refusalReason: null, citations: [] };
  await act(async () => { resolveAnswer(new Response(`data: ${JSON.stringify({ type: "done", answer })}\n\n`, { headers: { "content-type": "text/event-stream" } })); await tick(); });
  await click(div, "素材");
  expect(visible(div.querySelector(".qa-answer"))).toBe(true);
  expect(div.querySelector(".qa-answer")?.textContent).toContain("需要明确系统边界");
  expect(div.querySelector<HTMLInputElement>('[aria-label="对示例提问"]')?.value).toBe("熵增的前提？");
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/ask")).toHaveLength(1);
  await click(div, "熵与生命 · 中文");
  expect(div.querySelector(".qa-answer")?.textContent).toContain("需要明确系统边界");
});

it("does not submit blank or IME Enter questions and can recover from API failure", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/ask" ? new Response("offline", { status: 503 }) : Response.json({ available: false })));
  const div = await mount(); await openExamples(div);
  expect(button(div, "提问").disabled).toBe(true);
  const input = await question(div, "还有资料吗？");
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/ask")).toHaveLength(0);
  await click(div, "提问");
  expect(div.querySelector('[role="alert"]')?.textContent).toContain("HTTP 503");
  expect(button(div, "提问").disabled).toBe(false);
  await click(div, "提问");
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/ask")).toHaveLength(2);
});

it("cancels a stale question when changing examples, without removing advanced tools", async () => {
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url !== "/api/ask") return Promise.resolve(Response.json({ available: false }));
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }));
  const div = await mount(); await openExamples(div); await question(div, "待取消的问题"); await click(div, "提问");
  await click(div, "Uncertainty Principle · English");
  expect(signal?.aborted).toBe(true);
  expect(button(div, "提问").disabled).toBe(false);
  expect(div.querySelector(".qa-answer")).toBeNull();
  expect(visible(panel(div, "理解检查"))).toBe(true);
  expect(visible(panel(div, "画像"))).toBe(true);
});

it("opens a container route lazily without mounting the legacy project session", async () => {
  window.history.replaceState(null, "", "/#/c");
  const div = await mount();
  await act(async () => { await import("./ContainerWorkspace"); await tick(); });
  expect(div.querySelector('[aria-label="统一作品"]')).not.toBeNull();
  expect(lifecycle.mounts["项目"] ?? 0).toBe(0);
  expect(div.textContent).toContain("导入为新副本");
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/session/"))).toBe(false);
});
