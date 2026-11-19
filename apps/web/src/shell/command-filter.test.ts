import { describe, expect, it } from "vitest";
import { filterCommands, groupCommands, type PaletteCommand } from "./command-filter";

const run = () => undefined;
const commands: PaletteCommand[] = [
  { id: "project", label: "项目", group: "前往", keywords: "project home 工程 作品", run },
  { id: "library", label: "素材", group: "前往", keywords: "assets media", run },
  { id: "brand", label: "品牌与声音", group: "前往", keywords: "素材", run },
  { id: "coffee", label: "一杯咖啡为什么会变凉", group: "最近作品", run },
  { id: "theme", label: "切换到浅色主题", group: "操作", keywords: "theme dark light 外观", run },
];
const ids = (list: PaletteCommand[]) => list.map(item => item.id);

describe("filterCommands", () => {
  it("returns everything in order for an empty or blank query", () => {
    expect(ids(filterCommands(commands, ""))).toEqual(["project", "library", "brand", "coffee", "theme"]);
    expect(ids(filterCommands(commands, "   "))).toEqual(["project", "library", "brand", "coffee", "theme"]);
  });

  it("matches labels, groups and hidden keywords", () => {
    expect(ids(filterCommands(commands, "咖啡"))).toEqual(["coffee"]);
    expect(ids(filterCommands(commands, "最近"))).toEqual(["coffee"]);
    expect(ids(filterCommands(commands, "dark"))).toEqual(["theme"]);
  });

  it("is case-insensitive and normalizes full-width characters", () => {
    expect(ids(filterCommands(commands, "PROJECT"))).toEqual(["project"]);
    expect(ids(filterCommands(commands, "ＭＥＤＩＡ"))).toEqual(["library"]);
  });

  it("requires every term and lets terms match in any order", () => {
    expect(ids(filterCommands(commands, "前往 素材"))).toEqual(["library", "brand"]);
    expect(ids(filterCommands(commands, "素材 前往"))).toEqual(["library", "brand"]);
    expect(filterCommands(commands, "素材 咖啡")).toEqual([]);
  });

  it("ranks a label hit above a keyword-only hit", () => {
    // "素材" is the label of library but only a keyword of brand.
    expect(ids(filterCommands(commands, "素材"))).toEqual(["library", "brand"]);
  });

  it("ranks earlier label matches first and keeps input order for ties", () => {
    const list: PaletteCommand[] = [
      { id: "b", label: "新建作品", group: "操作", run },
      { id: "a", label: "作品库", group: "前往", run },
      { id: "c", label: "最近作品", group: "前往", run },
    ];
    expect(ids(filterCommands(list, "作品"))).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list when nothing matches and never mutates the input", () => {
    const before = ids(commands);
    expect(filterCommands(commands, "不存在的内容")).toEqual([]);
    expect(ids(commands)).toEqual(before);
  });
});

describe("groupCommands", () => {
  it("groups in first-seen order and keeps item order", () => {
    const grouped = groupCommands(filterCommands(commands, ""));
    expect(grouped.map(item => item.group)).toEqual(["前往", "最近作品", "操作"]);
    expect(ids(grouped[0]!.items)).toEqual(["project", "library", "brand"]);
  });

  it("handles an empty list", () => {
    expect(groupCommands([])).toEqual([]);
  });
});
