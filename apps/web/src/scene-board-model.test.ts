// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { libraryVisuals, materialNodes, readBoardPositions, sceneBoard } from "./scene-board-model";

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  function ReactFlowStub(props: any) {
    return React.createElement("div", { "data-testid": "flow" }, (props.nodes ?? []).map((node: any) =>
      React.createElement("div", { key: node.id, "data-node-type": node.type, onClick: () => props.onNodeClick?.({}, node) },
        React.createElement(props.nodeTypes[node.type], { id: node.id, type: node.type, data: node.data, selected: node.selected }))));
  }
  return { ReactFlow: ReactFlowStub, Background: () => null, Controls: () => null, Handle: () => null,
    Position: { Left: "left", Right: "right" }, applyNodeChanges: (_changes: unknown, nodes: unknown[]) => nodes };
});
import { SceneBoard } from "./SceneBoard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const project = parseProject({ schemaVersion: 1, id: "board", title: "Board", aspect: "16:9", knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: "First", narration: { text: "第一镜", durationMs: 1000 } },
  { id: "two", kind: "bullets", heading: "Second", items: ["a"], narration: { text: "第二镜", durationMs: 2000 }, locked: true },
] });
/** Editing target is a media scene, so replacement is allowed. */
const mediaProject = () => parseProject({ ...project, scenes: [
  { id: "one", kind: "image", src: "assets/old.png", narration: { text: "第一镜", durationMs: 1000 } },
  project.scenes[1]!,
] });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const buttonByText = (root: HTMLElement, text: string) => [...root.querySelectorAll("button")].find(button => button.textContent === text);
async function mountBoard(options: { project?: SceneScriptProject; selectedSceneId?: string; onAdopt?: ((name: string, mode: "replace" | "insert") => void) | null } = {}) {
  const current = options.project ?? mediaProject();
  const onAdopt = options.onAdopt === null ? undefined : options.onAdopt ?? vi.fn();
  const onSelect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const div = document.createElement("div"); document.body.appendChild(div);
  const root = createRoot(div); cleanup = () => act(() => root.unmount());
  await act(async () => { root.render(createElement(SceneBoard, { project: current, selectedSceneId: options.selectedSceneId ?? current.scenes[0]!.id, onSelect, ...(onAdopt ? { onAdopt } : {}) })); });
  const click = async (label: string) => {
    const target = [...div.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label);
    if (!target) throw new Error(`button not found: ${label}`);
    await act(async () => target.click());
  };
  const clickMaterial = async (name: string) => {
    const target = [...div.querySelectorAll('[aria-label="素材节点"]')].find(node => node.textContent?.includes(name)) as HTMLElement | undefined;
    if (!target) throw new Error(`material node not found: ${name}`);
    await act(async () => target.click());
  };
  return { div, onAdopt, onSelect, click, clickMaterial };
}

describe("scene board projection", () => {
  it("derives cards and reading order from one project without mutating it", () => {
    const before = JSON.stringify(project), graph = sceneBoard(project, "two");
    expect(graph.nodes.map(node => node.id)).toEqual(["one", "two"]);
    expect(graph.nodes[1]).toMatchObject({ selected: true, position: { x: 300, y: 0 }, data: { title: "Second", order: 2, duration: "2.0 秒", locked: true } });
    expect(graph.edges).toEqual([expect.objectContaining({ source: "one", target: "two", deletable: false, selectable: false })]);
    expect(JSON.stringify(project)).toBe(before);
  });
  it("keeps layout separate from clip order and falls back on invalid coordinates", () => {
    const moved = sceneBoard(project, "one", { one: { x: 999, y: 500 }, two: { x: NaN, y: 0 } });
    expect(moved.nodes[0]!.position).toEqual({ x: 999, y: 500 });
    expect(moved.nodes[1]!.position).toEqual({ x: 300, y: 0 });
    expect(moved.edges[0]!.source).toBe("one");
    expect(sceneBoard({ ...project, scenes: [] }, "missing")).toEqual({ nodes: [], edges: [] });
  });
  it("loads only bounded plain layout values and never source paths or project data", () => {
    expect(readBoardPositions('{"one":{"x":5,"y":9},"two":{"x":100001,"y":0},"bad id":{"x":1,"y":2}}')).toEqual({ one: { x: 5, y: 9 } });
    for (const value of [null, "{", "[]", '"value"', "x".repeat(50001)]) expect(readBoardPositions(value)).toEqual({});
    expect(readBoardPositions('{"__proto__":{"x":1,"y":2},"one":{"x":"3","y":2}}')).toEqual({});
  });
});

describe("library material nodes", () => {
  const assets = [
    { name: "clip.mp4" }, { name: "../escape.png" }, { name: "voice.mp3" }, { name: "clip.mp4" }, null, 42,
    ...Array.from({ length: 15 }, (_, index) => ({ name: `photo-${index}.png` })),
  ];
  it("projects at most 12 visual library entries, skipping unsafe and duplicate names", () => {
    const snapshot = JSON.stringify(assets), visuals = libraryVisuals(assets);
    expect(visuals).toHaveLength(12);
    expect(visuals[0]).toEqual({ name: "clip.mp4", kind: "video" });
    expect(visuals.slice(0, 3).map(visual => visual.name)).toEqual(["clip.mp4", "photo-0.png", "photo-1.png"]);
    expect(JSON.stringify(assets)).toBe(snapshot);
    for (const value of [null, undefined, {}, "assets", { assets: [] }]) expect(libraryVisuals(value)).toEqual([]);
  });
  it("lays references on a fixed shelf with stable ids and never mutates validated input", () => {
    const visuals = libraryVisuals(assets), snapshot = JSON.stringify(visuals), nodes = materialNodes(visuals, { x: 960, y: 0 });
    expect(nodes).toHaveLength(12);
    expect(nodes[0]).toMatchObject({ id: "material:clip.mp4", type: "materialCard", draggable: false, deletable: false,
      position: { x: 960, y: 0 }, data: { name: "clip.mp4", kind: "video" } });
    expect(nodes[3]!.position).toEqual({ x: 960, y: 146 });
    expect(JSON.stringify(visuals)).toBe(snapshot);
  });
});

describe("scene board library interactions", () => {
  it("never touches the network on mount and fetches safe materials only on 显示素材", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ assets: [
      { name: "clip.mp4" }, { name: "../escape.png" }, { name: "voice.mp3" },
      ...Array.from({ length: 13 }, (_, index) => ({ name: `photo-${index}.png` })), { name: "clip.mp4" },
    ] }));
    vi.stubGlobal("fetch", fetcher);
    const board = await mountBoard();
    expect(fetcher).not.toHaveBeenCalled();
    expect(board.div.querySelectorAll('[aria-label="素材节点"]')).toHaveLength(0);
    await board.click("显示素材"); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/media/library");
    expect(board.div.querySelectorAll('[aria-label="素材节点"]')).toHaveLength(12);
    expect(board.div.textContent).toContain("clip.mp4");
    expect(board.div.textContent).toContain("视频");
    expect(board.div.textContent).not.toContain("../escape.png");
    expect(board.div.textContent).not.toContain("voice.mp3");
    expect(board.div.querySelector('[aria-label="素材详情"]')).toBeNull();
  });
  it("previews on node selection without adopting and fires onAdopt only from explicit actions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ assets: [{ name: "clip.mp4" }, { name: "photo.png" }] })));
    const onAdopt = vi.fn(), board = await mountBoard({ onAdopt });
    await board.click("显示素材"); await settle();
    await board.clickMaterial("clip.mp4");
    expect(onAdopt).not.toHaveBeenCalled();
    const detail = board.div.querySelector('[aria-label="素材详情"]');
    expect(detail).not.toBeNull();
    expect(detail!.querySelector('video[aria-label="素材视频预览"]')?.getAttribute("src")).toBe("/api/media/assets/clip.mp4");
    expect(detail!.textContent).toContain("替换当前镜头素材");
    await board.click("替换当前镜头素材");
    expect(onAdopt).toHaveBeenLastCalledWith("clip.mp4", "replace");
    await board.click("添加为新镜头");
    expect(onAdopt).toHaveBeenLastCalledWith("clip.mp4", "insert");
    expect(onAdopt).toHaveBeenCalledTimes(2);
  });
  it("blocks replacement for structured scenes while keeping insert explicit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ assets: [{ name: "photo.png" }] })));
    const onAdopt = vi.fn(), board = await mountBoard({ project, selectedSceneId: "one", onAdopt });
    await board.click("显示素材"); await settle();
    await board.clickMaterial("photo.png");
    const detail = board.div.querySelector('[aria-label="素材详情"]')!;
    expect(detail.querySelector("img")?.getAttribute("src")).toBe("/api/media/assets/photo.png");
    expect(detail.textContent).toContain("仅支持添加为新镜头");
    expect(buttonByText(board.div, "替换当前镜头素材")!.disabled).toBe(true);
    expect(buttonByText(board.div, "添加为新镜头")!.disabled).toBe(false);
    await board.click("添加为新镜头");
    expect(onAdopt).toHaveBeenCalledWith("photo.png", "insert");
  });
  it("keeps the material detail read-only when adoption callbacks are not provided", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ assets: [{ name: "photo.png" }] })));
    const board = await mountBoard({ onAdopt: null });
    await board.click("显示素材"); await settle();
    await board.clickMaterial("photo.png");
    const detail = board.div.querySelector('[aria-label="素材详情"]')!;
    expect(detail.textContent).toContain("图片 · 来自素材库");
    expect(buttonByText(board.div, "替换当前镜头素材")!.disabled).toBe(true);
    expect(buttonByText(board.div, "添加为新镜头")!.disabled).toBe(true);
    expect(board.div.textContent).toContain("采用操作尚未接入");
  });
  it("keeps scene cards usable and reports a failed library read without material nodes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "down" }, { status: 500 })));
    const board = await mountBoard();
    expect(board.div.querySelectorAll('[data-node-type="sceneCard"]')).toHaveLength(2);
    await board.click("显示素材"); await settle();
    expect(board.div.querySelector('[role="alert"]')?.textContent).toContain("素材库暂不可用");
    expect(board.div.querySelectorAll('[aria-label="素材节点"]')).toHaveLength(0);
    expect(board.div.querySelectorAll('[data-node-type="sceneCard"]')).toHaveLength(2);
  });
  it("carries a library thumbnail only for safe image/video scenes", () => {
    const project = parseProject({ schemaVersion: 1, id: "thumbs", title: "Thumbs", aspect: "16:9", knowledgeSources: [], scenes: [
      { id: "pic", kind: "image", src: "assets/photo.png", narration: { text: "图", durationMs: 1000 } },
      { id: "clip", kind: "video", src: "assets/clip.mp4", narration: { text: "视频", durationMs: 1000 } },
      { id: "title", kind: "title", title: "文字", narration: { text: "字", durationMs: 1000 } },
    ] });
    const nodes = sceneBoard(project, "pic").nodes;
    expect(nodes[0]!.data).toMatchObject({ thumbnail: "/api/media/assets/photo.png" });
    expect(nodes[1]!.data).toMatchObject({ thumbnail: "/api/media/assets/clip.mp4" });
    expect((nodes[2]!.data as { thumbnail?: string }).thumbnail).toBeUndefined();
  });
});