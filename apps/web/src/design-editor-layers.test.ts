// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DesignInspector } from "./design-editor-inspector";
import { describeDesignNode, designLayers, patchDesignNodes, type DesignPatch } from "./design-editor-dom";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const page = (body: string) => `<!doctype html>\n<html><body>${body}</body></html>`;
const boxes = page('<main data-design-id="root"><div data-design-id="a" style="position:absolute;left:10px;top:20px;width:100px;height:40px">甲</div><div data-design-id="b" style="position:absolute;left:80px;top:120px;width:60px;height:20px">乙</div><div data-design-id="c" style="position:absolute;left:200px;top:60px;width:40px;height:80px">丙</div></main>');
const style = (html: string, id: string) => describeDesignNode(html, id)!.style;

it("edits typography, spacing, radius, shadow and rotation as whitelisted CSS without changing the source", () => {
  const result = patchDesignNodes(boxes, ["a"], {
    fontFamily: '"Microsoft YaHei", sans-serif', fontWeight: "600", lineHeight: "1.5", letterSpacing: "0.02em", textAlign: "center",
    padding: "12px 16px", gap: "8px", borderRadius: "12px", boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2), inset 0 0 2px #fff", rotate: "15deg",
  });
  const applied = style(result, "a");
  expect(applied.fontFamily).toContain("Microsoft YaHei"); expect(applied.fontWeight).toBe("600"); expect(applied.lineHeight).toBe("1.5");
  expect(applied.letterSpacing).toBe("0.02em"); expect(applied.textAlign).toBe("center"); expect(applied.padding).toBe("12px 16px");
  expect(applied.gap).toBe("8px"); expect(applied.borderRadius).toBe("12px"); expect(applied.boxShadow).toContain("16px"); expect(applied.rotate).toBe("15deg");
  expect(style(boxes, "a").rotate).toBe(""); expect(style(result, "b").fontFamily).toBe("");
  expect(style(patchDesignNodes(result, ["a"], { rotate: "", boxShadow: "" }), "a")).toMatchObject({ rotate: "", boxShadow: "" });
});
it.each([
  { fontFamily: 'url(https://example.com/font)' }, { fontFamily: 'Arial; color:red' }, { fontWeight: "0" }, { fontWeight: "1001" },
  { lineHeight: "-1px" }, { padding: "-1px" }, { gap: "1px 2px 3px" }, { borderRadius: "calc(1px)" },
  { rotate: "361deg" }, { rotate: "10rad" }, { boxShadow: "0 0 -2px #000" }, { boxShadow: "0 0 1px url(x)" },
])("rejects invalid extended properties without returning a partial patch: %j", patch => {
  expect(() => patchDesignNodes(boxes, ["a", "b"], { color: "#ff0000", ...patch })).toThrow();
  expect(style(boxes, "a").color).toBe("");
});
it("does not mistake the previous CSS value for successful validation of an invalid replacement", () => {
  const source = patchDesignNodes(boxes, ["a"], { color: "red", fontFamily: "Arial" });
  expect(() => patchDesignNodes(source, ["a"], { color: "notavalidcsscolor" })).toThrow("浏览器不支持");
  expect(style(source, "a").color).toBe("red");
});
const order = (html: string) => [...html.matchAll(/data-design-id="(a|b|c)"/g)].map(match => match[1]);
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; vi.restoreAllMocks(); });
async function mount(html: string, selected: string[]) {
  const node = document.createElement("div"); document.body.appendChild(node); const root = createRoot(node);
  const onPatch = vi.fn<(patch: DesignPatch) => void>(), onSelect = vi.fn<(ids: string[]) => void>();
  await act(async () => root.render(createElement(DesignInspector, { html, selected, onSelect, onPatch })));
  dispose = () => act(() => root.unmount());
  return { node, onPatch, onSelect };
}
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
function tool(node: ParentNode, layer: string, label: string) {
  const row = node.querySelector<HTMLElement>(`[data-design-layer="${layer}"]`); if (!row) throw Error(`Missing layer row ${layer}`);
  const found = row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); if (!found) throw Error(`Missing ${label} in ${layer}`); return found;
}

it("describes layers with order edges, visibility and lock state", () => {
  const hidden = patchDesignNodes(boxes, [], { target: "b", layer: "hide" }), locked = patchDesignNodes(hidden, [], { target: "c", locked: true });
  expect(designLayers(locked).map(layer => [layer.id, layer.first, layer.last, layer.visible, layer.locked])).toEqual([["root", true, true, true, false], ["a", true, false, true, false], ["b", false, false, false, false], ["c", false, true, true, true]]);
});

it("moves a layer up and down among element siblings without touching the selection", () => {
  expect(order(patchDesignNodes(boxes, [], { target: "a", layer: "down" }))).toEqual(["b", "a", "c"]);
  expect(order(patchDesignNodes(boxes, [], { target: "c", layer: "up" }))).toEqual(["a", "c", "b"]);
  expect(() => patchDesignNodes(boxes, [], { target: "a", layer: "up" })).toThrow("该图层已在最前，无法继续上移。");
  expect(() => patchDesignNodes(boxes, [], { target: "c", layer: "down" })).toThrow("该图层已在最后，无法继续下移。");
});

it("hides and restores a layer while keeping its original inline display", () => {
  const start = page('<div data-design-id="flex" style="display:flex;position:absolute;left:0px;top:0px;width:10px;height:10px">甲</div>');
  const hidden = patchDesignNodes(start, [], { target: "flex", layer: "hide" });
  expect(style(hidden, "flex").position).toBe("absolute"); expect(hidden).toContain("display: none");
  expect(describeDesignNode(hidden, "flex")!.visible).toBe(false);
  const shown = patchDesignNodes(hidden, [], { target: "flex", layer: "show" });
  expect(shown).toContain("display: flex"); expect(describeDesignNode(shown, "flex")!.visible).toBe(true);
  expect(patchDesignNodes(start, [], { target: "flex", layer: "show" })).toBe(start);
});

it("rejects explicit layer actions on a locked layer until it is unlocked", () => {
  const locked = patchDesignNodes(boxes, ["b"], { locked: true });
  expect(patchDesignNodes(locked, ["b"], { color: "#ffffff" })).toBe(locked);
  expect(() => patchDesignNodes(locked, [], { target: "b", color: "#ffffff" })).toThrow("图层已锁定，请先解锁再修改。");
  expect(() => patchDesignNodes(locked, [], { target: "b", layer: "hide" })).toThrow("图层已锁定，请先解锁再修改。");
  expect(() => patchDesignNodes(locked, [], { target: "b", layer: "up" })).toThrow("图层已锁定，请先解锁再修改。");
  expect(style(patchDesignNodes(locked, ["b"], { locked: false, color: "#ffffff" }), "b").color).toContain("255, 255, 255");
  expect(() => patchDesignNodes(patchDesignNodes(boxes, ["root"], { locked: true }), [], { target: "a", layer: "hide" })).toThrow("图层已锁定，请先解锁再修改。");
});

it("aligns left, center, right, top, middle and bottom from inline geometry", () => {
  expect(["a", "b", "c"].map(id => style(patchDesignNodes(boxes, ["a", "b", "c"], { align: "left" }), id).left)).toEqual(["10px", "10px", "10px"]);
  expect(["a", "b", "c"].map(id => style(patchDesignNodes(boxes, ["a", "b", "c"], { align: "centerX" }), id).left)).toEqual(["75px", "95px", "105px"]);
  expect(["a", "b", "c"].map(id => style(patchDesignNodes(boxes, ["a", "b", "c"], { align: "right" }), id).left)).toEqual(["140px", "180px", "200px"]);
  expect(["a", "b", "c"].map(id => style(patchDesignNodes(boxes, ["a", "b", "c"], { align: "top" }), id).top)).toEqual(["20px", "20px", "20px"]);
  expect(["a", "b", "c"].map(id => style(patchDesignNodes(boxes, ["a", "b", "c"], { align: "middleY" }), id).top)).toEqual(["60px", "70px", "40px"]);
  expect(["a", "b", "c"].map(id => style(patchDesignNodes(boxes, ["a", "b", "c"], { align: "bottom" }), id).top)).toEqual(["100px", "120px", "60px"]);
});

it("distributes with even gaps and preserves the percent unit already on the node", () => {
  const spread = patchDesignNodes(boxes, ["a", "b", "c"], { align: "distributeX" });
  expect(["a", "b", "c"].map(id => style(spread, id).left)).toEqual(["10px", "125px", "200px"]);
  const stacked = patchDesignNodes(boxes, ["a", "b", "c"], { align: "distributeY" });
  expect(["a", "b", "c"].map(id => style(stacked, id).top)).toEqual(["20px", "120px", "50px"]);
  const percent = page('<div data-design-id="p1" style="position:absolute;left:10%;top:0%;width:20%;height:10%">甲</div><div data-design-id="p2" style="position:absolute;left:50%;top:0%;width:30%;height:10%">乙</div>');
  expect(["p1", "p2"].map(id => style(patchDesignNodes(percent, ["p1", "p2"], { align: "left" }), id).left)).toEqual(["10%", "10%"]);
  expect(["p1", "p2"].map(id => style(patchDesignNodes(percent, ["p1", "p2"], { align: "right" }), id).left)).toEqual(["60%", "50%"]);
});

it("refuses to guess when geometry, unit or count cannot support the alignment", () => {
  expect(() => patchDesignNodes(boxes, ["a"], { align: "left" })).toThrow("对齐需要至少两个图层。");
  expect(() => patchDesignNodes(boxes, ["a", "b"], { align: "distributeX" })).toThrow("分布需要至少三个图层。");
  const flow = page('<div data-design-id="x">甲</div><div data-design-id="y">乙</div>');
  expect(() => patchDesignNodes(flow, ["x", "y"], { align: "left" })).toThrow("图层 <div> 缺少内联 left，无法确定几何位置；请先设置位置或在源码中调整。");
  const narrow = page('<div data-design-id="x" style="position:absolute;left:0px;top:0px;height:10px">甲</div><div data-design-id="y" style="position:absolute;left:10px;top:0px;width:10px;height:10px">乙</div>');
  expect(() => patchDesignNodes(narrow, ["x", "y"], { align: "left" })).toThrow("图层 <div> 缺少内联 width，无法确定几何尺寸；请先设置尺寸或在源码中调整。");
  const mixed = page('<div data-design-id="x" style="position:absolute;left:0px;top:0px;width:10px;height:10px">甲</div><div data-design-id="y" style="position:absolute;left:10%;top:0px;width:10px;height:10px">乙</div>');
  expect(() => patchDesignNodes(mixed, ["x", "y"], { align: "left" })).toThrow("图层 <div> 的 left 与 width 单位不一致，无法安全对齐。");
  const staticBox = page('<div data-design-id="x" style="position:static;left:0px;top:0px;width:10px;height:10px">甲</div><div data-design-id="y" style="position:absolute;left:10px;top:0px;width:10px;height:10px">乙</div>');
  expect(() => patchDesignNodes(staticBox, ["x", "y"], { align: "left" })).toThrow("图层 <div> 是 static 定位，left 不会生效；请先改为相对或绝对定位。");
  expect(() => patchDesignNodes(patchDesignNodes(boxes, ["a"], { locked: true }), ["a", "b"], { align: "left" })).toThrow("图层 <div> 已锁定，请先解锁再对齐。");
});

it("renders layer tools and align actions that patch through the existing callback", async () => {
  const work = await mount(boxes, ["a", "b"]);
  expect(work.node.querySelectorAll("[data-design-layer]")).toHaveLength(4);
  expect(tool(work.node, "a", "上移图层").disabled).toBe(true); expect(tool(work.node, "c", "下移图层").disabled).toBe(true);
  await click(tool(work.node, "b", "上移图层")); expect(work.onPatch).toHaveBeenLastCalledWith({ target: "b", layer: "up" });
  await click(tool(work.node, "b", "下移图层")); expect(work.onPatch).toHaveBeenLastCalledWith({ target: "b", layer: "down" });
  await click(tool(work.node, "b", "隐藏图层")); expect(work.onPatch).toHaveBeenLastCalledWith({ target: "b", layer: "hide" });
  await click(tool(work.node, "b", "锁定图层")); expect(work.onPatch).toHaveBeenLastCalledWith({ target: "b", locked: true });
  expect(work.node.textContent).toContain("对齐与分布");
  expect(work.node.querySelector<HTMLButtonElement>('button[aria-label="水平分布"]')!.disabled).toBe(true);
  await click(work.node.querySelector<HTMLButtonElement>('button[aria-label="左对齐"]')!); expect(work.onPatch).toHaveBeenLastCalledWith({ align: "left" });
  await click(work.node.querySelector<HTMLInputElement>('[data-design-layer="c"] input')!); expect(work.onSelect).toHaveBeenLastCalledWith(["a", "b", "c"]);
  dispose();
  const triple = await mount(boxes, ["a", "b", "c"]);
  expect(triple.node.querySelector<HTMLButtonElement>('button[aria-label="水平分布"]')!.disabled).toBe(false);
  await click(triple.node.querySelector<HTMLButtonElement>('button[aria-label="垂直分布"]')!); expect(triple.onPatch).toHaveBeenLastCalledWith({ align: "distributeY" });
  dispose();
  const changed = await mount(patchDesignNodes(patchDesignNodes(boxes, [], { target: "c", locked: true }), [], { target: "b", layer: "hide" }), ["a", "b"]);
  expect(tool(changed.node, "c", "解锁图层").getAttribute("aria-pressed")).toBe("true");
  expect(tool(changed.node, "b", "显示图层").textContent).toBe("显示");
  expect(changed.node.textContent).toContain("隐藏");
});
