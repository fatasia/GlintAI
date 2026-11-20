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
it("无 verify 字段保持导出已生成现状，不出状态行", async () => {
  const div = await render({ file: "solo.mp4", url: "/api/project/export/ab1/ab1.mp4" });
  expect(div.querySelector('[aria-label="交付下载"] [role="status"]')).toBeNull();
  expect(div.textContent).toContain("下载已生成的文件");
});
it("技术通过·人工待看待听：列 remainingChecks 前两条", async () => {
  const div = await render({
    file: "ok.mp4", url: "/api/project/export/ok/ok.mp4",
    verify: {
      pass: true, sha256: "hash", bytes: 10,
      checks: [{ name: "decode", pass: true }, { name: "spec:width", pass: true }],
      remainingChecks: ["打开成片完整观看一遍：画面内容", "含音频时人耳试听：响度数值", "在目标播放器上播放一次再交付"],
    },
  });
  const status = div.querySelector('[aria-label="交付下载"] [role="status"]')?.textContent ?? "";
  expect(status).toContain("技术检查通过 · 人工待看待听");
  expect(status).toContain("打开成片完整观看一遍：画面内容");
  expect(status).toContain("含音频时人耳试听：响度数值");
  expect(status).not.toContain("在目标播放器上播放一次再交付");
});
it("技术检查未通过：失败项中文摘要，下载链接不被阻塞", async () => {
  const div = await render({
    file: "bad.mp4", url: "/api/project/export/bad/bad.mp4",
    verify: {
      pass: false, sha256: null, bytes: 5,
      checks: [{ name: "decode", pass: false }, { name: "spec:width", pass: false }, { name: "loudness:0", pass: false }, { name: "spec:fps", pass: true }],
      remainingChecks: [],
    },
  });
  const status = div.querySelector('[aria-label="交付下载"] [role="status"]')?.textContent ?? "";
  expect(status).toContain("技术检查未通过");
  expect(status).toContain("解码完整性");
  expect(status).toContain("规格宽度");
  expect(status).toContain("响度 #0");
  expect(status).not.toContain("规格帧率");
  expect(div.querySelectorAll('[aria-label="交付下载"] a')).toHaveLength(1);
});
it("验证器崩溃回执仅显示受控原因，无服务器细节", async () => {
  const div = await render({
    file: "x.mp4", url: "/api/project/export/x/x.mp4",
    verify: { pass: false, sha256: null, bytes: 0, checks: [], remainingChecks: [], error: "failed" },
  });
  const status = div.querySelector('[aria-label="交付下载"] [role="status"]')?.textContent ?? "";
  expect(status).toContain("技术检查未通过");
  expect(status).toContain("验证执行失败");
});
