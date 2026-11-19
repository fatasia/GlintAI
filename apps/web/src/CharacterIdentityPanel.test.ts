// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { CharacterIdentityPanel } from "./CharacterIdentityPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {}; afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
const initial = parseProject({ schemaVersion: 1, id: "drama", title: "短剧", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "开场", narration: { text: "台词" } },
  { id: "two", kind: "title", title: "下一镜", narration: { text: "下一句" } },
] });

it("creates and approves a character, then binds only the selected shot", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ assets: [{ name: "hero.png" }, { name: "sound.wav" }] })); vi.stubGlobal("fetch", fetcher);
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); let current: SceneScriptProject = initial;
  cleanup = () => act(() => root.unmount());
  function Harness() { const [value, setValue] = useState(initial); current = value; return createElement(CharacterIdentityPanel, { project: value, sceneId: "one", onChange: setValue, canApprove: true, onApprove: async (id: string) => { const hash = "a".repeat(64), refs = [`assets/approved-${hash}.png`]; setValue({ ...value, assets: value.assets!.map(asset => asset.id !== id ? asset : { ...asset, refs, approval: { version: asset.version, name: asset.name, description: asset.description!, voice: asset.voice!, refs, refSha256: hash } }) }); return true; } }); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { const panel = div.querySelector("details")!; panel.open = true; panel.dispatchEvent(new Event("toggle")); });
  await act(async () => { await Promise.resolve(); });
  const input = async (label: string, value: string, type: "input" | "textarea" | "select" = "input") => act(async () => {
    const el = div.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    const prototype = type === "input" ? HTMLInputElement.prototype : type === "textarea" ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(type === "select" ? "change" : "input", { bubbles: true }));
  });
  const click = async (label: string) => act(async () => [...div.querySelectorAll("button")].find(item => item.textContent === label)!.click());
  await input("角色名称", "小雨"); await input("角色外观", "短发和蓝色外套", "textarea"); await input("角色音色", "voice-a"); await input("角色参考图", "hero.png", "select");
  await click("保存角色草稿"); expect(current.assets![0]).toMatchObject({ name: "小雨", refs: ["assets/hero.png"], voice: "voice-a" });
  await input("角色外观", "还没保存的新外观", "textarea");
  expect([...div.querySelectorAll("button")].find(item => item.textContent === "批准角色版本")!.disabled).toBe(true);
  await input("角色外观", "短发和蓝色外套", "textarea");
  await click("批准角色版本"); expect(current.assets![0]!.approval).toMatchObject({ voice: "voice-a" });
  expect(div.querySelector<HTMLInputElement>('[aria-label="角色名称"]')!.closest("fieldset")!.disabled).toBe(true);
  expect(div.textContent).not.toContain("草稿有未保存修改");
  expect(div.querySelector<HTMLSelectElement>('[aria-label="角色参考图"]')!.value).toBe(`approved-${"a".repeat(64)}.png`);
  await click("绑定当前镜头并设置音色");
  expect(current.scenes[0]).toMatchObject({ assetRefs: [{ assetId: current.assets![0]!.id, version: "v1" }], narration: { voice: "voice-a" } });
  expect(current.scenes[1]).toEqual(initial.scenes[1]);
  expect(fetcher.mock.calls.every(([url]) => String(url) === "/api/media/library")).toBe(true);
});


it.each(["character", "product"] as const)("selecting new %s creates a distinct draft and preserves the approved version", async kind => {
  const label = kind === "character" ? "角色" : "商品", hash = "a".repeat(64), ref = `assets/approved-${hash}.png`;
  const asset = { id: "old", kind, name: "原资产", version: "v1", description: "描述", ...(kind === "character" ? { voice: "voice-a" } : {}), refs: [ref] };
  const start = parseProject({ ...initial, assets: [{ ...asset, approval: { name: asset.name, version: asset.version, description: asset.description, ...(kind === "character" ? { voice: "voice-a" } : {}), refs: [ref], refSha256: hash } }] });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ assets: [] })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); let current = start;
  cleanup = () => act(() => root.unmount());
  function Harness() { const [value, setValue] = useState(start); current = value; return createElement(CharacterIdentityPanel, { kind, project: value, sceneId: "one", onChange: setValue }); }
  await act(async () => root.render(createElement(Harness)));
  const select = div.querySelector<HTMLSelectElement>(`[aria-label="选择${label}资产"]`)!;
  await act(async () => { select.value = "old"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const name = div.querySelector<HTMLInputElement>(`[aria-label="${label}名称"]`)!;
  expect(name.value).toBe(""); expect(name.closest("fieldset")!.disabled).toBe(false);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "新资产"); name.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === `保存${label}草稿`)!.click());
  expect(current.assets).toHaveLength(2); expect(current.assets![0]).toEqual(start.assets![0]); expect(current.assets![1]!.id).not.toBe("old");
});


it("approves a product and binds it without changing the scene voice", async () => {
  const hash = "c".repeat(64), pinned = `approved-${hash}.png`;
  const start = parseProject({ ...initial, assets: [{ id: "item", kind: "product", name: "商品", version: "v1", description: "红色", refs: ["assets/item.png"] }], scenes: [{ ...initial.scenes[0]!, narration: { text: "台词", voice: "original" } }, initial.scenes[1]!] });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ assets: [{ name: "item.png" }, { name: pinned }] })));
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); let current = start;
  cleanup = () => act(() => root.unmount());
  const approve = vi.fn(async (id: string) => { update(previous => ({ ...previous, assets: previous.assets!.map(asset => asset.id !== id ? asset : { ...asset, refs: [`assets/${pinned}`], approval: { name: asset.name, version: asset.version, description: asset.description!, refs: [`assets/${pinned}`], refSha256: hash } }) })); return true; });
  let update!: React.Dispatch<React.SetStateAction<SceneScriptProject>>;
  function Harness() { const [value, setValue] = useState(start); current = value; update = setValue; return createElement(CharacterIdentityPanel, { kind: "product", project: value, sceneId: "one", onChange: setValue, canApprove: true, onApprove: approve }); }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => { const panel = div.querySelector("details")!; panel.open = true; panel.dispatchEvent(new Event("toggle")); });
  const select = div.querySelector<HTMLSelectElement>('[aria-label="选择商品资产"]')!;
  await act(async () => { select.value = "item"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const button = (text: string) => [...div.querySelectorAll("button")].find(item => item.textContent === text)!;
  expect(button("批准商品版本").disabled).toBe(false);
  await act(async () => button("批准商品版本").click());
  expect(approve).toHaveBeenCalledWith("item"); expect(div.textContent).not.toContain("草稿有未保存修改");
  expect(div.querySelector<HTMLSelectElement>('[aria-label="商品参考图"]')!.value).toBe(pinned);
  await act(async () => button("绑定商品到当前镜头").click());
  expect(current.scenes[0]).toMatchObject({ assetRefs: [{ assetId: "item", version: "v1" }], narration: { voice: "original" } });
  expect(current.scenes[1]).toEqual(start.scenes[1]);
});
