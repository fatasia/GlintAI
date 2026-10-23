// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ImportedPackLibrary } from "./ImportedPackLibrary";
import type { CreationPackInstance } from "@glintai/composer/creation-packs";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });
const pack = { format: "glint-creation-pack", version: 1, id: "community", packVersion: "1.0.0", title: "社区配方", description: "字卡配方", author: "Author", license: "MIT", tags: [], project: { schemaVersion: 1, id: "original", title: "Hello", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Hello", narration: { text: "Hello", durationMs: 1000 } }] } };
async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div), instances: CreationPackInstance[] = [];
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(ImportedPackLibrary, { onUse: instance => instances.push(instance) })));
  const click = async (text: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  const upload = async (value: unknown) => {
    const input = div.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = { name: "pack.json", size: 2000, text: async () => JSON.stringify(value) };
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  };
  return { div, instances, click, upload };
}
it("requires source/license consent, installs data-only recipe and creates a detached editable project", async () => {
  const h = await mount(); await h.upload(pack);
  expect(h.div.textContent).toContain("Author"); expect(h.div.textContent).toContain("MIT");
  await h.click("添加创作包"); expect(h.instances).toHaveLength(0);
  expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "添加创作包")!.disabled).toBe(true);
  await act(async () => h.div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await h.click("添加创作包"); expect(h.div.textContent).toContain("没有执行代码或联网");
  await h.click("用「社区配方」创作");
  expect(h.instances[0]!.project.creationPack).toEqual({ id: "community", version: "1.0.0" });
  expect(h.instances[0]!.project.id).not.toBe("original");
  await h.click("移除「社区配方」"); expect(h.div.textContent).toContain("已有工程不受影响");
  expect(h.instances[0]!.project.scenes[0]!.id).toBe("one");
});
it("upgrades an installed pack only after consent and keeps created projects untouched", async () => {
  const h = await mount();
  await h.upload(pack);
  await act(async () => h.div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await h.click("添加创作包");
  await h.upload({ ...pack, packVersion: "1.1.0", title: "社区配方 v2" });
  expect(h.div.textContent).toContain("已安装 v1.0.0");
  await act(async () => h.div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await h.click("更新到 v1.1.0");
  expect(h.div.textContent).toContain("更新到 v1.1.0");
  expect(h.div.textContent).toContain("已创建的工程不受影响");
  await h.upload({ ...pack, packVersion: "1.1.0", title: "社区配方 v2" });
  expect(h.div.textContent).toContain("相同版本不会重复添加");
  expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "更新到 v1.1.0")!.disabled).toBe(true);
});
it("rejects executable/media imports without adding them to storage or applying", async () => {
  const h = await mount(); await h.upload({ ...pack, permissions: ["execute"] });
  expect(h.div.querySelector('[role="alert"]')).not.toBeNull();
  expect(h.div.textContent).toContain("尚未导入创作包");
  expect(localStorage.getItem("glint.creation-packs.imported.v1")).toBeNull();
  expect(h.instances).toHaveLength(0);
});
