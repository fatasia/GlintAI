import { buildTimeline, type SceneScriptProject } from "@glintai/scenescript";
import type { Edge, Node } from "@xyflow/react";
import { libraryVisual, type LibraryVisual } from "./media-adoption";

export type SceneCardData = { title: string; description: string; order: number; duration: string; locked: boolean; thumbnail?: string };
export type SceneCardNode = Node<SceneCardData, "sceneCard">;
export type MaterialCardData = { name: string; kind: LibraryVisual["kind"] };
export type MaterialCardNode = Node<MaterialCardData, "materialCard">;
export type BoardNode = SceneCardNode | MaterialCardNode;
export type BoardPositions = Record<string, { x: number; y: number }>;
export const MATERIAL_LIMIT = 12;
const labels: Record<string, string> = { title: "标题", bullets: "要点", definition: "概念", quote: "引语", comparison: "对比", code: "代码", chart: "图表", image: "图片", video: "视频", diagram: "步骤", html: "动效", three: "三维" };

export function sceneBoard(project: SceneScriptProject, selectedId: string, positions: BoardPositions = {}): { nodes: SceneCardNode[]; edges: Edge[] } {
  const timeline = buildTimeline(project);
  const nodes: SceneCardNode[] = timeline.entries.map((entry, index) => {
    const scene = entry.scene;
    const heading = "title" in scene ? scene.title : "heading" in scene ? scene.heading : "term" in scene ? scene.term : undefined;
    const position = positions[scene.id];
    const visual = (scene.kind === "image" || scene.kind === "video") ? /^assets\/([a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4))$/.exec(scene.src) : null;
    return { id: scene.id, type: "sceneCard", selected: scene.id === selectedId, width: 240, height: 146,
      position: position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { ...position } : { x: index % 3 * 300, y: Math.floor(index / 3) * 210 },
      data: { title: heading?.trim() || `${labels[scene.kind] ?? "镜头"} ${index + 1}`, description: scene.narration.text, order: index + 1, duration: `${(entry.durationMs / 1000).toFixed(1)} 秒`, locked: Boolean(scene.locked), ...(visual ? { thumbnail: `/api/media/assets/${visual[1]}` } : {}) },
    };
  });
  // Connections are a reading guide only, never a second editable playback graph.
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ id: `order-${nodes[index]!.id}-${node.id}`, source: nodes[index]!.id, target: node.id, selectable: false, deletable: false, type: "smoothstep" })) };
}

/**
 * Library entries become reference cards, never project scenes. Invalid or non-visual names are
 * skipped here so the canvas can never turn an arbitrary response value into a media source.
 */
export function libraryVisuals(assets: unknown): LibraryVisual[] {
  if (!Array.isArray(assets)) return [];
  const visuals: LibraryVisual[] = [];
  for (const value of assets.slice(0, 500)) {
    if (visuals.length >= MATERIAL_LIMIT) break;
    if (!value || typeof value !== "object") continue;
    const name = (value as { name?: unknown }).name;
    if (typeof name !== "string") continue;
    try {
      const visual = libraryVisual(name);
      if (!visuals.some(item => item.name === visual.name)) visuals.push(visual);
    } catch { /* Unsafe or non-visual filenames never reach a node or preview. */ }
  }
  return visuals;
}

/** A fixed shelf to the right of the scene cards; material cards are references, not draggable layout. */
export function materialNodes(visuals: readonly LibraryVisual[], origin: { x: number; y: number } = { x: 0, y: 0 }): MaterialCardNode[] {
  return visuals.slice(0, MATERIAL_LIMIT).map((visual, index) => ({
    id: `material:${visual.name}`, type: "materialCard", draggable: false, deletable: false, width: 220, height: 116,
    position: { x: origin.x + index % 3 * 250, y: origin.y + Math.floor(index / 3) * 146 },
    data: { name: visual.name, kind: visual.kind },
  }));
}

export function readBoardPositions(raw: string | null): BoardPositions {
  if (!raw || raw.length > 50_000) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const output: BoardPositions = Object.create(null);
    for (const [id, value] of Object.entries(data).slice(0, 200)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !value || typeof value !== "object") continue;
      const { x, y } = value as { x: number; y: number };
      if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100_000 && Math.abs(y) <= 100_000) output[id] = { x, y };
    }
    return output;
  } catch { return {}; }
}
