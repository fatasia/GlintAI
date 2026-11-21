import os from "node:os";
import { parseNleProject, parseProject, sceneDurationMs } from "@glintai/scenescript";
import {
  createBuildGraph, computeDigests, planBuild,
  type BuildGraph, type BuildNode, type EnvironmentFingerprint,
} from "@glintai/buildgraph";
import { isContainerDocument } from "@glintai/scenescript/project-container-v2";
import { nleRenderDurationMs } from "./nle-render-options.ts";

/**
 * K-03 read-only impact preview: maps the container's active scene documents
 * onto the buildgraph contract and answers "what would rebuild" with
 * planBuild — before any paid or slow action runs. Nothing here writes a
 * manifest, executes a node or contacts a provider; digests are computed
 * fresh per call and never persisted.
 */

// Same estimating basis as apps/studio/scripts/build.ts, so preview numbers are
// comparable with CLI build receipts. Local renders cost nothing but take time.
const SCENE_MS_PER_SECOND = 18;
const AUDIO_MIX_MS = 400;
const CONTAINER_MS = 300;
const MAX_INTENT_ITEMS = 100;
const MAX_INTENT_ID_LENGTH = 200;

export interface PlanPreviewIntent { objectIds?: string[]; sceneIds?: string[] }

export interface PlanPreviewImpact {
  totalNodes: number;
  /** Nodes that would execute, in dependency order. */
  predicted: string[];
  reusedCount: number;
  estimatedMs: number;
  /** Local render spend is always 0; AIGC spend is quoted separately (media quotes). */
  costCny: number;
  costType: "local-free" | "quote-required";
  /** Generated-pixel scenes inside the rebuild closure: quote before approving execution. */
  quoteRequired: { nodeId: string; sceneId: string }[];
  /** Container document ids owning predicted scene nodes. */
  affectedObjects: string[];
}

export interface PlanPreviewReply {
  version: 1;
  projectId: string;
  revision: number;
  scope: "all" | "intent";
  impact: PlanPreviewImpact;
  /** Timeline documents cannot ride planBuild; their export metrics are measured actuals. */
  timelineExports: { objectId: string; clips: number; durationMs: number }[];
  /** Intent entries that map to no planBuild node (e.g. timeline documents). */
  unmappedIntents: string[];
  notes: string[];
}

export class PlanPreviewError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
    this.name = "PlanPreviewError";
  }
}

const intentId = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_INTENT_ID_LENGTH) throw new PlanPreviewError(400, `意图字段 ${field} 含非法 id`);
  return value;
};

/** Strict shape; unknown fields or empty lists are refused instead of silently widened. */
export function parsePlanPreviewIntent(value: unknown): PlanPreviewIntent {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanPreviewError(400, "意图必须是对象");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "objectIds" && key !== "sceneIds")) throw new PlanPreviewError(400, "意图含未知字段");
  const list = (field: "objectIds" | "sceneIds"): string[] | undefined => {
    const raw = record[field];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_INTENT_ITEMS) throw new PlanPreviewError(400, `意图 ${field} 必须是 1..${MAX_INTENT_ITEMS} 个 id`);
    return raw.map(item => intentId(item, field));
  };
  const intent = { objectIds: list("objectIds"), sceneIds: list("sceneIds") };
  if (!intent.objectIds && !intent.sceneIds) throw new PlanPreviewError(400, "意图为空:至少提供一个 objectId 或 sceneId");
  return intent;
}

interface PreviewDocument { id: string; kind: string; payload?: unknown }
interface SceneNodeSource { objectId: string; sceneId: string; kind: string; durationMs: number; generated: boolean }

interface PreviewGraph {
  graph: BuildGraph | undefined;
  nodeObject: Record<string, string>;
  sceneNodes: Map<string, string>;
  aigcNodes: Set<string>;
  timelineExports: PlanPreviewReply["timelineExports"];
  notes: string[];
}

/** Scene nodes mirror the CLI build (`scene:<sceneId>`), so previews stay comparable with build receipts. */
function sceneNodeSources(documents: PreviewDocument[], notes: string[]): SceneNodeSource[] {
  const sources: SceneNodeSource[] = [];
  const read = (scene: { id: string; kind: string; provenance?: { origin?: string } }): SceneNodeSource => ({
    sceneId: scene.id,
    kind: scene.kind,
    durationMs: sceneDurationMs(scene as Parameters<typeof sceneDurationMs>[0]),
    generated: scene.provenance?.origin === "generated",
  });
  for (const document of documents) {
    if (document.kind !== "scene-document") continue;
    let scenes: { id: string; kind: string; provenance?: { origin?: string } }[];
    try {
      scenes = parseProject(document.payload).scenes as unknown as typeof scenes;
    } catch {
      notes.push(`分镜文档 ${document.id} 无法解析，未纳入影响预测。`);
      continue;
    }
    for (const scene of scenes) sources.push({ objectId: document.id, ...read(scene) });
  }
  return sources;
}

function previewGraphFrom(documents: PreviewDocument[]): PreviewGraph {
  const notes: string[] = [];
  const nodeObject: Record<string, string> = {};
  const sceneNodes = new Map<string, string>();
  const aigcNodes = new Set<string>();
  const timelineExports: PlanPreviewReply["timelineExports"] = [];
  const nodes: BuildNode[] = [];
  for (const source of sceneNodeSources(documents, notes)) {
    const id = `scene:${source.sceneId}`;
    if (sceneNodes.has(source.sceneId)) throw new PlanPreviewError(400, `镜头 id 跨文档重复，无法预测: ${source.sceneId}`);
    sceneNodes.set(source.sceneId, id);
    nodeObject[id] = source.objectId;
    if (source.generated) aigcNodes.add(id);
    nodes.push({
      id, kind: "scene/eval", inputs: [],
      params: { sceneId: source.sceneId, kind: source.kind, durationMs: Math.round(source.durationMs) },
      granularity: "scene",
      estimatedMs: Math.max(1, Math.round((source.durationMs / 1000) * SCENE_MS_PER_SECOND)),
    });
  }
  // Timeline documents stay outside the planBuild graph: their exports run the
  // NLE pipeline, so the preview only reports clip count and span as measured actuals.
  for (const document of documents) {
    if (document.kind !== "timeline-document") continue;
    try {
      const project = parseNleProject(document.payload);
      timelineExports.push({
        objectId: document.id,
        clips: project.tracks.reduce((total, track) => total + track.clips.length, 0),
        durationMs: Math.round(nleRenderDurationMs(project)),
      });
    } catch {
      notes.push(`剪辑文档 ${document.id} 无法解析，导出耗时未知。`);
    }
  }
  if (!nodes.length) return { graph: undefined, nodeObject, sceneNodes, aigcNodes, timelineExports, notes };
  // Narration feeds the mix, so any scene rebuild also re-mixes audio; the
  // container assembly consumes every scene plus the mix.
  const sceneIds = nodes.map(node => node.id);
  nodes.push({ id: "audio:mix", kind: "audio/mix", inputs: sceneIds, params: { scenes: sceneIds.length }, granularity: "project", estimatedMs: AUDIO_MIX_MS });
  nodes.push({ id: "container", kind: "container", inputs: [...sceneIds, "audio:mix"], params: { scenes: sceneIds.length }, granularity: "project", estimatedMs: CONTAINER_MS });
  return { graph: createBuildGraph(nodes), nodeObject, sceneNodes, aigcNodes, timelineExports, notes };
}

/** Host-stable fingerprint; it scopes digests to this call only and is never stored. */
function previewEnvironment(): EnvironmentFingerprint {
  return { node: process.version, platform: process.platform, os: `${os.type()} ${os.release()}`, extra: { graph: "container-plan-preview" } };
}

export interface PlanPreviewSnapshot { projectId: string; revision: number; document: unknown }

type ActiveDocument = { id: string; kind: string; payload?: unknown };

function activeDocuments(snapshot: PlanPreviewSnapshot, intent: PlanPreviewIntent): ActiveDocument[] {
  const container = snapshot.document as { objects?: PreviewDocument[]; versions?: { id: string; currentVersionId?: string; payload?: unknown }[] };
  if (!Array.isArray(container.objects) || !Array.isArray(container.versions)) throw new PlanPreviewError(400, "工程快照缺少 objects/versions，无法预测");
  const active = container.objects.filter(document => isContainerDocument(document.kind) && !("archived" in document && document.archived));
  // Intent existence is validated against the documents themselves, so illegal
  // ids fail even when the container carries no scene documents at all.
  for (const objectId of intent.objectIds ?? []) {
    if (!active.some(document => document.id === objectId)) throw new PlanPreviewError(400, `意图引用了不存在或已归档的文档对象: ${objectId}`);
  }
  return active.map(document => ({
    id: document.id,
    kind: document.kind,
    payload: container.versions.find(version => version.id === document.currentVersionId)?.payload,
  }));
}

/** Maps the intent onto graph node ids; unmapped timeline intents are reported, not guessed. */
function forcedNodes(preview: PreviewGraph, intent: PlanPreviewIntent): { forced: string[]; unmapped: string[] } {
  const forced: string[] = [], unmapped: string[] = [];
  const hasIntent = Boolean(intent.objectIds?.length || intent.sceneIds?.length);
  if (!hasIntent) {
    // No intent: the honest question is "what would a full rebuild touch" — every node.
    forced.push(...preview.graph!.nodes.map(node => node.id));
  }
  for (const objectId of intent.objectIds ?? []) {
    const ownedNodes = Object.entries(preview.nodeObject).filter(([, owner]) => owner === objectId).map(([node]) => node);
    if (ownedNodes.length) forced.push(...ownedNodes);
    else unmapped.push(objectId);
  }
  for (const sceneId of intent.sceneIds ?? []) {
    const node = preview.sceneNodes.get(sceneId);
    if (!node) throw new PlanPreviewError(400, `意图引用了不存在的镜头: ${sceneId}`);
    forced.push(node);
  }
  return { forced, unmapped };
}

function assembleReply(snapshot: PlanPreviewSnapshot, preview: PreviewGraph, scope: "all" | "intent", plan: ReturnType<typeof planBuild> | undefined, unmapped: string[], notes: string[]): PlanPreviewReply {
  const base = { version: 1 as const, projectId: snapshot.projectId, revision: snapshot.revision, scope, timelineExports: preview.timelineExports, unmappedIntents: unmapped, notes };
  if (!plan) return { ...base, impact: { totalNodes: 0, predicted: [], reusedCount: 0, estimatedMs: 0, costCny: 0, costType: "local-free", quoteRequired: [], affectedObjects: [] } };
  const quoteRequired = plan.predicted.filter(node => preview.aigcNodes.has(node)).map(node => ({ nodeId: node, sceneId: node.slice("scene:".length) }));
  return {
    ...base,
    impact: {
      totalNodes: plan.predicted.length + plan.reused.length,
      predicted: plan.predicted,
      reusedCount: plan.reused.length,
      estimatedMs: plan.estimatedMs,
      costCny: plan.costCny ?? 0,
      costType: quoteRequired.length ? "quote-required" : "local-free",
      quoteRequired,
      affectedObjects: [...new Set(plan.predicted.map(node => preview.nodeObject[node]).filter(Boolean))],
    },
  };
}

/** The impact closure of the intent, computed by planBuild's own propagation. */
export function previewContainerPlan(snapshot: PlanPreviewSnapshot, intent: PlanPreviewIntent): PlanPreviewReply {
  const documents = activeDocuments(snapshot, intent);
  const preview = previewGraphFrom(documents);
  const notes = [...preview.notes];
  if (!preview.graph) {
    for (const sceneId of intent.sceneIds ?? []) throw new PlanPreviewError(400, `意图引用了不存在的镜头: ${sceneId}`);
    const unmapped = intent.objectIds ?? [];
    if (unmapped.length) notes.push("意图中的剪辑文档不走构建图：导出耗时以回执实测对照。");
    else notes.push("工程没有可预测的分镜节点：影响预测仅覆盖分镜文档的构建图。");
    return assembleReply(snapshot, preview, unmapped.length ? "intent" : "all", undefined, unmapped, notes);
  }
  const { forced, unmapped } = forcedNodes(preview, intent);
  // previous equals the fresh digests, so `changed` is empty and the prediction
  // is exactly the forced closure — the honest "this intent touches these nodes".
  const environment = previewEnvironment();
  const digests = computeDigests(preview.graph, environment);
  const plan = planBuild(preview.graph, { version: 1, environment, digests }, environment, forced, { executionOnly: true });
  if (unmapped.length) notes.push("意图中的剪辑文档不走构建图：导出耗时以回执实测对照。");
  const hasIntent = Boolean(intent.objectIds?.length || intent.sceneIds?.length);
  if (!hasIntent) notes.push("未提供意图：按全部节点重建预测。");
  notes.push("AIGC 镜头重新生成像素需走既有媒体报价（quote→approve→submit）；本地渲染免费但有时延。");
  return assembleReply(snapshot, preview, hasIntent ? "intent" : "all", plan, unmapped, notes);
}
