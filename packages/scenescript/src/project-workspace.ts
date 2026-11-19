import { z } from "zod";
import { NleProject } from "./nle";
import { GenCanvas } from "./gen-canvas";

const generationReceipt = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  nodeCreatedAt: z.string().datetime(),
  taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  isFinal: z.boolean().optional(),
}).strict();
const viewportSchema = z.object({ x: z.number().finite().min(-1000000).max(1000000), y: z.number().finite().min(-1000000).max(1000000), zoom: z.number().finite().min(0.1).max(2.5) }).strict();
const generationSchema = z.object({
  canvas: GenCanvas,
  positions: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).refine(key => !["__proto__", "constructor", "prototype"].includes(key)), z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict()).refine(value => Object.keys(value).length <= 200),
  viewport: viewportSchema.optional(),
  receipts: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/), generationReceipt).refine(value => Object.keys(value).length <= 30),
}).strict().superRefine((value, ctx) => {
  for (const [id, receipt] of Object.entries(value.receipts)) {
    if (!value.canvas.nodes.some(node => node.id === id && node.createdAt === receipt.nodeCreatedAt))
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ["receipts", id], message: "receipt does not belong to this node"});
  }
});

/** Portable, bounded authoring context. Shared media files remain external references. */
export const PROJECT_WORKSPACE_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(200).refine(value => Boolean(value.trim()));
const title = z.string().min(1).max(500).refine(value => Boolean(value.trim()));
const time = z.number().finite().nonnegative();
export const projectBoardGroupsSchema = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), title: z.string().trim().min(1).max(100),
  members: z.array(z.string().min(1).max(500)).min(2).max(1500),
}).strict()).max(100).superRefine((groups, ctx) => {
  const ids = new Set<string>(), members = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) ctx.addIssue({ code:z.ZodIssueCode.custom, message:"duplicate board group" });
    ids.add(group.id);
    for (const member of group.members) {
      if (members.has(member)) ctx.addIssue({ code:z.ZodIssueCode.custom, message:"board member belongs to more than one group" });
      members.add(member);
    }
  }
  if(members.size>1500)ctx.addIssue({code:z.ZodIssueCode.custom,message:"too many grouped board items"});
});
export type ProjectBoardGroup = z.infer<typeof projectBoardGroupsSchema>[number];
const annotation = z.object({
  id, x: z.number().finite().min(0).max(100), y: z.number().finite().min(0).max(100),
  text: z.string().max(2000), nodeId: z.string().regex(/^[\w-]{1,100}$/).optional(), createdAt: time,
}).strict();
const page = z.object({
  id, title, html: z.string().max(1024 * 1024), notes: z.string().max(32000).optional(),
  annotations: z.array(annotation).max(200).optional(),
}).strict();
const design = z.object({
  id, title, kind: z.enum(["page", "prototype", "slides"]), pages: z.array(page).min(1).max(100),
  activePageId: id, updatedAt: time,
}).strict();
const safeText = (max: number) => z.string().min(1).max(max).refine(value => Boolean(value.trim()) && !/[\u0000-\u001f\u007f<>]/.test(value));
export const workspaceBrandSchema = z.object({
  name: safeText(60), accent: z.string().regex(/^#[\da-f]{6}$/i), bg: z.string().regex(/^#[\da-f]{6}$/i), text: z.string().regex(/^#[\da-f]{6}$/i),
  logoText: safeText(24).optional(), displayFont: safeText(400).refine(value => /^[\p{L}\p{N}\s,'"_-]+$/u.test(value)).optional(),
}).strict();
export const workspaceAssetSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/),
  url: z.string().regex(/^\/(?:api\/media\/assets|assets)\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/),
  bytes: z.number().int().min(1).max(512 * 1024),
}).strict().refine(value => value.url.split("/").at(-1) === value.name, "素材名与路径不一致");
const schema = z.object({
  version: z.literal(1), projectId: id,
  designs: z.object({ version: z.literal(1), projectId: id, documents: z.array(design).max(32), activeId: z.string().max(200) }).strict(),
  brand: workspaceBrandSchema.nullable(), assets: z.array(workspaceAssetSchema).max(40),
  generation: generationSchema.optional(),
  timeline: z.object({project:NleProject,bridge:z.object({sourceId:id,projectId:id,links:z.array(z.object({sceneId:id,trackId:id,clipId:id,startMs:time,durationMs:z.number().finite().positive()}).strict()).max(100)}).strict().nullable()}).strict().optional(),
  board: z.object({
    groups: projectBoardGroupsSchema.optional(),
    positions: z.record(z.string().min(1).max(500), z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict()).refine(value => Object.keys(value).length <= 1500),
    viewport: z.object({ x: z.number().finite().min(-1000000).max(1000000), y: z.number().finite().min(-1000000).max(1000000), zoom: z.number().finite().min(0.1).max(2.5) }).strict().optional(),
  }).strict().optional(),
}).strict();
export type ProjectWorkspace = z.infer<typeof schema>;

export function parseProjectWorkspace(value: unknown, projectId: string): ProjectWorkspace {
  let bytes: number;
  try {
    const seen = new Set<object>();
    function json(item: unknown): void {
      if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
      if (typeof item !== "object" || seen.has(item)) throw new Error();
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error();
      seen.add(item);
      if (Array.isArray(item)) { for (let index = 0; index < item.length; index++) { if (!Object.hasOwn(item, index)) throw new Error(); json(item[index]); } }
      else for (const entry of Object.values(item)) json(entry);
      seen.delete(item);
    }
    json(value);
    bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  }
  catch { throw new Error("工程附件必须是可序列化的 JSON。"); }
  if (bytes > PROJECT_WORKSPACE_BYTES) throw new Error("设计、品牌和素材索引超过 2 MiB，请拆分工程后保存版本。");
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("工程附件格式无效：设计、批注、品牌或素材引用不符合安全约定。");
  const state = result.data;
  if (state.projectId !== projectId || state.designs.projectId !== projectId) throw new Error("工程附件不属于当前工程。");
  if(state.timeline&&(state.timeline.project.id!==projectId||state.timeline.bridge&&state.timeline.bridge.projectId!==projectId))throw new Error("关联剪辑不属于当前工程。");
  const unique = (values: string[]) => new Set(values).size === values.length;
  const docs = state.designs.documents;
  if (!unique(docs.map(doc => doc.id)) || (docs.length ? !docs.some(doc => doc.id === state.designs.activeId) : state.designs.activeId !== "") ||
    docs.reduce((sum, doc) => sum + doc.pages.length, 0) > 100 || !unique(state.assets.map(asset => asset.name))) throw new Error("工程附件含重复身份、无效活动文档或超过 100 页。");
  for (const doc of docs) {
    if (!unique(doc.pages.map(page => page.id)) || !doc.pages.some(page => page.id === doc.activePageId) ||
      doc.pages.some(page => new TextEncoder().encode(page.html).length > 1024 * 1024 || !unique((page.annotations ?? []).map(mark => mark.id)))) throw new Error("设计页面身份、活动页面、批注或 HTML 大小无效。");
  }
  return state;
}

/** A copied project retains its editable timeline but gets a new shared identity. */
export function copyProjectWorkspace(value:ProjectWorkspace,projectId:string):ProjectWorkspace {
 return parseProjectWorkspace({...value,projectId,designs:{...value.designs,projectId},...(value.timeline?{timeline:{project:{...value.timeline.project,id:projectId},bridge:value.timeline.bridge?{...value.timeline.bridge,projectId}:null}}:{})},projectId);
}
