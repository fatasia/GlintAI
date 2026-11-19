// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrandStudio } from "./BrandStudio";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(BrandStudio)));
  const type = async (label: string, value: string) => act(async () => {
    const input = div.querySelector<HTMLInputElement | HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { div, type };
}

it("previews the merged brand swatch live through the CSS-variable pipeline", async () => {
  const h = await mount();
  await h.type("品牌名", "山茶");
  await h.type("强调色 accent 十六进制", "#e0533d");
  await h.type("背景 bg 十六进制", "#1a1214");
  const swatch = h.div.querySelector('[aria-label="品牌色卡"]')!;
  expect(swatch.getAttribute("style")).toContain("rgb(26, 18, 20)");
  expect(h.div.querySelector('[aria-label="品牌 CSS 变量"]')!.textContent).toContain("--glint-color-accent: #e0533d");
  expect(h.div.querySelector('[role="alert"]')).toBeNull();
});

it("surfaces AA contrast warnings for an illegible brand without blocking editing", async () => {
  const h = await mount();
  await h.type("品牌名", "低对比");
  await h.type("背景 bg 十六进制", "#f5f5f5");
  await h.type("正文 text 十六进制", "#eeeeee");
  const alert = h.div.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("低于 AA");
  // The swatch still previews (advisory, never blocking).
  expect(h.div.querySelector('[aria-label="品牌色卡"]')).toBeTruthy();
});

it("rejects garbage hex with a validation issue and no swatch", async () => {
  const h = await mount();
  await h.type("强调色 accent 十六进制", "red");
  expect(h.div.textContent).toContain("#RRGGBB");
  expect(h.div.querySelector('[aria-label="品牌色卡"]')).toBeNull();
});

it("downloads a valid brand.json", async () => {
  const h = await mount();
  await h.type("品牌名", "山茶");
  const clicks: string[] = [];
  const anchor = { href: "", download: "", click: () => clicks.push(anchor.download) } as unknown as HTMLAnchorElement;
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => tag === "a" ? anchor : original(tag)) as typeof document.createElement);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  await act(async () => [...h.div.querySelectorAll("button")].find(button => button.textContent === "下载 brand.json")!.click());
  expect(clicks).toEqual(["brand.json"]);
  // The pack written into the blob was parsed from live inputs.
  expect(anchor.href).toBe("blob:x");
});
