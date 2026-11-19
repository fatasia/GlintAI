// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRegistrySettings } from "./ModelRegistrySettings";
import { registryTemplate, parseRegistryImport } from "./model-registry-data";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const initial = { models: [], builtins: [], digest: "a".repeat(64) };
const reply = (value: unknown, ok = true) => ({ ok, json: async () => value });
let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent === name)!;
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
async function fill(host: HTMLElement, value: string) {
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(
  fetcher: (url: string, init?: RequestInit) => Promise<unknown>,
  strict = false,
) {
  const fetch = vi.fn(fetcher);
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      strict
        ? createElement(StrictMode, null, createElement(ModelRegistrySettings))
        : createElement(ModelRegistrySettings),
    ),
  );
  return { host, fetch };
}
it("previews then explicitly replaces and preserves unknown prices without a generation request", async () => {
  const { host, fetch } = await mount(async (_url, init) =>
    init?.method
      ? reply({
          ...initial,
          models: JSON.parse(String(init.body)).registry.models,
          digest: "b".repeat(64),
        })
      : reply(initial),
  );
  const text = JSON.stringify({ models: registryTemplate() });
  await fill(host, text);
  await click(button(host, "检查导入内容"));
  expect(host.textContent).toContain("价格未知");
  expect(host.textContent).toContain("仅注册 · 未接执行");
  expect(button(host, "替换并保存").disabled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await click(host.querySelector('input[type="checkbox"]')!);
  await click(button(host, "替换并保存"));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([url]) => url === "/api/settings/model-registry")).toBe(true);
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
    registry: { models: parseRegistryImport(text) },
    baseDigest: initial.digest,
  });
  expect(host.textContent).toContain("已保存到本机配置目录");
  await fill(host, "{changed");
  expect(host.textContent).not.toContain("已保存到本机配置目录");
});
it("keeps draft and old rows on conflict, reloads without discarding draft and requires fresh consent", async () => {
  let calls = 0;
  const { host, fetch } = await mount(async (_url, init) =>
    init?.method
      ? reply({ code: "conflict" }, false)
      : reply({ ...initial, digest: (++calls === 1 ? "a" : "c").repeat(64) }),
  );
  const text = JSON.stringify({ models: registryTemplate() });
  await fill(host, text);
  await click(button(host, "检查导入内容"));
  await click(host.querySelector('input[type="checkbox"]')!);
  await click(button(host, "替换并保存"));
  expect(host.querySelector("textarea")!.value).toBe(text);
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("草稿已保留");
  await click(button(host, "重新读取已保存清单"));
  expect(host.querySelector("textarea")!.value).toBe(text);
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("invalid and credential input stays local and never overwrites the saved registry", async () => {
  const { host, fetch } = await mount(async () => reply(initial));
  for (const text of [
    "{invalid",
    JSON.stringify({ models: [{ ...registryTemplate()[0], notes: "Bearer fixture-private" }] }),
  ]) {
    await fill(host, text);
    await click(button(host, "检查导入内容"));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(button(host, "替换并保存")).toBeUndefined();
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("blocks duplicate writes and ignores old StrictMode responses", async () => {
  let first!: (value: unknown) => void;
  let save!: (value: unknown) => void;
  let reads = 0;
  const { host, fetch } = await mount(
    async (_url, init) =>
      init?.method
        ? new Promise((resolve) => {
            save = resolve;
          })
        : ++reads === 1
          ? new Promise((resolve) => {
              first = resolve;
            })
          : reply(initial),
    true,
  );
  await act(async () => first(reply({ ...initial, digest: "f".repeat(64) })));
  await fill(host, JSON.stringify({ models: registryTemplate() }));
  await click(button(host, "检查导入内容"));
  await click(host.querySelector('input[type="checkbox"]')!);
  await click(button(host, "替换并保存"));
  await click(button(host, "替换并保存"));
  const puts = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(JSON.parse(String(puts[0]![1]?.body)).baseDigest).toBe(initial.digest);
  dispose();
  dispose = () => {};
  await act(async () => save(reply({ ...initial, models: registryTemplate() })));
});
