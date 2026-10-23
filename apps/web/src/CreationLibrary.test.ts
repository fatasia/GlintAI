// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { getCreationPack, type CreationPackInstance } from "@glintai/composer/creation-packs";
import { CreationLibrary } from "./CreationLibrary";

vi.mock("./ProjectPreview", () => ({ default: ({ project }: { project: { id: string } }) => createElement("div", { "data-testid": "pack-preview" }, project.id) }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
async function mount(disabled = false, reject = false) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  const instances: CreationPackInstance[] = [];
  await act(async () => root.render(createElement(CreationLibrary, { disabled, onUse: instance => {
    if (reject) throw new Error("当前工程备份失败");
    instances.push(instance);
  } })));
  const click = async (label: string) => { await act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === label)!.click()); };
  const select = async (id: string) => { await act(async () => [...div.querySelectorAll("button")].find(button => button.querySelector("strong")?.textContent === getCreationPack(id)!.title)!.click()); };
  const input = async (label: string, value: string) => {
    const element = div.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const consent = async () => { await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); };
  return { div, instances, click, select, input, consent };
}

describe("unified creation library", () => {
  it("searches by intended result, shows empty feedback, and never loads preview automatically", async () => {
    const h = await mount();
    expect(h.div.querySelector('[data-testid="pack-preview"]')).toBeNull();
    await h.input("搜索创作包", "not-a-real-pack-xyz");
    expect(h.div.textContent).toContain("没有找到匹配");
    await h.input("搜索创作包", "");
    await h.select("product-launch");
    expect(h.div.textContent).toContain("本地生成，无外部服务权限");
    expect(h.instances).toHaveLength(0);
  });
  it("previews actual entered values and requires consent before creating a unique pinned project", async () => {
    const h = await mount(); await h.select("product-launch");
    const pack = getCreationPack("product-launch")!;
    const product = pack.inputs.find(slot => slot.id === "productName")!;
    await h.input(product.label, "我的冰杯");
    await h.click("用这个创作"); expect(h.instances).toHaveLength(0);
    await h.click("先看无声预览");
    expect(h.div.querySelector('[data-testid="pack-preview"]')).not.toBeNull();
    await h.consent(); await h.click("用这个创作");
    expect(h.instances).toHaveLength(1);
    expect(JSON.stringify(h.instances[0]!.project)).toContain("我的冰杯");
    expect(parseProject(h.instances[0]!.project).creationPack).toEqual(h.instances[0]!.pack);
    expect(h.instances[0]!.project.id).not.toBe(pack.preview.projectId);
    expect(h.div.textContent).toContain("新的可编辑工程");
    await h.consent(); await h.click("用这个创作");
    expect(h.instances[1]!.project.id).not.toBe(h.instances[0]!.project.id);
  });
  it("does not create or hide errors for invalid values or failed host backup", async () => {
    const h = await mount(false, true); await h.select("product-launch");
    const product = getCreationPack("product-launch")!.inputs.find(slot => slot.id === "productName")!;
    await h.input(product.label, ""); await h.click("先看无声预览");
    expect(h.div.querySelector('[role="alert"]')).not.toBeNull();
    expect(h.div.querySelector('[data-testid="pack-preview"]')).toBeNull();
    await h.input(product.label, "真实商品"); await h.consent(); await h.click("用这个创作");
    expect(h.instances).toHaveLength(0); expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("备份失败");
  });
  it("disables creation during existing work", async () => {
    const h = await mount(true); await h.select("product-launch");
    expect(h.div.querySelector("fieldset")).toBeNull();
    expect(h.instances).toHaveLength(0);
  });
});
