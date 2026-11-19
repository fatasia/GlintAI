// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { describeProposal, NleProposal } from "./NleProposal";
import { createNleSession } from "./nle-session";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {}; afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const base = parseNleProject({ schemaVersion: 1, id: "demo", title: "片子", fps: 30, width: 1280, height: 720, tracks: [{ id: "t1", kind: "text", name: "字幕", clips: [{ id: "a", kind: "text", text: "原文", startMs: 0, durationMs: 1000 }] }] });
const next = parseNleProject({ ...base, tracks: [{ ...base.tracks[0], clips: [{ ...base.tracks[0]!.clips[0], text: "新文", durationMs: 2000 }] }] });
it("describes actual before and after values in replay order", () => {
  expect(describeProposal(base, next)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "tracks / 0 / clips / 0 / text", before: "原文", after: "新文" }), expect.objectContaining({ before: 1000, after: 2000 })]));
  const session = createNleSession(base); expect(session.apply(next, "提案").ok).toBe(true); expect(session.undo()).toBe(true); expect(session.document()).toEqual(base);
});
it("refuses modification or movement of locked tracks", () => {
  const locked = parseNleProject({ ...base, tracks: [{ ...base.tracks[0], locked: true }] });
  expect(() => describeProposal(locked, next)).toThrow(/锁定/);
});
it("previews before applying, rejects stale results and can cancel", async () => {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), apply = vi.fn(() => true);
  cleanup = () => act(() => root.unmount());
  const render = async (project = base) => act(async () => root.render(createElement(NleProposal, { project, onApply: apply })));
  await render();
  const input = div.querySelector<HTMLInputElement>('input[type="file"]')!;
  const choose = async () => act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [{ size: 100, text: async () => JSON.stringify(next) }] }); input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  await choose(); expect(document.body.textContent).toContain("原值：原文"); expect(document.body.textContent).toContain("新值：新文"); expect(apply).not.toHaveBeenCalled();
  await render({ ...base, title: "较新编辑" });
  expect([...document.body.querySelectorAll("button")].find(item => item.textContent === "应用修改")!.disabled).toBe(true);
  await act(async () => [...document.body.querySelectorAll("button")].find(item => item.textContent === "取消")!.click()); expect(apply).not.toHaveBeenCalled();
  await render(); await choose(); await act(async () => [...document.body.querySelectorAll("button")].find(item => item.textContent === "应用修改")!.click());
  expect(apply).toHaveBeenCalledWith(next);
});
it("requires consent and previews AI text without applying it, with stale protection", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), apply = vi.fn(() => true);
  cleanup = () => act(() => root.unmount());
  const render = async (project = base) => act(async () => root.render(createElement(NleProposal, { project, onApply: apply })));
  await render();
  const input = div.querySelector<HTMLInputElement>('input[aria-label="时间线文字修改要求"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "精简"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const generate = [...div.querySelectorAll("button")].find(item => item.textContent === "生成文字提案")!;
  expect(generate.disabled).toBe(true);
  await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => generate.click()); expect(fetcher).toHaveBeenCalledTimes(1);
  await render({ ...base, title: "较新编辑" });
  const textOnly = parseNleProject({ ...base, tracks: [{ ...base.tracks[0], clips: [{ ...base.tracks[0]!.clips[0], text: "新文" }] }] });
  await act(async () => { resolve(Response.json({ project: textOnly })); await Promise.resolve(); });
  expect(document.body.textContent).toContain("原值：原文"); expect(document.body.textContent).toContain("新值：新文");
  expect([...document.body.querySelectorAll("button")].find(item => item.textContent === "应用修改")!.disabled).toBe(true); expect(apply).not.toHaveBeenCalled();
});
it("cancels an in-flight proposal and ignores a late response", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), apply = vi.fn(() => true);
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(NleProposal, { project: base, onApply: apply })));
  const input = div.querySelector<HTMLInputElement>('input[aria-label="时间线文字修改要求"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "改时间"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...div.querySelectorAll("button")].find(item => item.textContent === "生成文字提案")!.click());
  await act(async () => [...div.querySelectorAll("button")].find(item => item.textContent === "取消生成")!.click());
  await act(async () => { resolve(Response.json({ project: next })); await Promise.resolve(); });
  expect(document.querySelector('[aria-label="修改差异预览"]')).toBeNull(); expect(apply).not.toHaveBeenCalled();
});
it("rejects a server response that extends past the captured timeline", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ project: next })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), apply = vi.fn(() => true);
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(NleProposal, { project: base, onApply: apply })));
  const input = div.querySelector<HTMLInputElement>('input[aria-label="时间线文字修改要求"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "延长"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => { [...div.querySelectorAll("button")].find(item => item.textContent === "生成文字提案")!.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(div.textContent).toContain("原时间轴范围"); expect(document.querySelector('[aria-label="修改差异预览"]')).toBeNull(); expect(apply).not.toHaveBeenCalled();
});

it("keeps consent across identical shared snapshots but invalidates it for content or instruction changes", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  const render = async (project = base) => act(async () => root.render(createElement(NleProposal, { project, onApply: () => true })));
  await render();
  const input = div.querySelector<HTMLInputElement>('input[aria-label="时间线文字修改要求"]')!;
  const setInstruction = async (text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const checkbox = div.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await setInstruction("改字幕"); await act(async () => checkbox.click()); expect(checkbox.checked).toBe(true);
  await render(structuredClone(base)); expect(checkbox.checked).toBe(true);
  await render({ ...base, title: "真实改名" }); expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click()); expect(checkbox.checked).toBe(true);
  await setInstruction("改颜色"); expect(checkbox.checked).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});
it("marks a late model response stale after a real shared project change", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div), apply = vi.fn(() => true);
  cleanup = () => act(() => root.unmount());
  const render = async (project = base) => act(async () => root.render(createElement(NleProposal, { project, onApply: apply })));
  await render(); const input = div.querySelector<HTMLInputElement>('input[aria-label="时间线文字修改要求"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "改字幕"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === "生成文字提案")!.click());
  await render({ ...base, title: "另一入口更新" });
  const valid = { ...base, tracks: [{ ...base.tracks[0], clips: [{ ...base.tracks[0]!.clips[0], text: "新文" }] }] };
  await act(async () => { resolve(Response.json({ project: valid })); await Promise.resolve(); });
  expect(document.querySelector('[aria-label="修改差异预览"]')?.textContent).toContain("提案已过期");
  expect([...document.body.querySelectorAll("button")].find(button => button.textContent === "应用修改")!.disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});
