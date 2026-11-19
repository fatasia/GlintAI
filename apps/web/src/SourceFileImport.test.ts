// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SourceFileImport } from "./SourceFileImport";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
async function mount() {
  const element = document.createElement("div"); document.body.appendChild(element);
  const root = createRoot(element), apply = vi.fn();
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(SourceFileImport, { onApply: apply, replacesProject: true })));
  const select = async (file: Partial<File>) => act(async () => {
    const input = element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  const click = async (text: string) => act(async () => [...element.querySelectorAll("button")].find(button => button.textContent === text)!.click());
  return { element, apply, select, click };
}
const file = (name: string, content: string) => {
  const bytes = new TextEncoder().encode(content);
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
};

it("previews locally and only replaces the source after explicit confirmation", async () => {
  const h = await mount(); await h.select(file("source.md", "# 标题\n正文"));
  expect(h.element.querySelector('[aria-label="资料文件预览"]')?.textContent).toBe("# 标题\n正文");
  expect(h.element.textContent).toContain("将清除当前分镜"); expect(h.apply).not.toHaveBeenCalled();
  await h.click("替换资料"); expect(h.apply).toHaveBeenCalledWith("# 标题\n正文");
});
it("parent cancellation retains the file preview so the user can retry without reimporting", async () => {
  const h = await mount(); await h.select(file("source.md", "保留资料正文")); h.apply.mockReturnValue(false);
  await h.click("替换资料"); expect(h.element.querySelector('[aria-label="资料文件预览"]')?.textContent).toBe("保留资料正文");
  h.apply.mockReturnValue(true); await h.click("替换资料"); expect(h.element.querySelector('[aria-label="资料文件预览"]')).toBeNull();
});
it("allows repairing a preview without applying empty text", async () => {
  const h = await mount(); await h.select(file("资料.txt", "原始内容"));
  const area = h.element.querySelector<HTMLTextAreaElement>('[aria-label="资料文件预览"]')!;
  const change = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value); area.dispatchEvent(new Event("input", { bubbles: true })); });
  await change("  ");
  expect(h.element.textContent).toContain("正文不能为空");
  expect([...h.element.querySelectorAll("button")].find(button => button.textContent === "替换资料")!.disabled).toBe(true);
  await change("修正后的中文正文"); await h.click("替换资料");
  expect(h.apply).toHaveBeenCalledOnce(); expect(h.apply).toHaveBeenCalledWith("修正后的中文正文");
});
it("rejects invalid files and does not apply them", async () => {
  const h = await mount();
  await h.select(file("source.csv", "a,b")); expect(h.element.textContent).toContain("请选择 TXT 或 Markdown");
  await h.select({ name: "big.txt", size: 256 * 1024 + 1 }); expect(h.element.textContent).toContain("超过 256 KB");
  await h.select(file("long.txt", "a".repeat(12001))); expect(h.element.textContent).toContain("超过 12000 字");
  await h.select({ name: "bad.txt", size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer }); expect(h.element.textContent).toContain("不是有效的 UTF-8");
  expect(h.apply).not.toHaveBeenCalled();
});
it("ignores an older read when another file is selected", async () => {
  const h = await mount(); let resolve!: (value: ArrayBuffer) => void;
  const slow = new Promise<ArrayBuffer>(done => { resolve = done; });
  await h.select({ name: "old.txt", size: 3, arrayBuffer: () => slow });
  await h.select(file("new.txt", "新资料"));
  await act(async () => resolve(new TextEncoder().encode("旧资料").buffer));
  expect(h.element.querySelector('[aria-label="资料文件预览"]')?.textContent).toBe("新资料");
  await h.click("取消导入"); expect(h.apply).not.toHaveBeenCalled();
});
it("previews a link before applying the text", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ text: "链接正文" })); vi.stubGlobal("fetch", fetcher);
  const h = await mount(), input = h.element.querySelector<HTMLInputElement>('[aria-label="资料链接"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.com"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await h.click("预览链接");
  expect(fetcher).toHaveBeenCalledTimes(1); expect(h.apply).not.toHaveBeenCalled();
  expect(h.element.querySelector('[aria-label="资料文件预览"]')?.textContent).toBe("链接正文");
  await h.click("替换资料"); expect(h.apply).toHaveBeenCalledWith("链接正文"); expect(input.value).toBe("");
});
it("ignores a late link response when a local file was selected", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const h = await mount(), input = h.element.querySelector<HTMLInputElement>('[aria-label="资料链接"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://example.com"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await h.click("预览链接"); await h.select(file("new.md", "新文件"));
  await act(async () => resolve(Response.json({ text: "过期链接" })));
  expect(h.element.querySelector('[aria-label="资料文件预览"]')?.textContent).toBe("新文件");
});
it("discards an in-flight link preview when the address changes", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const h = await mount(), input = h.element.querySelector<HTMLInputElement>('[aria-label="资料链接"]')!;
  const change = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await change("https://example.com/old"); await h.click("预览链接"); await change("https://example.com/new");
  await act(async () => resolve(Response.json({ text: "旧链接正文" })));
  expect(h.element.querySelector('[aria-label="资料文件预览"]')).toBeNull();
  expect([...h.element.querySelectorAll("button")].find(button => button.textContent === "预览链接")?.disabled).toBe(false);
});
