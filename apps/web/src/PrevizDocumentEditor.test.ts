// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createPrevizDocument, type PrevizDocument } from "../../../packages/previz/src/index";
import PrevizDocumentEditor from "./PrevizDocumentEditor";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount(readOnly = false, initial = createPrevizDocument("document", "Motion")) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const changed = vi.fn();
  let saved: PrevizDocument = initial;
  function Harness() {
    const [doc, setDoc] = useState<PrevizDocument>(initial);
    return createElement(PrevizDocumentEditor, {
      document: doc,
      readOnly,
      onChange: (next) => {
        changed(next);
        saved = next;
        setDoc(next);
      },
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => {
    root.render(createElement(Harness));
    await import("./StoryboardPrevizPreview");
  });
  return { host, initial, changed, get: () => saved };
}
it("uses shared controls with controlled changes only and preserves the source document", async () => {
  const { host, initial, changed, get } = await mount();
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "在当前帧添加动作")!
      .click(),
  );
  expect(changed).toHaveBeenCalledOnce();
  expect(initial.actorTracks).toEqual([]);
  const select = host.querySelector<HTMLSelectElement>('[aria-label="姿势"]')!;
  await act(async () => {
    select.value = "sit";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const saved = get();
  expect(saved.schemaVersion === 2 && saved.actorTracks[0]!.keys[0]!.pose).toBe("sit");
  const before = changed.mock.calls.length,
    field = host.querySelector<HTMLInputElement>('[aria-label="关键帧时间（毫秒）"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(changed).toHaveBeenCalledTimes(before);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(localStorage.length).toBe(0);
});
it("disables editing for read-only documents and never changes identity in place", async () => {
  const { host, changed } = await mount(true);
  expect(host.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "在当前帧添加动作")!
      .click(),
  );
  expect(changed).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("迁移为动作新副本");
});
it("keeps controls available when a camera crosses its target between otherwise valid keys", async () => {
  const doc = createPrevizDocument("crossing", "Camera crossing");
  doc.cameras[0]!.keys = [
    { tMs: 0, position: [0, 1, -1], target: { point: [0, 1, 0] }, easing: "linear" },
    { tMs: 1000, position: [0, 1, 1], target: { point: [0, 1, 0] }, easing: "linear" },
  ];
  const { host, changed } = await mount(false, doc);
  const slider = host.querySelector<HTMLInputElement>('[aria-label="镜头帧"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "12");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("相机与目标不能重合");
  expect(host.querySelector('[aria-label="相机 X 位置（米）"]')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
