// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuickImage } from "./QuickImage";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function stubFetch(handler: Handler) {
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
function models() { return Response.json({ protocol: "openai-images", models: [{ id: "gpt-image-1", name: "gpt-image-1" }] }); }
async function mount() {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(QuickImage)));
  await flush();
  const type = async (value: string) => act(async () => {
    const area = div.querySelector<HTMLTextAreaElement>('[aria-label="图片描述"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const click = async (text: string) => act(async () => {
    const target = [...div.querySelectorAll("button")].find(button => button.textContent?.includes(text));
    if (!target) throw new Error(`button not found: ${text}`);
    target.click();
  });
  return { div, type, click };
}

it("submits one image request and shows the generated asset", async () => {
  const fetcher = stubFetch((url, init) => {
    if (url === "/api/media/models?type=image") return models();
    if (url === "/api/media/submit" && init.method === "POST") return Response.json({ taskId: "image-task-1" });
    if (url === "/api/media/status/image-task-1") return Response.json({ taskId: "image-task-1", isFinal: true, state: "success", assetUrl: "/api/media/assets/image-task-1.png" });
    return Response.json({});
  });
  const view = await mount();
  await view.type("雨夜的老街，暖黄路灯，电影感");
  await view.click("生成图片");
  await flush();
  const submit = fetcher.mock.calls.find(([url, init]) => String(url) === "/api/media/submit" && (init as RequestInit).method === "POST");
  const body = JSON.parse(String((submit?.[1] as RequestInit).body));
  expect(body).toMatchObject({ type: "image", model: "gpt-image-1", prompt: "雨夜的老街，暖黄路灯，电影感", params: { size: "1024x1024" } });
  expect(body.requestId).toMatch(/^[a-z0-9-]{10,}$/i);
  expect(view.div.querySelector('img[alt="生成的图片"]')?.getAttribute("src")).toBe("/api/media/assets/image-task-1.png");
});
it("restores an unconfirmed submission instead of charging twice", async () => {
  const fetcher = stubFetch((url) => {
    if (url === "/api/media/models?type=image") return models();
    if (url === "/api/media/request/request-123") return Response.json({ taskId: "image-task-2" });
    if (url === "/api/media/status/image-task-2") return Response.json({ taskId: "image-task-2", isFinal: true, state: "success", assetUrl: "/api/media/assets/image-task-2.png" });
    return Response.json({});
  });
  localStorage.setItem("glint.quick-image", JSON.stringify({ requestId: "request-123" }));
  const view = await mount();
  await flush();
  expect(fetcher.mock.calls.some(([url, init]) => String(url) === "/api/media/submit" && (init as RequestInit).method === "POST")).toBe(false);
  expect(view.div.querySelector('img[alt="生成的图片"]')?.getAttribute("src")).toBe("/api/media/assets/image-task-2.png");
});
it("explains a missing gateway instead of offering a dead button", async () => {
  stubFetch((url) => url === "/api/media/models?type=image" ? Response.json({ protocol: "skills", models: [] }) : Response.json({}));
  const view = await mount();
  expect(view.div.textContent).toContain("还没有图片模型");
});
