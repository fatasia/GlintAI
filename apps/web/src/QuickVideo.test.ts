// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickVideo } from "./QuickVideo";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const job = (status: string, extra: Record<string, unknown> = {}) => ({ id: "idea-abc123", status, log: [], ...extra });
const intent = "给咖啡店做一条15秒开业宣传，竖屏";
const material = "# 开业资料\n\n- 咖啡店 10 月 1 日开业\n- 15 秒竖屏宣传，主打手冲咖啡和早餐\n\n欢迎附近居民来喝第一杯。";
const INTENT_NOTICE = "创作要求需要文本模型。请到设置里配置；已有完整文案可切换「已有资料」。";
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
function posts(fetcher: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetcher.mock.calls.filter(([url, init]) => String(url) === "/api/make" && (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
async function mount(extra: Record<string, unknown> = {}, settle = true) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(QuickVideo, { pollMs: 0, ...extra })));
  if (settle) await flush();
  const area = () => div.querySelector<HTMLTextAreaElement>('[aria-label="快速成片资料"]')!;
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area(), value);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = async (text: string) => act(async () => {
    const target = [...div.querySelectorAll("button")].find(button => button.textContent === text);
    if (!target) throw new Error(`button not found: ${text}`); target.click();
  });
  const generate = async () => act(async () => { div.querySelector<HTMLButtonElement>(".qv-generate")!.click(); });
  const mode = () => div.querySelector('[aria-label="当前输入模式"]')?.textContent ?? "";
  return { div, area, type, click, generate, mode, value: () => area().value, root };
}
function happyServer(configured: boolean, overrides: (url: string, init: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  return stubFetch((url, init) => {
    const override = overrides(url, init); if (override) return override;
    if (url === "/api/settings/llm") return Response.json({ configured });
    if (url === "/api/make" && init.method === "POST") return Response.json({ jobId: "idea-abc123" });
    if (url === "/api/make/idea-abc123") return Response.json(job("done", { video: "/api/video/idea-abc123" }));
    return Response.json({ checks: [], ok: true });
  });
}
describe("job recovery", () => {
  it.each([true, false])("restores a saved job only when it still exists: %s", async exists => {
    const fetcher = happyServer(false, url => url === "/api/make/idea-abc123" && !exists ? new Response("gone", { status: 404 }) : undefined);
    localStorage.setItem("glint.quick-video.job", "idea-abc123");
    const h = await mount();
    expect(fetcher.mock.calls.some(([url]) => String(url) === "/api/make/idea-abc123")).toBe(true);
    expect(Boolean(h.div.querySelector('video[aria-label="快速成片结果"]'))).toBe(exists);
    expect(localStorage.getItem("glint.quick-video.job")).toBe(exists ? "idea-abc123" : null);
  });
  it("recovers a lost make receipt instead of submitting twice", async () => {
    const fetcher = happyServer(false, (url, init) => {
      if (url === "/api/make" && init.method === "POST") return Promise.reject(new Error("network"));
      if (url.startsWith("/api/make/request/")) return Response.json({ jobId: "idea-abc123" });
      return undefined;
    });
    const h = await mount(); await h.type(material); await h.generate(); await flush(); await flush();
    expect(posts(fetcher)).toHaveLength(1);
    expect(posts(fetcher)[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.div.querySelector("video")?.getAttribute("src")).toBe("/api/video/idea-abc123");
  });
  it("keeps the same request id on an unconfirmed network retry", async () => {
    const fetcher = happyServer(true, (url, init) => url.startsWith("/api/make/request/") || url === "/api/make" && init.method === "POST" ? Promise.reject(new TypeError("network")) : undefined);
    const h = await mount(); await h.type(intent); await h.generate(); await flush();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("提交回执未确认");
    await h.generate(); await flush();
    expect(posts(fetcher)).toHaveLength(2);
    expect(posts(fetcher)[0]!.requestId).toBe(posts(fetcher)[1]!.requestId);
    expect(posts(fetcher).every(body => body.idea === intent && !("source" in body))).toBe(true);
  });
});
describe("one-box quick video", () => {
  it.each([true, false])("opens a composed project or explains missing data without losing video: %s", async exists => {
    const edited = vi.fn();
    happyServer(false, url => url === "/api/make/idea-abc123/project" ? exists ? Response.json({ project: { scenes: [{ id: "one" }] } }) : new Response("gone", { status: 404 }) : undefined);
    const h = await mount({ onEditProject: edited }); await h.type(material); await h.generate(); await flush();
    await h.click("继续编辑这支视频"); await flush();
    expect(edited).toHaveBeenCalledTimes(exists ? 1 : 0);
    if (exists) expect(edited).toHaveBeenCalledWith({ scenes: [{ id: "one" }] });
    else expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("无法载入这支视频的工程");
    expect(h.div.querySelector("video")).not.toBeNull();
  });
  it.each([material, "咖啡店于十月开业，位于老街十八号。主打手冲咖啡与早餐，前五十位顾客可免费领取一杯手冲。", `这是原始产品资料。${"产品支持离线编辑与按镜头重渲。".repeat(100)}`])("never uploads existing prose to a configured model", async text => {
    const fetcher = happyServer(true); const h = await mount(); await h.type(text);
    expect(h.mode()).toContain("已有资料");
    expect(h.div.querySelector(".qv-generate")?.textContent).toBe("生成离线草稿");
    await h.generate(); await flush();
    expect(posts(fetcher)).toHaveLength(1);
    expect(posts(fetcher)[0]).toMatchObject({ source: text, tts: "mock", music: "off", encoding: "draft", aspect: "16:9" });
    expect(posts(fetcher)[0]).not.toHaveProperty("idea");
    expect(h.div.textContent).toContain("已完成");
  });
  it.each([intent, `帮我制作咖啡店宣传视频，${"展示店铺环境与手冲细节，风格高级，不要堆字。".repeat(10)}`, "# 创作要求\n- 帮我制作咖啡店宣传片\n- 高级一点\n- 不要字卡\n- 15秒", "Create a cafe promo.\n- Style: premium\n- Duration: 15 seconds"]) ("submits short, long and listed requirements as idea", async text => {
    const fetcher = happyServer(true); const h = await mount(); await h.type(text);
    expect(h.mode()).toContain("创作要求"); expect(h.div.textContent).toContain("文本模型可能产生费用");
    expect(h.div.querySelector(".qv-generate")?.textContent).toBe("生成视频草稿");
    expect(h.div.textContent).not.toContain("生成草稿（免费）");
    await h.generate(); await flush();
    expect(posts(fetcher)).toHaveLength(1);
    expect(posts(fetcher)[0]).toMatchObject({ idea: text, aspect: "16:9", tts: "mock", music: "off", encoding: "draft" });
    expect(posts(fetcher)[0]).not.toHaveProperty("source");
  });
  it("applies preset metadata and returns a newly chosen preset to automatic detection", async () => {
    const fetcher = happyServer(false);
    const h = await mount({ preset: { label: "产品发布", text: material, aspect: "9:16", template: "listicle", theme: "glint-dark", nonce: 1 } });
    expect(h.value()).toBe(material); expect(h.mode()).toContain("已有资料");
    await h.generate(); await flush();
    expect(posts(fetcher)[0]).toMatchObject({ source: material, aspect: "9:16", template: "listicle", theme: "glint-dark" });
    await h.click("创作要求");
    await act(async () => h.root.render(createElement(QuickVideo, { preset: { label: "新起点", text: intent, aspect: "16:9", nonce: 2 } })));
    expect(h.mode()).toBe("自动识别：创作要求");
  });
  it.each(["unconfigured", "404", "network"])("blocks requirements when capability is %s without auto-fallback", async failure => {
    const fetcher = happyServer(false, url => url === "/api/settings/llm" ? failure === "404" ? new Response("not found", { status: 404 }) : failure === "network" ? Promise.reject(new TypeError("Failed to fetch")) : Response.json({ configured: false }) : undefined);
    const h = await mount(); await h.type(intent);
    expect(h.mode()).toContain("创作要求"); expect(h.div.textContent).toContain(INTENT_NOTICE);
    await h.generate(); expect(posts(fetcher)).toHaveLength(0);
    await h.click("已有资料"); expect(h.value()).toBe(intent); expect(h.mode()).toBe("已手动选择：已有资料");
    expect(posts(fetcher)).toHaveLength(0); expect(h.div.textContent).not.toContain(INTENT_NOTICE);
    await h.generate(); expect(posts(fetcher)).toHaveLength(0);
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("至少写 20 个字");
    const source = `${intent}，这是我已有的完整文案。`; await h.type(source); await h.generate(); await flush();
    expect(posts(fetcher)[0]).toMatchObject({ source });
  });
  it("keeps both manual overrides across line breaks, shortening and blank edits until restored", async () => {
    const fetcher = happyServer(true); const h = await mount(); await h.type(intent); await h.click("已有资料");
    for (const value of [`${intent}\n\n高级一点`, "", intent]) { await h.type(value); expect(h.mode()).toBe("已手动选择：已有资料"); }
    await h.click("创作要求"); await h.type(material); expect(h.mode()).toBe("已手动选择：创作要求");
    await h.generate(); await flush(); expect(posts(fetcher)[0]).toMatchObject({ idea: material });
    await h.click("恢复自动"); expect(h.mode()).toBe("自动识别：已有资料");
  });
  it.each([["一分钟讲清熵", "创作要求"], ["咖啡店开业", "已有资料"], ["产品更新说明", "已有资料"]])("keeps example semantics stable: %s", async (label, expected) => {
    const fetcher = happyServer(true); const h = await mount(); await h.click("已有资料"); await h.click(label);
    expect(h.mode()).toBe(`自动识别：${expected}`);
    const value = h.value(); await h.type(value.replace(/\n+/g, " "));
    expect(h.mode()).toBe(`自动识别：${expected}`); expect(posts(fetcher)).toHaveLength(0);
  });
  it("keeps offline submission working when the capability probe fails", async () => {
    const fetcher = happyServer(false, url => url === "/api/settings/llm" ? Promise.reject(new Error("offline")) : undefined);
    const h = await mount(); await h.type(intent); expect(h.div.textContent).toContain(INTENT_NOTICE);
    await h.type(material); await h.generate(); await flush();
    expect(posts(fetcher)[0]).toMatchObject({ source: material });
  });
  it("times out a silent probe and aborts it on unmount", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    stubFetch((_url, init) => { signal = init.signal ?? undefined; return new Promise<Response>(() => {}); });
    const h = await mount({}, false); await h.type(intent); expect(h.mode()).toContain("确认中");
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(h.div.textContent).toContain(INTENT_NOTICE); expect(signal!.aborted).toBe(true);
    expect(h.mode()).not.toContain("确认中");
  });
  it("aborts an in-flight capability probe immediately when unmounted", async () => {
    let signal: AbortSignal | undefined;
    stubFetch((_url, init) => { signal = init.signal ?? undefined; return new Promise<Response>(() => {}); });
    const h = await mount({}, false); expect(signal!.aborted).toBe(false);
    await act(async () => h.root.unmount()); cleanup = () => {}; expect(signal!.aborted).toBe(true);
  });
  it.each([["", "先写一句想法"], [" \n ", "先写一句想法"], ["# 标题\n\n- 要点", "至少写 20 个字"], ["帮我制作视频" + "好".repeat(2000), "创作要求最多 2000 字"], ["这是资料。" + "好".repeat(12000), "资料最多 12000 字"]])("rejects empty, thin or over-limit input locally", async (text, message) => {
    const fetcher = happyServer(true); const h = await mount(); await h.type(text); await h.generate();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain(message); expect(posts(fetcher)).toHaveLength(0);
    if (text.startsWith("帮我")) expect(h.mode()).toContain("创作要求");
  });
  it("accepts each mode's actual length limit without changing its meaning", async () => {
    const fetcher = happyServer(true); const h = await mount(); const text = "帮我制作视频".padEnd(2000, "好");
    await h.type(text); await h.generate(); await flush(); expect(posts(fetcher)[0]!.idea).toBe(text);
    const source = "这是资料。".padEnd(12000, "好"); await h.type(source); await h.generate(); await flush();
    expect(posts(fetcher)[1]!.source).toBe(source);
  });
  it("does not submit during IME composition, but supports Ctrl+Enter after committing", async () => {
    const fetcher = happyServer(true); const h = await mount(); await h.type(intent);
    await act(async () => { h.area().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); h.area().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true })); });
    expect(posts(fetcher)).toHaveLength(0);
    await act(async () => { h.area().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); h.area().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    await flush(); expect(posts(fetcher)).toHaveLength(1);
  });
  it("locks input, type and examples while submitting and ignores repeated clicks", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = happyServer(true, (url, init) => url === "/api/make" && init.method === "POST" ? new Promise<Response>(done => { resolve = done; }) : undefined);
    const h = await mount(); await h.type(intent); await h.generate(); await h.generate();
    expect(posts(fetcher)).toHaveLength(1); expect(h.area().disabled).toBe(true);
    expect(h.div.querySelector(".qv-generate")?.textContent).toBe("正在提交…");
    expect([...h.div.querySelectorAll<HTMLButtonElement>(".qv-input-type button, .qv-examples button")].every(button => button.disabled)).toBe(true);
    await act(async () => resolve(Response.json({ jobId: "idea-abc123" }))); await flush();
  });
  it("surfaces server refusal and failed jobs and allows a corrected retry", async () => {
    let submitted = 0;
    const fetcher = happyServer(true, (url, init) => {
      if (url === "/api/make" && init.method === "POST" && submitted++ === 0) return new Response(JSON.stringify({ error: "Too many jobs; try again later." }), { status: 429 });
      if (url === "/api/make/idea-abc123") return Response.json(job("failed", { error: "Invalid editor project" }));
      return undefined;
    });
    const h = await mount(); await h.type(material); await h.generate(); await flush();
    expect(h.div.querySelector('[role="alert"]')?.textContent).toContain("Too many jobs");
    await h.generate(); await flush(); expect(posts(fetcher)).toHaveLength(2);
    expect(h.div.textContent).toContain("Invalid editor project");
  });
});
