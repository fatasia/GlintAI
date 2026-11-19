import type { SceneScriptProject } from "@glintai/scenescript";
import { parseProject } from "@glintai/scenescript";
import { describe, expect, it } from "vitest";
import { canonBrief, canonLint, parseCanonTable, unusedCanonEntries } from "./canon";

const table = parseCanonTable({
  version: 1,
  entries: [
    { id: "hero", kind: "character", name: "林拾", aliases: ["小拾"], forbidden: ["林十"], facts: ["左撇子", "怕水"] },
    { id: "city", kind: "location", name: "雾川", facts: ["常年多雾"] },
    { id: "ghost", kind: "prop", name: "从未出场的东西", aliases: [] },
  ],
});

describe("canon brief injection", () => {
  it("renders names, aliases and facts as a compact prompt block", () => {
    expect(canonBrief(table)).toContain("- 林拾（又称 小拾）：左撇子；怕水");
    expect(canonBrief(table)).toContain("- 雾川：常年多雾");
    expect(canonBrief(parseCanonTable(null))).toBe("");
  });
  it("degrades a corrupt table to empty instead of throwing", () => {
    expect(parseCanonTable({ version: 9, entries: "nope" }).entries).toEqual([]);
  });
});

describe("canon consistency lint", () => {
  const scenes = [
    { id: "one", text: "林拾在雾川的码头醒来。" },
    { id: "two", text: "林十不怕水，这很反常。" },
  ];
  it("flags forbidden legacy names per scene", () => {
    const issues = canonLint(table, scenes);
    expect(issues).toEqual([{ kind: "forbidden-name", sceneId: "two", detail: expect.stringContaining("林十") }]);
  });
  it("flags two entries claiming the same name", () => {
    const conflicting = parseCanonTable({ version: 1, entries: [
      { id: "a", kind: "character", name: "雾川" },
      { id: "city", kind: "location", name: "雾川" },
    ] });
    expect(canonLint(conflicting, []).map(issue => issue.kind)).toEqual(["duplicate-name"]);
  });
  it("reports entries that never appear in any scene", () => {
    expect(unusedCanonEntries(table, scenes)).toEqual(["ghost"]);
  });
});

describe("canon brief reaches the compose prompt", () => {
  it("is exported with the composer surface for system-prompt injection", async () => {
    const composer = await import("./index");
    expect(Object.keys(composer)).toContain("canonBrief");
  });
  it("keeps a canon-annotated project parseable", () => {
    expect(() => parseProject({ schemaVersion: 1, id: "canon", title: "T", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "林拾", narration: { text: "林拾在雾川。" } }] })).not.toThrow();
  });
});
