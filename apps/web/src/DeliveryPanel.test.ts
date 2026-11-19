// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { DeliveryPanel, type DeliveryReceipt } from "./DeliveryPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

async function render(receipt: DeliveryReceipt | null): Promise<HTMLDivElement> {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(DeliveryPanel, { receipt })));
  return div;
}

it("空回执不渲染任何内容", async () => {
  const div = await render(null);
  expect(div.querySelector('[aria-label="交付下载"]')).toBeNull();
});

it("MP4+封面+字幕三件套各出一条下载链接，文件大小人类可读", async () => {
  const div = await render({
    file: "demo.mp4", url: "/api/project/export/ab1/ab1.mp4", bytes: 2_621_440,
    coverUrl: "/api/project/export/ab1/ab1.cover.jpg", srtUrl: "/api/project/export/ab1/ab1.srt",
  });
  const links = [...div.querySelectorAll<HTMLAnchorElement>('[aria-label="交付下载"] a')];
  expect(links).toHaveLength(3);
  expect(links.map(link => link.getAttribute("download"))).toEqual(["srt", "demo.mp4", "cover.jpg"]);
  expect(links[1]!.textContent).toContain("下载成片 MP4 · 2.5 MB");
  expect(links[0]!.getAttribute("href")).toContain(".srt");
  expect(links[2]!.getAttribute("href")).toContain(".cover.jpg");
});

it("回执只有 MP4 时只出一条链接（无封面/字幕不占位）", async () => {
  const div = await render({ file: "solo.mp4", url: "/api/project/export/cd2/cd2.mp4" });
  const links = [...div.querySelectorAll<HTMLAnchorElement>('[aria-label="交付下载"] a')];
  expect(links).toHaveLength(1);
  expect(links[0]!.textContent).toBe("下载成片 MP4");
});
it("透明 WebM 回执使用正确的文件类型", async () => {
  const div = await render({ file: "overlay.webm", url: "/api/project/export/alpha/alpha.webm" });
  expect(div.querySelector('[aria-label="交付下载"] a')?.textContent).toBe("下载成片 WebM");
});
