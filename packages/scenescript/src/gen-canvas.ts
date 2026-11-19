import { z } from "zod";

/**
 * Gen-canvas contract (Fodor-style generation DAG, independently designed):
 * a node is one generation intent feeding the shared media library; edges are
 * text context or image references. The canvas
 * itself never renders video — it plans generation; outputs land in the media
 * library and can be added to the NLE from there, exactly like manual uploads.
 */

const nodeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const ISO = z.string().datetime();

export const GenNodeKind = z.enum(["text", "image", "video", "audio"]);
export type GenNodeKind = z.infer<typeof GenNodeKind>;

export const GenNodeState = z.enum(["draft", "queued", "running", "done", "failed"]);
export type GenNodeState = z.infer<typeof GenNodeState>;

export const GenNode = z.object({
  id: nodeId,
  kind: GenNodeKind,
  /** What to generate; {{nodeId}} refs upstream outputs' prompts. */
  prompt: z.string().min(1).max(2000),
  /** Gateway model id; empty = pick first of the kind. */
  model: z.string().max(120),
  state: GenNodeState,
  /** Media-library asset produced by this node (done only). */
  outputAsset: z.string().max(200),
  outputCost: z.number().optional(),
  error: z.string().max(400),
  createdAt: ISO,
  updatedAt: ISO,
}).strict();
export type GenNode = z.infer<typeof GenNode>;

export const GenEdge = z.object({
  from: nodeId,
  to: nodeId,
}).strict();
export type GenEdge = z.infer<typeof GenEdge>;

export const GenCanvas = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(GenNode).max(30),
  edges: z.array(GenEdge).max(60),
}).strict().superRefine((canvas, ctx) => {
  const ids = new Set<string>();
  canvas.nodes.forEach((node, index) => {
    if (ids.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", index, "id"], message: "duplicate node id" });
    ids.add(node.id);
  });
  const links = new Set<string>();
  canvas.edges.forEach((edge, index) => {
    const key = `${edge.from}\0${edge.to}`;
    if (links.has(key)) ctx.addIssue({code:z.ZodIssueCode.custom,path:["edges",index],message:"duplicate edge"});
    links.add(key);
    if (edge.from === edge.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: "self edge" });
    for (const end of [edge.from, edge.to] as const) {
      if (!ids.has(end)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", index], message: `edge references unknown node ${end}` });
    }
  });
  // Validate imported/restored DAGs too, not only links made through the UI.
  const degree = new Map([...ids].map(id => [id,0]));
  for (const edge of canvas.edges) if (ids.has(edge.from) && ids.has(edge.to)) degree.set(edge.to,degree.get(edge.to)!+1);
  const ready = [...ids].filter(id=>degree.get(id)===0); let visited=0;
  while (ready.length) {
    const id=ready.pop()!;visited++;
    for (const edge of canvas.edges) if (edge.from===id && degree.has(edge.to)) {
      const next=degree.get(edge.to)!-1;degree.set(edge.to,next);if(next===0)ready.push(edge.to);
    }
  }
  if (visited!==ids.size) ctx.addIssue({code:z.ZodIssueCode.custom,path:["edges"],message:"generation graph contains a cycle"});
});
export type GenCanvas = z.infer<typeof GenCanvas>;

export function parseGenCanvas(value: unknown): GenCanvas { return GenCanvas.parse(value); }

export function emptyGenCanvas(): GenCanvas {
  return { schemaVersion: 1, nodes: [], edges: [] };
}

const now = () => new Date().toISOString();

export function addGenNode(canvas: GenCanvas, kind: GenNodeKind, prompt: string): GenCanvas {
  const used = new Set(canvas.nodes.map(node => node.id));
  let seed = `${kind}-${canvas.nodes.length + 1}`;
  while (used.has(seed)) seed = `${seed}-x`;
  const node: GenNode = { id: seed, kind, prompt, model: "", state: "draft", outputAsset: "", error: "", createdAt: now(), updatedAt: now() };
  return parseGenCanvas({ ...canvas, nodes: [...canvas.nodes, node] });
}

/** Link two existing nodes without creating a cycle. */
export function linkGenNodes(canvas: GenCanvas, from: string, to: string): GenCanvas {
  if (from === to) return canvas;
  if (canvas.edges.some(edge => edge.from === from && edge.to === to)) return canvas;
  // Adding from → to is invalid if to can already reach from.
  const pending = [to], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === from) return canvas;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...canvas.edges.filter(edge => edge.from === id).map(edge => edge.to));
  }
  return parseGenCanvas({ ...canvas, edges: [...canvas.edges, { from, to }] });
}

export function removeGenNode(canvas: GenCanvas, id: string): GenCanvas {
  return parseGenCanvas({ schemaVersion: 1, nodes: canvas.nodes.filter(node => node.id !== id), edges: canvas.edges.filter(edge => edge.from !== id && edge.to !== id) });
}

/**
 * Ready order: a node is runnable when it is a draft and every upstream
 * dependency is done. The parser rejects cycles in imported/restored canvases.
 */
export function runnableGenNodes(canvas: GenCanvas): GenNode[] {
  const byId = new Map(canvas.nodes.map(node => [node.id, node]));
  const done = (id: string): boolean => byId.get(id)?.state === "done";
  return canvas.nodes.filter(node => node.state === "draft" && canvas.edges.filter(edge => edge.to === node.id).every(edge => done(edge.from)));
}

/**
 * Resolve a node's effective prompt: upstream done nodes contribute their
 * text content as context lines. Media assets are not passed as reference here.
 */
export function resolveGenPrompt(canvas: GenCanvas, node: GenNode): string {
  const byId = new Map(canvas.nodes.map(item => [item.id, item]));
  const seen = new Set<string>([node.id]);
  const lines: string[] = [];
  const visit = (id: string) => {
    for (const edge of canvas.edges.filter(item => item.to === id)) {
      const source = byId.get(edge.from);
      if (!source || seen.has(source.id) || source.state !== "done" || source.kind !== "text") continue;
      seen.add(source.id);
      visit(source.id);
      lines.push(`[文本 ${source.id}] ${source.prompt}`);
    }
  };
  visit(node.id);
  return [...lines, node.prompt].join("\n");
}
