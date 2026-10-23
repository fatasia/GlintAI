import { describe, expect, it } from "vitest";
import {
  BuildGraphError,
  canonicalJson,
  checkBudget,
  computeDigests,
  createBuildGraph,
  createManifest,
  environmentDrift,
  nodeDigest,
  provenanceCovers,
  planBuild,
  sha256Hex,
  topologicalOrder,
  validateReceipt,
  type BuildNode,
  type EnvironmentFingerprint,
  type Receipt,
} from "./index";

const env: EnvironmentFingerprint = { node: "22.11.0", platform: "win32", os: "10.0", resvg: "2.6.2", fonts: "abc" };
const chain: BuildNode[] = [
  { id: "source", kind: "shot/spec", inputs: [], params: { text: "a" }, estimatedMs: 5 },
  { id: "scene", kind: "scene/eval", inputs: ["source"], params: { title: "a" }, estimatedMs: 100 },
  { id: "container", kind: "container", inputs: ["scene"], params: { fps: 30 }, estimatedMs: 50 },
];

describe("graph validation", () => {
  it("rejects duplicate ids", () => {
    expect(() => createBuildGraph([{ id: "a", kind: "scene/eval", inputs: [] }, { id: "a", kind: "container", inputs: [] }])).toThrow(BuildGraphError);
  });
  it("rejects unknown inputs", () => {
    expect(() => createBuildGraph([{ id: "a", kind: "scene/eval", inputs: ["ghost"] }])).toThrow(/unknown input/);
  });
  it("rejects cycles instead of hanging", () => {
    expect(() => createBuildGraph([
      { id: "a", kind: "scene/eval", inputs: ["b"] },
      { id: "b", kind: "container", inputs: ["a"] },
    ])).toThrow(/cycle/);
  });
  it("accepts a diamond and orders dependencies first", () => {
    const graph = createBuildGraph([
      { id: "root", kind: "shot/spec", inputs: [] },
      { id: "left", kind: "scene/eval", inputs: ["root"] },
      { id: "right", kind: "scene/eval", inputs: ["root"] },
      { id: "join", kind: "container", inputs: ["left", "right"] },
    ]);
    const order = topologicalOrder(graph);
    expect(order.indexOf("root")).toBe(0);
    expect(order.indexOf("join")).toBe(3);
  });
});

describe("digests", () => {
  it("hashes known bytes", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
  it("is independent of object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("changes when params, inputs or environment change", () => {
    const base = computeDigests(createBuildGraph(chain), env);
    const paramsChanged = computeDigests(createBuildGraph(chain.map(node => node.id === "scene" ? { ...node, params: { title: "b" } } : node)), env);
    const envChanged = computeDigests(createBuildGraph(chain), { ...env, resvg: "2.7.0" });
    expect(paramsChanged.scene).not.toBe(base.scene);
    expect(paramsChanged.container).not.toBe(base.container);
    expect(paramsChanged.source).toBe(base.source);
    expect(envChanged.scene).not.toBe(base.scene);
  });
  it("refuses to digest a node before its inputs", () => {
    const graph = createBuildGraph(chain);
    expect(() => nodeDigest(graph.nodes[1]!, env, {})).toThrow(/Missing digest/);
  });
});

describe("change budget", () => {
  it("rebuilds a changed node and its dependents only", () => {
    const graph = createBuildGraph(chain);
    const first = planBuild(graph, undefined, env);
    expect(first.predicted).toEqual(["source", "scene", "container"]);
    expect(first.estimatedMs).toBe(155);
    const manifest = createManifest(first, env);
    const next = computeDigests(createBuildGraph(chain.map(node => node.id === "scene" ? { ...node, params: { title: "b" } } : node)), env);
    const plan = planBuild(createBuildGraph(chain.map(node => node.id === "scene" ? { ...node, params: { title: "b" } } : node)), { ...manifest, digests: { ...manifest.digests } }, env);
    expect(plan.changed).toEqual(["scene", "container"]);
    expect(plan.reused).toEqual(["source"]);
    expect(next.scene).toBe(plan.digests.scene);
  });
  it("propagates a forced execution to dependents even when digests match", () => {
    const graph = createBuildGraph(chain);
    const manifest = createManifest(planBuild(graph, undefined, env), env);
    const plan = planBuild(graph, manifest, env, ["scene"]);
    expect(plan.changed).toEqual([]);
    expect(plan.forced).toEqual(["scene"]);
    expect(plan.predicted).toEqual(["scene", "container"]);
    expect(plan.reused).toEqual(["source"]);
  });
  it("compares predicted and actual exactly", () => {
    const plan = planBuild(createBuildGraph(chain), undefined, env);
    expect(checkBudget(plan, ["source", "scene", "container"])).toEqual({ matches: true, missing: [], extra: [] });
    expect(checkBudget(plan, ["scene", "container"])).toEqual({ matches: false, missing: ["source"], extra: [] });
    expect(checkBudget(plan, ["source", "scene", "container", "ghost"])).toEqual({ matches: false, missing: [], extra: ["ghost"] });
  });
});

describe("receipt contract", () => {
  const receipt: Receipt = {
    format: "glint-receipt", version: 1,
    project: { id: "demo", revision: "sha256:abc" },
    reproducibility: "L0",
    environment: env,
    plan: { predicted: ["scene"], actual: ["scene"], matches: true },
    nodes: [{ id: "scene", kind: "scene/eval", digest: "a".repeat(64), executability: "deterministic", reused: false, costCny: 0 }],
    output: { path: "out.mp4", sha256: "b".repeat(64), bytes: 10 },
    verification: [{ law: "L1", pass: true }],
    totals: { modelCalls: 0, costCny: 0, wallMs: 12, executed: 1, reused: 0 },
  };
  it("accepts a valid receipt", () => {
    expect(validateReceipt(structuredClone(receipt)).project.id).toBe("demo");
  });
  it("rejects a wrong format, version or hash", () => {
    expect(() => validateReceipt({ ...receipt, format: "other" })).toThrow(/format/);
    expect(() => validateReceipt({ ...receipt, version: 2 })).toThrow(/version/);
    expect(() => validateReceipt({ ...receipt, output: { ...receipt.output!, sha256: "nope" } })).toThrow(/output/);
  });
  it("reports environment drift key by key", () => {
    expect(environmentDrift(env, { ...env, resvg: "2.7.0", browser: "x" })).toEqual(["resvg: 2.6.2 → 2.7.0", "browser: unset → x"]);
    expect(environmentDrift({ ...env, extra: { source: "a" } }, { ...env, extra: { source: "b" } })).toEqual(["extra.source: a → b"]);
  });
});

describe("provenance coverage", () => {
  const range = (start: number, end: number) => ({ frameRange: [start, end] as [number, number], origin: "rendered" as const });
  it("accepts exact coverage", () => {
    expect(provenanceCovers(6, [range(0, 1), range(2, 4), range(5, 5)])).toBe(true);
  });
  it("rejects gaps, overlaps and out-of-range frames", () => {
    expect(provenanceCovers(6, [range(0, 1), range(3, 5)])).toBe(false);
    expect(provenanceCovers(6, [range(0, 3), range(3, 5)])).toBe(false);
    expect(provenanceCovers(6, [range(0, 5), range(6, 6)])).toBe(false);
    expect(provenanceCovers(0, [])).toBe(false);
  });
});