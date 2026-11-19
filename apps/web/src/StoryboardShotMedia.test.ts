// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { buildSeries, setShotEngine, refreshPrompts } from "@glintai/composer/drama-series";
import { storyboardShots } from "./storyboard-project";
import { StoryboardShotMedia } from "./StoryboardShotMedia";
import {
  storyboardDependencyDigest,
  storyboardGenerationInput,
} from "./storyboard-shot-dependency";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("opens the full identity prompt and never recovers an old dependency receipt", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
    Response.json(
      url.includes("/models") ? { models: [], protocol: "skills" } : { assets: [], versions: [] },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const base = buildSeries("第一场 茶馆 内 日\n老陈：新茶到了。", {
    engine: "mg",
    id: "board",
    title: "茶馆",
    aspect: "16:9",
  });
  const shot = base.episodes[0]!.scenes[0]!.shots.find((item) => item.characterIds.length)!;
  let series = setShotEngine(base, shot.id, "aigc");
  series.characters[0]!.looks[0]!.prompt = "蓝色衬衣，灰发";
  series = refreshPrompts(series);
  const row = storyboardShots(series, series.episodes[0]!.id, "doc").find(
    (item) => item.shot.id === shot.id,
  )!;
  localStorage.setItem(
    `glint.storyboard-task.v1:board:${row.id}`,
    JSON.stringify({ taskId: "old-look" }),
  );
  const digest = await storyboardDependencyDigest(storyboardGenerationInput(series, row));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      createElement(StoryboardShotMedia, {
        row,
        series,
        projectId: "board",
        assets: [],
        loading: false,
        disabled: false,
        onSelect() {},
        onApply() {},
      }),
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(
        [...host.querySelectorAll("button")].find(
          (button) => button.textContent === "生成镜头视频",
        )!.disabled,
      ).toBe(false);
  });
  await act(async () => {
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "生成镜头视频")!
      .click();
    await import("./MediaWorkshop");
  });
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="素材描述"]')!.value).toBe(
    row.shot.videoPrompt,
  );
  expect(row.shot.videoPrompt).toContain("蓝色衬衣");
  expect(fetch.mock.calls.some(([url]) => url.includes("old-look"))).toBe(false);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  expect(localStorage.getItem(`glint.storyboard-task.v1:board:${row.id}:${digest}`)).toBeNull();
  expect(localStorage.getItem(`glint.storyboard-task.v1:board:${row.id}`)).toContain("old-look");
});
