import { describe, expect, it } from "vitest";
import { enumerateRoutes, expandRoute, validateGraph, type InteractiveGraph } from "./interactive";

const branching: InteractiveGraph = {
  version: 1, entry: "start",
  nodes: [
    { id: "start", sceneId: "scene-start", choices: [
      { label: "直言", goto: "honest", sets: ["trust-high"] },
      { label: "沉默", goto: "silent", requires: ["met-before"] },
    ] },
    { id: "honest", sceneId: "scene-honest", choices: [{ label: "收尾", goto: "end-a" }] },
    { id: "silent", sceneId: "scene-silent", choices: [{ label: "收尾", goto: "end-b" }] },
    { id: "end-a", sceneId: "scene-end-a", ending: true },
    { id: "end-b", sceneId: "scene-end-b", ending: true },
  ],
  states: ["trust-high", "met-before"],
};
const sceneIds = new Set(["scene-start", "scene-honest", "scene-silent", "scene-end-a", "scene-end-b"]);

describe("interactive graph validation", () => {
  it("accepts a well-formed branching graph and reports reachability", () => {
    const result = validateGraph(branching, sceneIds);
    expect(result.ok).toBe(true);
    expect(result.reachable).toHaveLength(5);
  });

  it("catches unknown goto, undeclared states, dead ends and missing scenes", () => {
    const broken: InteractiveGraph = {
      version: 1, entry: "start",
      nodes: [
        { id: "start", sceneId: "scene-start", choices: [{ label: "跳", goto: "ghost", sets: ["undeclared"] }] },
        { id: "trapped", sceneId: "nowhere" },
      ],
      states: [],
    };
    const result = validateGraph(broken, sceneIds);
    expect(result.ok).toBe(false);
    expect(result.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining(["unknown-goto", "unknown-state", "dead-end", "unreachable", "scene-missing"]));
  });

  it("flags duplicate nodes and a missing entry", () => {
    const duplicated: InteractiveGraph = { ...branching, nodes: [...branching.nodes, branching.nodes[0]!] };
    expect(validateGraph(duplicated, sceneIds).issues.some(issue => issue.kind === "duplicate-node")).toBe(true);
    expect(validateGraph({ ...branching, entry: "ghost" }, sceneIds).issues.some(issue => issue.kind === "entry-missing")).toBe(true);
  });
});

describe("route expansion", () => {
  it("expands the default route and an alternate route to linear scene sequences", () => {
    expect(expandRoute(branching)).toEqual({ choices: ["直言", "收尾"], scenes: ["scene-start", "scene-honest", "scene-end-a"], ending: "end-a" });
    expect(expandRoute(branching, new Map([["start", 1]]))).toEqual({ choices: ["沉默", "收尾"], scenes: ["scene-start", "scene-silent", "scene-end-b"], ending: "end-b" });
  });

  it("enumerates every acyclic route and skips cycles instead of looping", () => {
    const routes = enumerateRoutes(branching);
    expect(routes).toHaveLength(2);
    const cycled: InteractiveGraph = {
      version: 1, entry: "a",
      nodes: [
        { id: "a", sceneId: "s-a", choices: [{ label: "回", goto: "a" }, { label: "出", goto: "b" }] },
        { id: "b", sceneId: "s-b" },
      ],
      states: [],
    };
    expect(enumerateRoutes(cycled).map(route => route.ending)).toEqual(["b"]);
    expect(expandRoute(cycled)).toBeNull();
  });
});
