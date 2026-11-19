// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { buildSeries } from "@glintai/composer/drama-series";
import { previzFromScene } from "@glintai/composer/drama-previz";
import { assertAllAuthoringCanLeave } from "./authoring-leave";
import { usePrevizDraft } from "./storyboard-previz-draft";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup() {
  const series = buildSeries("第一场 茶馆 内 日\n老陈：新茶到了。", {
    id: "draft",
    title: "Tea",
    engine: "mg",
    aspect: "16:9",
  });
  const initial = previzFromScene(series, series.episodes[0]!.scenes[0]!.id).doc;
  let state: ReturnType<typeof usePrevizDraft>;
  function Harness() {
    state = usePrevizDraft(initial, "draft", initial.shots[0]!.id);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  act(() => root.render(createElement(Harness)));
  return { initial, get: () => state! };
}
it("blocks leaving and switching shots until a downloaded JSON is explicitly confirmed", async () => {
  const { initial, get } = setup();
  expect(() => assertAllAuthoringCanLeave()).not.toThrow();
  act(() => get().change("camera", initial.cameras[0]!.id, "x", "3"));
  expect(get().dirty).toBe(true);
  expect(() => assertAllAuthoringCanLeave()).toThrow("未导出");
  act(() => get().selectShot(initial.shots[1]!.id));
  expect(get().shot).toBe(initial.shots[0]!.id);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:fixture", revokeObjectURL: () => {} }),
  );
  act(() => get().exportFile());
  expect(get().downloaded).toBe(true);
  expect(() => assertAllAuthoringCanLeave()).toThrow();
  act(() => get().change("camera", initial.cameras[0]!.id, "x", "4"));
  expect(get().downloaded).toBe(false);
  act(() => get().exportFile());
  act(() => get().confirmSaved());
  expect(() => assertAllAuthoringCanLeave()).not.toThrow();
  act(() => get().change("camera", initial.cameras[0]!.id, "x", "8"));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  act(() => get().discard());
  expect(get().doc.cameras[0]!.keys[0]!.position[0]).toBe(4);
  act(() => get().selectShot(initial.shots[1]!.id));
  expect(get().shot).toBe(initial.shots[1]!.id);
});
it("keeps the active draft on invalid input, refused discard and late imports", async () => {
  const { initial, get } = setup();
  let resolve: (text: string) => void = () => {};
  const file = Object.assign(new File(["pending"], "draft.json"), {
    text: () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  });
  let pending: Promise<void>;
  act(() => {
    pending = get().importFile(file);
  });
  act(() => get().change("camera", initial.cameras[0]!.id, "x", "6"));
  await act(async () => {
    resolve(JSON.stringify(initial));
    await pending;
  });
  expect(get().doc.cameras[0]!.keys[0]!.position[0]).toBe(6);
  expect(get().error).toContain("未导出");
  act(() => get().change("camera", initial.cameras[0]!.id, "fov", "200"));
  expect(get().doc.cameras[0]!.fovDeg).toBe(initial.cameras[0]!.fovDeg);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  act(() => get().discard());
  expect(get().dirty).toBe(true);
  confirm.mockReturnValue(true);
  act(() => get().discard());
  expect(get().doc).toEqual(initial);
  expect(() => assertAllAuthoringCanLeave()).not.toThrow();
});
