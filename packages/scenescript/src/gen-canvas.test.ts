import { describe, expect, it } from "vitest";
import { parseGenCanvas, emptyGenCanvas, addGenNode, linkGenNodes, removeGenNode, runnableGenNodes, resolveGenPrompt } from "./gen-canvas";

const draft = (id: string, kind: "text" | "image" | "video" | "audio" = "image", state: "draft" | "done" = "draft") =>
  ({ id, kind, prompt: `p-${id}`, model: "", state, outputAsset: state === "done" ? `assets/${id}.png` : "", error: "", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" });

describe("gen canvas contract", () => {
  it("adds nodes with stable ids and validates the whole canvas", () => {
    let canvas = emptyGenCanvas();
    canvas = addGenNode(canvas, "text", "剧本");
    canvas = addGenNode(canvas, "image", "画面");
    expect(canvas.nodes.map(node => node.id)).toEqual(["text-1", "image-2"]);
    expect(() => parseGenCanvas({ schemaVersion: 1, nodes: [draft("a"), draft("a")], edges: [] })).toThrow(/duplicate/);
    expect(() => parseGenCanvas({ schemaVersion: 1, nodes: [draft("a")], edges: [{ from: "a", to: "ghost" }] })).toThrow(/unknown node/);
    expect(() => parseGenCanvas({ schemaVersion: 1, nodes: [draft("a")], edges: [{ from: "a", to: "a" }] })).toThrow(/self edge/);
  });
  it("removes a node together with its edges", () => {
    let canvas = parseGenCanvas({ schemaVersion: 1, nodes: [draft("a"), draft("b"), draft("c")], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] });
    canvas = removeGenNode(canvas, "b");
    expect(canvas.nodes.map(node => node.id)).toEqual(["a", "c"]);
    expect(canvas.edges).toEqual([]);
  });
  it("rejects links that create cycles", () => {
    const canvas = parseGenCanvas({ schemaVersion: 1, nodes: [draft("a"), draft("b"), draft("c")], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] });
    expect(linkGenNodes(canvas, "c", "a").edges).toHaveLength(2);
  });
  it("runs only drafts whose upstream is done", () => {
    const canvas = parseGenCanvas({ schemaVersion: 1, nodes: [draft("a", "text", "done"), draft("b"), draft("c")], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] });
    expect(runnableGenNodes(canvas).map(node => node.id)).toEqual(["b"]);
  });
  it("resolves a node prompt with upstream done outputs as context", () => {
    const canvas = parseGenCanvas({ schemaVersion: 1, nodes: [draft("a", "text", "done"), draft("b")], edges: [{ from: "a", to: "b" }] });
    const resolved = resolveGenPrompt(canvas, canvas.nodes[1]!);
    expect(resolved).toContain("[文本 a] p-a");
    expect(resolved).not.toContain("assets/a.png");
    expect(resolved).toContain("p-b");
  });
});

it("rejects imported cycles and duplicate links but permits converging dependencies",()=>{
 const nodes=[draft("a"),draft("b"),draft("c"),draft("d")];
 const diamond=[{from:"a",to:"b"},{from:"a",to:"c"},{from:"b",to:"d"},{from:"c",to:"d"}];
 expect(parseGenCanvas({schemaVersion:1,nodes,edges:diamond}).edges).toHaveLength(4);
 expect(()=>parseGenCanvas({schemaVersion:1,nodes,edges:[...diamond,{from:"d",to:"a"}]})).toThrow(/cycle/);
 expect(()=>parseGenCanvas({schemaVersion:1,nodes,edges:[...diamond,diamond[0]]})).toThrow(/duplicate edge/);
});
