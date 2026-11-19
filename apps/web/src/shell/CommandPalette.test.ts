// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette";
import type { PaletteCommand } from "./command-filter";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; });

function commandsWith(run: (id: string) => void): PaletteCommand[] {
  return [
    { id: "project", label: "项目", group: "前往", run: () => run("project") },
    { id: "library", label: "素材", group: "前往", run: () => run("library") },
    { id: "settings", label: "设置", group: "前往", run: () => run("settings") },
    { id: "theme", label: "切换到浅色主题", group: "操作", run: () => run("theme") },
  ];
}

async function mount(run: (id: string) => void, onClose = vi.fn()) {
  const node = document.createElement("div"); document.body.appendChild(node);
  const root = createRoot(node); dispose = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(CommandPalette, { commands: commandsWith(run), onClose })); });
  return { onClose };
}
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const selected = () => options().find(option => option.getAttribute("aria-selected") === "true")?.textContent;
const key = (init: KeyboardEventInit & { isComposing?: boolean; keyCode?: number }) => act(async () => {
  input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it("is an accessible combobox + listbox with the first result selected and focus in the input", async () => {
  await mount(() => {});
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(input().getAttribute("aria-controls")).toBe("g-palette-list");
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  expect(options().map(option => option.textContent)).toEqual(["项目", "素材", "设置", "切换到浅色主题"]);
  expect(selected()).toBe("项目");
  expect(input().getAttribute("aria-activedescendant")).toBe("g-palette-project");
  expect(document.activeElement).toBe(input());
});

it("moves with the arrow keys, wraps around, and runs the selected command on Enter", async () => {
  const ran = vi.fn(); const { onClose } = await mount(ran);
  await key({ key: "ArrowDown" }); expect(selected()).toBe("素材");
  await key({ key: "ArrowUp" }); await key({ key: "ArrowUp" }); expect(selected()).toBe("切换到浅色主题");
  await key({ key: "ArrowDown" }); expect(selected()).toBe("项目");
  await key({ key: "End" }); expect(selected()).toBe("切换到浅色主题");
  await key({ key: "Home" }); await key({ key: "ArrowDown" }); await key({ key: "ArrowDown" });
  await key({ key: "Enter" }); await act(async () => { await tick(); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(ran).toHaveBeenCalledTimes(1);
  expect(ran).toHaveBeenCalledWith("settings");
});

it("filters as you type, resets the selection, and shows an empty state", async () => {
  const ran = vi.fn(); await mount(ran);
  await key({ key: "ArrowDown" });
  await type("主题");
  expect(options().map(option => option.textContent)).toEqual(["切换到浅色主题"]);
  expect(selected()).toBe("切换到浅色主题");
  await type("没有这个");
  expect(options()).toHaveLength(0);
  expect(document.body.textContent).toContain("没有匹配的内容");
  await key({ key: "Enter" }); await act(async () => { await tick(); });
  expect(ran).not.toHaveBeenCalled();
});

it("does not run a command when Enter confirms an IME candidate", async () => {
  const ran = vi.fn(); await mount(ran);
  await key({ key: "Enter", isComposing: true });
  await key({ key: "Enter", keyCode: 229 });
  await act(async () => { await tick(); });
  expect(ran).not.toHaveBeenCalled();
  await key({ key: "Enter" }); await act(async () => { await tick(); });
  expect(ran).toHaveBeenCalledWith("project");
});

it("runs a command on click, and closes on Escape without running anything", async () => {
  const ran = vi.fn(); const { onClose } = await mount(ran);
  await act(async () => { options()[1]!.click(); await tick(); });
  expect(ran).toHaveBeenCalledTimes(1);
  expect(ran).toHaveBeenCalledWith("library");
  expect(onClose).toHaveBeenCalledTimes(1);
  onClose.mockClear(); ran.mockClear();
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(); });
  expect(onClose).toHaveBeenCalled();
  expect(ran).not.toHaveBeenCalled();
});

it("follows the pointer so mouse and keyboard never disagree", async () => {
  await mount(() => {});
  await act(async () => { options()[2]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); });
  expect(selected()).toBe("设置");
  await key({ key: "ArrowDown" }); expect(selected()).toBe("切换到浅色主题");
});
