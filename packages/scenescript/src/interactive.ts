import { z } from "zod";

/**
 * Interactive film-game graph (ADR-013.1): nodes reference existing SceneScript
 * scenes; choices carry state effects; endings terminate a route. Playback is a
 * playback-layer concept — every route expands to a linear scene sequence, so
 * export stays the existing linear pipeline.
 */

export const InteractiveChoice = z.object({
  label: z.string().min(1).max(80),
  goto: z.string().min(1).max(80),
  /** State flags that must hold for this choice to be offered. */
  requires: z.array(z.string().min(1).max(64)).max(16).optional(),
  /** State flags set when the choice is taken. */
  sets: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type InteractiveChoice = z.infer<typeof InteractiveChoice>;

export const InteractiveNode = z.object({
  id: z.string().min(1).max(80),
  /** Existing SceneScript scene id — the graph never invents footage. */
  sceneId: z.string().min(1).max(80),
  choices: z.array(InteractiveChoice).max(8).optional(),
  /** Endings terminate a route; a node with choices may still be an ending. */
  ending: z.boolean().optional(),
});
export type InteractiveNode = z.infer<typeof InteractiveNode>;

export const InteractiveGraph = z.object({
  version: z.literal(1),
  entry: z.string().min(1).max(80),
  nodes: z.array(InteractiveNode).min(1).max(200),
  /** State flags choices may require/set; undeclared flags are a validation error. */
  states: z.array(z.string().min(1).max(64)).max(64).default([]),
});
export type InteractiveGraph = z.infer<typeof InteractiveGraph>;

export interface InteractiveIssue {
  kind: "unknown-goto" | "dead-end" | "unreachable" | "unknown-state" | "duplicate-node" | "entry-missing" | "scene-missing";
  node?: string;
  detail: string;
}

export interface InteractiveValidation {
  ok: boolean;
  issues: InteractiveIssue[];
  /** Nodes reachable from the entry (entry included). */
  reachable: string[];
}

/** Full structural validation: entry exists, every goto/state reference
 * resolves, no unreachable node, and every non-ending node offers a choice. */
export function validateGraph(graph: InteractiveGraph, sceneIds: ReadonlySet<string> | ReadonlyArray<string>): InteractiveValidation {
  const scenes = sceneIds instanceof Set ? sceneIds : new Set(sceneIds);
  const issues: InteractiveIssue[] = [];
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  if (graph.nodes.length !== byId.size) {
    for (const [id, count] of [...graph.nodes.reduce((map, node) => map.set(node.id, (map.get(node.id) ?? 0) + 1), new Map<string, number>())]) {
      if (count > 1) issues.push({ kind: "duplicate-node", node: id, detail: `节点 "${id}" 重复定义 ${count} 次` });
    }
  }
  if (!byId.has(graph.entry)) issues.push({ kind: "entry-missing", detail: `入口节点 "${graph.entry}" 不存在` });
  const states = new Set(graph.states);
  for (const node of graph.nodes) {
    if (!scenes.has(node.sceneId)) issues.push({ kind: "scene-missing", node: node.id, detail: `节点 "${node.id}" 引用的镜头 "${node.sceneId}" 不在工程里` });
    const choices = node.choices ?? [];
    if (!choices.length && !node.ending) issues.push({ kind: "dead-end", node: node.id, detail: `节点 "${node.id}" 既无选项也不是结局，路线会卡死` });
    for (const choice of choices) {
      if (!byId.has(choice.goto)) issues.push({ kind: "unknown-goto", node: node.id, detail: `节点 "${node.id}" 的选项「${choice.label}」指向不存在的节点 "${choice.goto}"` });
      for (const flag of [...choice.requires ?? [], ...choice.sets ?? []]) {
        if (!states.has(flag)) issues.push({ kind: "unknown-state", node: node.id, detail: `节点 "${node.id}" 用到未声明的状态 "${flag}"` });
      }
    }
  }
  const reachable = new Set<string>();
  if (byId.has(graph.entry)) {
    const queue = [graph.entry];
    while (queue.length) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const choice of byId.get(id)?.choices ?? []) if (byId.has(choice.goto)) queue.push(choice.goto);
    }
  }
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) issues.push({ kind: "unreachable", node: node.id, detail: `节点 "${node.id}" 从入口不可达` });
  }
  return { ok: issues.length === 0, issues, reachable: [...reachable] };
}

export interface InteractiveRoute {
  /** Choice labels taken along the route, in order. */
  choices: string[];
  /** Linear scene sequence for playback/export (existing linear pipeline). */
  scenes: string[];
  ending: string;
}

/** Expand one route by taking the given (default: first) choice at each node —
 * deterministic preview/export of a single path. Returns null on a cycle. */
export function expandRoute(graph: InteractiveGraph, firstChoiceForEachNode?: ReadonlyMap<string, number>): InteractiveRoute | null {
  if (!graph.nodes.some(node => node.id === graph.entry)) return null;
  const route: InteractiveRoute = { choices: [], scenes: [], ending: "" };
  const visited = new Set<string>();
  let current = graph.entry;
  while (!visited.has(current)) {
    visited.add(current);
    const node = graph.nodes.find(item => item.id === current)!;
    route.scenes.push(node.sceneId);
    const options = node.choices ?? [];
    if (!options.length) { route.ending = node.id; return route; }
    const choice = options[firstChoiceForEachNode?.get(node.id) ?? 0];
    if (!choice) { route.ending = node.id; return route; }
    route.choices.push(choice.label);
    current = choice.goto;
  }
  return null; // a choice cycle cannot become a linear route
}

/** Every acyclic route from entry to a choice-less node — the basis for
 * per-route linear export. Cycles are skipped, not followed. */
export function enumerateRoutes(graph: InteractiveGraph, limit = 64): InteractiveRoute[] {
  const routes: InteractiveRoute[] = [];
  const walk = (id: string, taken: string[], scenes: string[], visited: Set<string>) => {
    if (routes.length >= limit) return;
    const node = graph.nodes.find(item => item.id === id);
    if (!node || visited.has(id)) return;
    const nextScenes = [...scenes, node.sceneId];
    const options = node.choices ?? [];
    if (!options.length) {
      routes.push({ choices: taken, scenes: nextScenes, ending: node.id });
      return;
    }
    for (const choice of options) walk(choice.goto, [...taken, choice.label], nextScenes, new Set([...visited, id]));
  };
  if (graph.nodes.some(node => node.id === graph.entry)) walk(graph.entry, [], [], new Set());
  return routes;
}
