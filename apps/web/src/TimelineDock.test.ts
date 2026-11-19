// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineDock } from "./TimelineDock";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

async function mount(
  key = "scene:one",
  child: ReactNode = createElement("input", { defaultValue: "draft" }),
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const draw = (storageKey: string) =>
    act(async () => {
      root.render(
        createElement(TimelineDock, { storageKey, label: "场景时间线", children: child }),
      );
    });
  dispose = () => act(() => root.unmount());
  await draw(key);
  return { host, draw };
}

it("folds without disposing or replacing the editable child", async () => {
  const cleanup = vi.fn();
  function Child() {
    useEffect(() => cleanup, []);
    return createElement("input", { defaultValue: "draft" });
  }
  const { host } = await mount("scene:one", createElement(Child));
  const input = host.querySelector("input")!;
  input.value = "unsaved text";
  const button = host.querySelector("button")!;
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await act(async () => button.click());
  expect(host.querySelector("[hidden]")?.contains(input)).toBe(true);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(cleanup).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("unsaved text");
  expect(cleanup).not.toHaveBeenCalled();
});

it("restores folding per project and mode, without borrowing another document preference", async () => {
  localStorage.setItem("glint.timeline-dock.v1:scene:one", "collapsed");
  const { host, draw } = await mount();
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  await draw("nle:one");
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => host.querySelector("button")!.click());
  expect(localStorage.getItem("glint.timeline-dock.v1:nle:one")).toBe("collapsed");
  await draw("scene:two");
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
});

it("keeps folding usable when the preference store is blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const { host } = await mount();
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("input")).not.toBeNull();
});
