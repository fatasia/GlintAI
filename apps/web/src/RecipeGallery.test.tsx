// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RecipeGallery } from "./RecipeGallery";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
const setup = async () => {
  const used = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(RecipeGallery, { onUse: used })));
  return { used, div };
};
const type = (node: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });

it("shows 100 recipes, filters them, and hands a recipe to the composer", async () => {
  const { used, div } = await setup();
  expect(div.querySelectorAll("article")).toHaveLength(100);
  const search = div.querySelector<HTMLInputElement>('[aria-label="搜索模板"]')!;
  await type(search, "咖啡");
  expect(div.querySelectorAll("article").length).toBeGreaterThan(0);
  expect(div.querySelectorAll("article").length).toBeLessThan(100);
  const action = [...div.querySelectorAll<HTMLButtonElement>("article button")].find(button => button.textContent === "用这个开始")!;
  await act(async () => action.click());
  expect(used).toHaveBeenCalledTimes(1);
  // "咖啡" matches via description/tags; the first hit is the 门店开业 family whose
  // sample text is the coffee-shop worked example.
  expect(used.mock.calls[0]![0].title).toContain("门店开业");
  expect(used.mock.calls[0]![0].sample).toContain("咖啡");
});

it("opens a detail dialog, lets the user rewrite the starting text, and hands the edit through", async () => {
  const { used, div } = await setup();
  const firstCard = div.querySelector<HTMLButtonElement>('article button[aria-label$="查看详情"]')!;
  await act(async () => firstCard.click());
  const dialog = div.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-label")).toBe(`${firstCard.getAttribute("aria-label")!.replace(" 查看详情", "")} 详情`);
  const text = dialog.querySelector<HTMLTextAreaElement>('[aria-label="起始文本"]')!;
  expect(text.value.length).toBeGreaterThan(0);
  await type(text, "我自己的开头文本");
  const useInDialog = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "用这个开始")!;
  await act(async () => useInDialog.click());
  expect(used).toHaveBeenCalledTimes(1);
  expect(used.mock.calls[0]![0].sample).toBe("我自己的开头文本");
  expect(div.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps the original sample when the dialog text is left blank", async () => {
  const { used, div } = await setup();
  const firstCard = div.querySelector<HTMLButtonElement>('article button[aria-label$="查看详情"]')!;
  const title = firstCard.getAttribute("aria-label")!.replace(" 查看详情", "");
  await act(async () => firstCard.click());
  const dialog = div.querySelector('[role="dialog"]')!;
  const text = dialog.querySelector<HTMLTextAreaElement>('[aria-label="起始文本"]')!;
  await type(text, "   ");
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "用这个开始")!.click());
  const recipe = used.mock.calls[0]![0];
  expect(recipe.title).toBe(title);
  // Blank input must not hand an empty idea through to the composer.
  expect(recipe.sample.trim().length).toBeGreaterThan(10);
});

it("Escape closes the detail dialog without consuming the recipe", async () => {
  const { used, div } = await setup();
  await act(async () => div.querySelector<HTMLButtonElement>('article button[aria-label$="查看详情"]')!.click());
  expect(div.querySelector('[role="dialog"]')).toBeTruthy();
  await act(async () => {
    div.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(div.querySelector('[role="dialog"]')).toBeNull();
  expect(used).not.toHaveBeenCalled();
});
