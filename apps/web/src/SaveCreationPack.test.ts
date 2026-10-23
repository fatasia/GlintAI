// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { materializeImportedPack, parseImportedPack } from "@glintai/composer/imported-packs";
import { SaveCreationPack } from "./SaveCreationPack";
import { readImportedPacks } from "./imported-pack-store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => {
  cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
function fixture(): SceneScriptProject {
  return parseProject({ schemaVersion: 1, id: "source", title: "我的讲解", aspect: "16:9", knowledgeSources: [],
    creationPack: { id: "previous", version: "1.0.0" },
    scenes: [{ id: "opening", kind: "title", title: "Hello", notes: "PRIVATE_WORKING_NOTES", narration: { text: "Edited narration", durationMs: 1000 } }],
  });
}
async function mount(project = fixture()) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), saved = vi.fn(); cleanup = () => act(() => root.unmount());
  const render = async (next: SceneScriptProject) => act(async () => root.render(createElement(SaveCreationPack, { project: next, onSaved: saved })));
  await render(project);
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  const consent = async () => act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const input = async (label: string, value: string) => {
    const element = [...div.querySelectorAll("label")].find(item => item.textContent === label)!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const open = async () => act(async () => div.querySelector("summary")!.click());
  return { div, saved, click, consent, input, open, render };
}
function downloads() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const createObjectURL = vi.fn((_blob: Blob) => "blob:portable-pack"), revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, click };
}

it("starts closed, gates both actions on consent, then installs a valid recipe materialized with its new origin pin", async () => {
  const project = fixture(), before = structuredClone(project), h = await mount(project);
  expect(h.div.querySelector("details")!.open).toBe(false);
  await h.open(); expect(h.div.querySelector("details")!.open).toBe(true);
  const fields = h.div.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])');
  expect([...fields].map(field => field.value)).toEqual([project.title, "", "仅供本人使用", "1.0.0"]);
  await h.input("作者", "Ada");
  await h.click("保存到创作库"); await h.click("下载创作包 JSON");
  expect(readImportedPacks()).toEqual([]); expect(h.saved).not.toHaveBeenCalled();
  expect([...h.div.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  await h.consent(); await h.input("创作包名称", "编辑后的配方"); await h.input("版本", "2.3.4");
  await h.click("保存到创作库");
  const [pack] = readImportedPacks();
  expect(pack).toMatchObject({ id: expect.stringMatching(/^creation-[a-f0-9-]{36}$/), title: "编辑后的配方", author: "Ada", license: "仅供本人使用", packVersion: "2.3.4", description: "编辑后的配方 的可编辑配方", tags: [] });
  expect(JSON.stringify(pack)).not.toContain("PRIVATE_WORKING_NOTES");
  expect(h.div.querySelector('[role="status"]')?.textContent).toContain("保存到本机创作库");
  expect(h.saved).toHaveBeenCalledTimes(1);
  const instance = materializeImportedPack(pack!, { projectId: "new-editable" });
  expect(instance.project.creationPack).toEqual({ id: pack!.id, version: "2.3.4" });
  expect(instance.project.scenes[0]!.narration.text).toBe("Edited narration");
  expect(project).toEqual(before);
  await h.click("保存到创作库");
  expect(new Set(readImportedPacks().map(item => item.id)).size).toBe(2);
  await act(async () => h.div.querySelector("details")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(h.div.querySelector("details")!.open).toBe(false);
});

it("downloads validated JSON through the existing helper, without installing or disclosing private notes", async () => {
  const h = await mount(), d = downloads();
  await h.open(); await h.input("作者", "Ada"); await h.consent(); await h.click("下载创作包 JSON");
  expect(d.createObjectURL).toHaveBeenCalledTimes(1); expect(d.click).toHaveBeenCalledTimes(1);
  const blob = d.createObjectURL.mock.calls[0]![0] as unknown as Blob;
  const reading = new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob);
  });
  await vi.runAllTimersAsync();
  const text = await reading;
  const pack = parseImportedPack(JSON.parse(text));
  expect(pack.project.scenes[0]!.narration.text).toBe("Edited narration");
  expect(text).not.toContain("PRIVATE_WORKING_NOTES"); expect(blob.type).toBe("application/json");
  expect((d.click.mock.contexts[0] as unknown as HTMLAnchorElement).download).toBe(`${pack.id}.creation-pack.json`);
  expect(readImportedPacks()).toEqual([]); expect(h.saved).not.toHaveBeenCalled();
  expect(h.div.querySelector('[role="status"]')?.textContent).toContain("未添加到本机创作库");
  vi.runAllTimers(); expect(d.revokeObjectURL).toHaveBeenCalledWith("blob:portable-pack");
});

it.each(["image", "audio", "assets", "music", "sfx", "external"])("refuses %s without changing the original or creating any partial pack", async kind => {
  const project = fixture();
  if (kind === "image") project.scenes = [{ id: "image", kind: "image", src: "assets/photo.png", narration: { text: "Keep image" } }];
  if (kind === "audio") project.scenes[0]!.narration.audioRef = "assets/voice.mp3";
  if (kind === "assets") project.assets = [];
  if (kind === "music") project.music = { src: "assets/music.mp3" };
  if (kind === "sfx") project.sfx = [];
  if (kind === "external") project.knowledgeSources = [{ id: "source", kind: "markdown", name: "https://example.com" }];
  const before = structuredClone(project), h = await mount(project), d = downloads();
  await h.open(); await h.input("作者", "Ada"); await h.consent();
  for (const action of ["保存到创作库", "下载创作包 JSON"]) {
    await h.click(action);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("不会自动删减内容");
    expect(h.div.querySelector('[role="status"]')).toBeNull();
  }
  expect(readImportedPacks()).toEqual([]); expect(h.saved).not.toHaveBeenCalled();
  expect(d.createObjectURL).not.toHaveBeenCalled(); expect(project).toEqual(before);
});

it("does not claim success on quota failure, and still allows an independent download", async () => {
  const project = fixture(), before = structuredClone(project), h = await mount(project), d = downloads();
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  await h.open(); await h.input("作者", "Ada"); await h.consent(); await h.click("保存到创作库");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("未保存到创作库");
  expect(h.div.querySelector('[role="status"]')).toBeNull(); expect(h.saved).not.toHaveBeenCalled();
  expect(readImportedPacks()).toEqual([]); expect(d.createObjectURL).not.toHaveBeenCalled();
  await h.click("下载创作包 JSON"); expect(d.createObjectURL).toHaveBeenCalledTimes(1);
  expect(h.div.querySelector('[role="alert"]')).toBeNull(); expect(h.saved).not.toHaveBeenCalled();
  setItem.mockRestore(); expect(project).toEqual(before);
});

it("validates author, declared license and stable version, then recovers without losing input", async () => {
  const h = await mount(); await h.open(); await h.consent(); await h.click("保存到创作库");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("作者");
  await h.input("作者", "Ada"); await h.input("使用许可（自行声明）", ""); await h.click("保存到创作库");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("使用许可");
  await h.input("使用许可（自行声明）", "CC BY 4.0"); await h.input("版本", "01.0.0"); await h.click("保存到创作库");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("三段数字"); expect(readImportedPacks()).toEqual([]);
  await h.input("版本", "1.0.0"); await h.click("保存到创作库");
  expect(readImportedPacks()[0]).toMatchObject({ author: "Ada", license: "CC BY 4.0" });
  expect(h.div.querySelector('[role="alert"]')).toBeNull(); expect(h.saved).toHaveBeenCalledTimes(1);
});

it("rejects oversized names and unavailable secure IDs without saving", async () => {
  const h = await mount(); await h.open(); await h.input("作者", "Ada"); await h.consent();
  await h.input("创作包名称", "x".repeat(121)); await h.click("保存到创作库");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("120 个字符");
  await h.input("创作包名称", "我的配方"); vi.stubGlobal("crypto", undefined); await h.click("保存到创作库");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("安全的创作包 ID");
  expect(readImportedPacks()).toEqual([]); expect(h.saved).not.toHaveBeenCalled();
});

it("reports download failure without installing, and resets consent when switching projects", async () => {
  const h = await mount(), d = downloads();
  d.createObjectURL.mockImplementation(() => { throw new Error("blocked"); });
  await h.open(); await h.input("作者", "Ada"); await h.consent(); await h.click("下载创作包 JSON");
  expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("检查浏览器下载权限");
  expect(h.saved).not.toHaveBeenCalled(); expect(readImportedPacks()).toEqual([]);
  await h.render({ ...fixture(), id: "next-project", title: "另一个工程" });
  expect(h.div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(h.div.querySelector<HTMLInputElement>("input")!.value).toBe("另一个工程");
  expect(h.div.querySelector('[role="alert"]')).toBeNull();
});
