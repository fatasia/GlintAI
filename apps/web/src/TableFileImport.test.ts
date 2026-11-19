// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TableFileImport } from "./TableFileImport";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function mount(onProject = vi.fn(() => true)) {
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => root.render(createElement(TableFileImport, { aspect: "9:16", replacesProject: true, onProject })));
  const select = async (file: Partial<File>) => act(async () => { const input = div.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
  const click = async (label: string) => act(async () => [...div.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  return { div, select, click, onProject };
}
const file = (name: string, content: string) => { const bytes = new TextEncoder().encode(content); return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }; };

it("previews parsed data and creates an editable chart only after confirmation", async () => {
  const h = await mount(); await h.select(file("销量.csv", "月份,销量\n一月,10\n二月,20"));
  expect(h.div.querySelector("table")?.textContent).toContain("一月10"); expect(h.onProject).not.toHaveBeenCalled();
  await h.click("创建图表工程");
  expect(h.onProject).toHaveBeenCalledWith(expect.objectContaining({ aspect: "9:16", title: "销量", scenes: [expect.objectContaining({ kind: "chart", data: [{ label: "一月", value: 10 }, { label: "二月", value: 20 }] })] }), "月份,销量\n一月,10\n二月,20");
});
it("surfaces invalid data and truncation rather than inventing or hiding values", async () => {
  const h = await mount(); await h.select(file("bad.tsv", "项目\t数量\nA\t不是数字")); expect(h.div.textContent).toContain("数值列");
  await h.select(file("large.csv", "项,数\n" + Array.from({ length: 30 }, (_, i) => `行${i},${i}`).join("\n")));
  expect(h.div.textContent).toContain("截断 6 行"); expect(h.div.querySelectorAll("tbody tr")).toHaveLength(24);
});
it("preserves long titles and allows repairing truncated or invalid source before creating", async () => {
  const title = "完整标题".repeat(25), label = "长标签".repeat(10);
  const h = await mount(); await h.select(file(`${title}.csv`, `项目,数值\n${label},1`));
  expect(h.div.textContent).toContain("标签超过 24");
  expect(h.div.querySelector<HTMLInputElement>('[aria-label="图表标题"]')!.value).toBe(title);
  const area = h.div.querySelector<HTMLTextAreaElement>('[aria-label="原始表格"]')!;
  const change = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value); area.dispatchEvent(new Event("input", { bubbles: true })); });
  await change("项目,数值\n坏数据,无");
  expect(h.div.textContent).toContain("数值列");
  expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "创建图表工程")!.disabled).toBe(true);
  await change("项目,数值\n修正后,42");
  expect(h.div.querySelector("table")?.textContent).toContain("修正后42");
  await h.click("创建图表工程");
  expect(h.onProject).toHaveBeenCalledWith(expect.objectContaining({ title }), "项目,数值\n修正后,42");
});
it("keeps out-of-range data editable and creates the repaired project", async () => {
  const h = await mount(); await h.select(file("异常.csv", "项目,数值\nA,1000000000001"));
  expect(h.div.textContent).toContain("超出图表范围");
  expect([...h.div.querySelectorAll("button")].find(button => button.textContent === "创建图表工程")!.disabled).toBe(true);
  const area = h.div.querySelector<HTMLTextAreaElement>('[aria-label="原始表格"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "项目,数值\nA,42"); area.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(h.div.querySelector("table")?.textContent).toContain("A42");
  await h.click("创建图表工程");
  expect(h.onProject).toHaveBeenCalledWith(expect.objectContaining({ scenes: [expect.objectContaining({ data: [{ label: "A", value: 42 }] })] }), "项目,数值\nA,42");
});
it("keeps the preview if loading the new project fails", async () => {
  const h = await mount(vi.fn(() => false)); await h.select(file("data.csv", "项,数\nA,1")); await h.click("创建图表工程");
  expect(h.div.querySelector("table")).not.toBeNull();
});
it("lists workbook sheets and previews the selected sheet without applying it", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ sheets: [{ name: "一季度", text: "月,值\n一月,10" }, { name: "二季度", text: "月,值\n四月,40" }] })));
  const h = await mount(); await h.select(file("报表.xlsx", "PK示例"));
  const select = h.div.querySelector<HTMLSelectElement>('[aria-label="工作表"]')!;
  expect([...select.options].map(item => item.textContent)).toEqual(["一季度", "二季度"]);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "1"); select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(h.div.querySelector("table")?.textContent).toContain("四月40"); expect(h.onProject).not.toHaveBeenCalled();
  await h.click("创建图表工程"); expect(h.onProject).toHaveBeenCalledWith(expect.objectContaining({ scenes: [expect.objectContaining({ data: [{ label: "四月", value: 40 }] })] }), "月,值\n四月,40");
});
it("ignores an old workbook response after a newer CSV is chosen", async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const h = await mount(); await h.select(file("old.xlsx", "PK示例"));
  await h.select(file("new.csv", "项目,数量\n新资料,42"));
  await act(async () => release(Response.json({ sheets: [{ name: "旧表", text: "项目,数量\n旧资料,1" }] })));
  expect(h.div.querySelector("table")?.textContent).toContain("新资料42");
  expect(h.div.querySelector('[aria-label="工作表"]')).toBeNull();
});
