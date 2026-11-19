// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { NleRenderOptions } from "./NleRenderOptions";
import { requestNleVideo, executeNleRender } from "./nle-render-client";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const project = parseNleProject({
  schemaVersion: 1,
  id: "motion",
  title: "Motion",
  fps: 30,
  width: 1280,
  height: 720,
  tracks: [],
});
let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function Controls({ width = 1280, disabled = false }) {
  const [value, onChange] = useState({ motionSamples: 1, shutterAngle: 180 });
  return createElement(NleRenderOptions, {
    project: { ...project, width },
    value,
    onChange,
    disabled,
  });
}
async function mount(width = 1280, disabled = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = () => act(() => root.unmount());
  await act(async () => root.render(createElement(Controls, { width, disabled })));
  return host;
}
it("starts disabled, allows all sample choices, warns for 4K and locks during render", async () => {
  const host = await mount(3840);
  const samples = host.querySelector("select")!,
    shutter = host.querySelector("input")!;
  expect(samples.value).toBe("1");
  expect(shutter.disabled).toBe(true);
  expect([...samples.options].map((option) => option.value)).toEqual(["1", "2", "4", "8"]);
  await act(async () => {
    samples.value = "4";
    samples.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(shutter.disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("不会自动降低分辨率");
  dispose();
  const locked = await mount(1280, true);
  expect(locked.querySelector("fieldset")!.disabled).toBe(true);
});
it("keeps the old default request body and explicitly transmits enabled settings once", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ url: "/file.mp4", file: "file.mp4", bytes: 1024 }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await requestNleVideo(
    project,
    false,
    { motionSamples: 1, shutterAngle: 180 },
    new AbortController().signal,
  );
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ project, alpha: false });
  await requestNleVideo(
    project,
    true,
    { motionSamples: 4, shutterAngle: 270 },
    new AbortController().signal,
  );
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
    project,
    alpha: true,
    motionSamples: 4,
    shutterAngle: 270,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("rejects over-budget input before fetch and does not retry network failure", async () => {
  const fetcher = vi.fn(async () => {
    throw new Error("network");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    requestNleVideo(
      { ...project, width: 3840, height: 2160 },
      false,
      { motionSamples: 4, shutterAngle: 180 },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    requestNleVideo(
      project,
      false,
      { motionSamples: 2, shutterAngle: 180 },
      new AbortController().signal,
    ),
  ).rejects.toThrow("network");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("ignores late results after project change and releases owned request tracking", async () => {
  let reply!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    ),
  );
  const epoch = { current: 0 },
    requests = { current: new Set<AbortController>() };
  const setResult = vi.fn(),
    setRendering = vi.fn();
  const pending = executeNleRender({
    project,
    alpha: false,
    motion: { motionSamples: 2, shutterAngle: 180 },
    epoch,
    requests,
    setResult,
    setRendering,
    setError: vi.fn(),
    setStatus: vi.fn(),
  });
  expect(requests.current.size).toBe(1);
  epoch.current++;
  reply({ ok: true, json: async () => ({ url: "/old.mp4", file: "old.mp4", bytes: 1024 }) });
  await pending;
  expect(setResult.mock.calls).toEqual([[null]]);
  expect(setRendering.mock.calls).toEqual([[true]]);
  expect(requests.current.size).toBe(0);
});
