// @vitest-environment jsdom
import { expect, it } from "vitest";
import { applyDesignGesture, describeDesignNode, expandDesignGroupSelection, parseDesignHtml, patchDesignNodes } from "./design-editor-dom";
const html = '<main><div data-design-id="a" style="position:absolute;left:10px;top:20px">甲</div><div data-design-id="b" style="position:absolute;left:100px;top:80px">乙</div><div data-design-id="c">丙</div></main>';
it("groups without wrappers or layout changes, reopens and moves all members once", () => {
  const grouped = patchDesignNodes(html, ["a", "b"], { group: "group" });
  expect(parseDesignHtml(grouped).querySelectorAll("main > div")).toHaveLength(3);
  expect(describeDesignNode(grouped, "a")).toEqual(describeDesignNode(html, "a"));
  expect(expandDesignGroupSelection(grouped, ["a"])).toEqual(["a", "b"]);
  const moved = applyDesignGesture(grouped, ["a", "b"], { dx: 20, dy: -10 });
  expect(describeDesignNode(moved, "a")!.style).toMatchObject({ left: "30px", top: "10px" });
  expect(describeDesignNode(moved, "b")!.style).toMatchObject({ left: "120px", top: "70px" });
  const ungrouped = patchDesignNodes(moved, ["b"], { group: "ungroup" });
  expect(expandDesignGroupSelection(ungrouped, ["a"])).toEqual(["a"]);
  expect(describeDesignNode(ungrouped, "b")).toEqual(describeDesignNode(moved, "b"));
});
it("merges existing groups instead of orphaning members", () => {
  const grouped = patchDesignNodes(html, ["a", "b"], { group: "group" });
  const merged = patchDesignNodes(grouped, ["b", "c"], { group: "group" });
  expect(new Set(expandDesignGroupSelection(merged, ["c"]))).toEqual(new Set(["a", "b", "c"]));
});
it("rejects nested, missing and locked members atomically", () => {
  expect(() => patchDesignNodes(html, ["a"], { group: "group" })).toThrow("至少两个");
  expect(() => patchDesignNodes(html, ["a", "missing"], { group: "group" })).toThrow("不存在");
  expect(() => patchDesignNodes('<main data-design-id="p"><div data-design-id="a"></div></main>', ["p", "a"], { group: "group" })).toThrow("同一父级");
  const grouped = patchDesignNodes(html, ["a", "b"], { group: "group" });
  const locked = patchDesignNodes(grouped, ["b"], { locked: true });
  expect(() => applyDesignGesture(locked, ["a"], { dx: 10, dy: 0 })).toThrow("锁定");
  expect(() => patchDesignNodes(locked, ["a"], { group: "ungroup" })).toThrow("锁定");
  expect(describeDesignNode(locked, "a")!.style.left).toBe("10px");
});
