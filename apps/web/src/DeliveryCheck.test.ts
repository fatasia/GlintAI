// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryCheck } from "./DeliveryCheck";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const hash = "a".repeat(64);
const report = (overrides: Record<string, unknown> = {}) => ({
  pass: true, sha256: hash, bytes: 12345, duration: 2.5,
  checks: [{ name: "decode", pass: true }, { name: "audio-policy", pass: true }], ...overrides,
});
function response(value: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(value) } as unknown as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let cleanup = () => {};
afterEach(() => {
  cleanup(); document.body.innerHTML = "";
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount(jobId = "idea-test") {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div);
  let mounted = true;
  const unmount = () => { if (mounted) { act(() => root.unmount()); mounted = false; } };
  cleanup = unmount;
  const update = async (id: string) => { await act(async () => root.render(createElement(DeliveryCheck, { jobId: id }))); };
  await update(jobId);
  const button = (label = "检查最终文件") => [...div.querySelectorAll("button")].find(item => item.textContent === label)!;
  const click = async (label?: string) => { await act(async () => button(label).click()); };
  return { div, update, unmount, button, click };
}

describe("DeliveryCheck interactions (jsdom, not browser verification)", () => {
  it("only posts an encoded job ID on demand and shows technical results and scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(report())); vi.stubGlobal("fetch", fetcher);
    const h = await mount("idea-/中?x=../final.mp4");
    expect(fetcher).not.toHaveBeenCalled();
    await h.click();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/delivery-check/${encodeURIComponent("idea-/中?x=../final.mp4")}`);
    expect(fetcher.mock.calls[0]![1]).toEqual({ method: "POST", signal: expect.any(AbortSignal) });
    expect(h.div.textContent).toContain("技术检查通过");
    expect(h.div.textContent).toContain("✓ 通过 · 完整解码");
    expect(h.div.textContent).toContain("文件大小：12345 字节");
    expect(h.div.textContent).toContain("时长：2.50 秒");
    expect(h.div.textContent).toContain(`SHA-256：${hash}`);
    expect(h.div.textContent).toContain("不检查画面色彩、人物身份或口型同步");
    expect(h.div.textContent).toContain("无音轨不一定是失败");
    expect(h.button().disabled).toBe(false);
  });

  it("shows immediate pending feedback and guards duplicate clicks before rerender", async () => {
    const waiting = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(waiting.promise); vi.stubGlobal("fetch", fetcher);
    const h = await mount();
    act(() => { h.button().click(); h.button().click(); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.div.querySelector('[role="status"]')?.textContent).toContain("正在检查最终文件");
    expect(h.button().disabled).toBe(true);
    expect(h.button("取消检查")).toBeDefined();
    await act(async () => waiting.resolve(response(report())));
    expect(h.button().disabled).toBe(false);
    expect(h.div.textContent).toContain("技术检查通过");
  });

  it("renders failed checks with Chinese labels, stream indexes and no absent SHA/duration", async () => {
    const names = ["input", "sha256", "probe", "video", "duration", "audio-policy", "decode", "loudness:1", "true-peak:2", "audio-measurement:3", "file-unchanged", "cancelled", "timeout", "arguments", "future-stage"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(report({ pass: false, sha256: null, duration: undefined, bytes: 0, checks: names.map(name => ({ name, pass: false })) }))));
    const h = await mount(); await h.click();
    expect(h.div.textContent).toContain("技术检查未通过");
    for (const label of ["输入文件可读性", "文件摘要计算", "媒体信息探测", "视频轨道", "有效时长", "音频轨道策略", "完整解码", "响度（音轨索引 1）", "真峰值（音轨索引 2）", "音频测量（音轨索引 3）", "检查期间文件未变化", "检查已取消", "检查超时", "检查参数", "其他技术检查（future-stage）"]) expect(h.div.textContent).toContain(label);
    expect(h.div.querySelectorAll("li")).toHaveLength(names.length);
    expect([...h.div.querySelectorAll("li")].every(item => item.textContent?.startsWith("✕ 未通过"))).toBe(true);
    expect(h.div.textContent).toContain("文件大小：0 字节");
    expect(h.div.textContent).not.toContain("SHA-256：");
    expect(h.div.textContent).not.toContain("时长：");
  });

  it("handles HTTP 409 without trusting its body, then allows a manual retry", async () => {
    const conflict = response({ error: "sensitive server path" }, 409);
    const fetcher = vi.fn().mockResolvedValueOnce(conflict).mockResolvedValueOnce(response(report())); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.click();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("HTTP 409");
    expect(h.div.textContent).toContain("请等待完成后手动重试");
    expect(conflict.json).not.toHaveBeenCalled();
    expect(h.div.textContent).not.toContain("sensitive");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await h.click();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(h.div.textContent).toContain("技术检查通过");
  });

  it.each([401, 500])("shows actionable HTTP %s feedback without automatic retries", async status => {
    const fetcher = vi.fn().mockResolvedValue(response(null, status)); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.click();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain(`HTTP ${status}`);
    expect(h.div.textContent).toContain("手动重试");
    expect(h.button().disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON and can retry after a network error", async () => {
    const bad = response(null); vi.mocked(bad.json).mockRejectedValue(new SyntaxError("broken"));
    const fetcher = vi.fn().mockResolvedValueOnce(bad).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response(report())); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.click();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("无效 JSON");
    await h.click();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("检查连接后手动重试");
    await h.click();
    expect(h.div.textContent).toContain("技术检查通过");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    null, { pass: true }, report({ pass: "yes" }), report({ sha256: "not-a-sha" }), report({ sha256: undefined }),
    report({ bytes: -1 }), report({ bytes: 1.5 }), report({ bytes: Infinity }), report({ duration: NaN }),
    report({ duration: -1 }), report({ checks: null }), report({ checks: [null] }),
    report({ checks: [{ name: "decode", pass: "yes" }] }), report({ checks: [{ name: " ", pass: true }] }),
  ])("does not render malformed report %# as a technical pass", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(value)));
    const h = await mount(); await h.click();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("检查结果格式无效");
    expect(h.div.textContent).not.toContain("技术检查通过");
    expect(h.div.querySelectorAll("li")).toHaveLength(0);
    expect(h.button().disabled).toBe(false);
  });

  it("cancels immediately and ignores a stale success even after retry starts", async () => {
    const old = deferred<Response>(), next = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.click();
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    await h.click("取消检查");
    expect(signal.aborted).toBe(true);
    expect(h.div.textContent).toContain("已取消检查，未确认技术结果");
    expect(h.button().disabled).toBe(false);
    await h.click();
    await act(async () => old.resolve(response(report({ bytes: 111 }))));
    expect(h.div.textContent).toContain("正在检查最终文件");
    expect(h.button().disabled).toBe(true);
    await act(async () => next.resolve(response(report({ bytes: 222 }))));
    expect(h.div.textContent).toContain("文件大小：222 字节");
    expect(h.div.textContent).not.toContain("111 字节");
  });

  it("ignores JSON that finishes after cancellation even when abort is ignored", async () => {
    const json = deferred<unknown>(); const res = response(null); vi.mocked(res.json).mockReturnValue(json.promise);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    const h = await mount(); await h.click();
    expect(res.json).toHaveBeenCalledOnce();
    await h.click("取消检查");
    await act(async () => json.resolve(report()));
    expect(h.div.textContent).toContain("已取消检查");
    expect(h.div.textContent).not.toContain("技术检查通过");
  });

  it("aborts and resets on job changes, suppressing a late old response and late rejection", async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(response(report({ bytes: 333 })));
    vi.stubGlobal("fetch", fetcher);
    const h = await mount("idea-first"); await h.click();
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    await h.update("idea-second");
    expect(signal.aborted).toBe(true);
    expect(h.div.textContent).not.toContain("正在检查");
    expect(h.button().disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await h.click();
    await act(async () => first.resolve(response(report({ bytes: 111 }))));
    expect(h.div.textContent).toContain("正在检查最终文件");
    await h.update("idea-third"); await h.click();
    await act(async () => second.reject(new Error("late failure")));
    expect(h.div.textContent).toContain("文件大小：333 字节");
    expect(h.div.querySelector('[role="alert"]')).toBeNull();
    await h.update("idea-fourth");
    expect(h.div.textContent).not.toContain("333 字节");
  });

  it("aborts at 185 seconds, unlocks retries and ignores a timeout-ignoring fetch", async () => {
    vi.useFakeTimers();
    const old = deferred<Response>(); const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(report())); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.click();
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    await act(async () => vi.advanceTimersByTime(184_999));
    expect(signal.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTime(1));
    expect(signal.aborted).toBe(true);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("检查超时");
    expect(h.button().disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await h.click();
    await act(async () => old.resolve(response(report({ pass: false }))));
    expect(h.div.textContent).toContain("技术检查通过");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and clears its timer on unmount, without processing late response bodies", async () => {
    vi.useFakeTimers();
    const waiting = deferred<Response>(); const fetcher = vi.fn().mockReturnValue(waiting.promise); vi.stubGlobal("fetch", fetcher);
    const h = await mount(); await h.click();
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    expect(vi.getTimerCount()).toBe(1);
    h.unmount();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const late = response(report());
    await act(async () => waiting.resolve(late));
    expect(late.json).not.toHaveBeenCalled();
    expect(h.div.textContent).toBe("");
  });
});
