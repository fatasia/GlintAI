// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RecipeGallery } from "./RecipeGallery";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
it("shows 100 recipes, filters them, and hands a recipe to the composer", async () => {
  const used = vi.fn();
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(RecipeGallery, { onUse: used })));
  expect(div.querySelectorAll("article")).toHaveLength(100);
  const search = div.querySelector<HTMLInputElement>('[aria-label="搜索模板"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "咖啡");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(div.querySelectorAll("article").length).toBeGreaterThan(0);
  expect(div.querySelectorAll("article").length).toBeLessThan(100);
  const action = [...div.querySelectorAll<HTMLButtonElement>("article button")].find(button => button.textContent === "用这个开始")!;
  await act(async () => action.click());
  expect(used).toHaveBeenCalledTimes(1);
  expect(used.mock.calls[0]![0].title).toContain("咖啡");
});
