import { createHash } from "node:crypto";

/**
 * Deterministic build graph for time-based media.
 *
 * A node is a pure function of its declared parameters, its input node digests
 * and one environment fingerprint. Two consequences follow, and both are the
 * point of the package:
 *   1. a change propagates only through real edges (no hand-maintained
 *      invalidation lists), and
 *   2. "what will rebuild" can be computed before anything runs.
 *
 * No dependency on the renderer: the CLI maps a SceneScript project onto this
 * graph, other hosts may map something else.
 */

export type NodeKind =
  | "shot/spec"
  | "scene/eval"
  | "layer/raster"
  | "composite/frame"
  | "audio/mix"
  | "encode/segment"
  | "container"
  | "snapshot/external";

const NODE_KINDS = new Set<string>([
  "shot/spec",
  "scene/eval",
  "layer/raster",
  "composite/frame",
  "audio/mix",
  "encode/segment",
  "container",
  "snapshot/external",
]);

/** deterministic: replayable from inputs. snapshot: pinned external result. opaque: may drift. */
export type Executability = "deterministic" | "snapshot" | "opaque";

/** Honest caching granularity of the backend behind this node. */
export type Granularity = "layer" | "scene" | "project";

export interface BuildNode {
  id: string;
  kind: NodeKind;
  inputs: readonly string[];
  /** Everything that affects the output and is not an input node. */
  params?: unknown;
  executability?: Executability;
  granularity?: Granularity;
  /** Estimated spend, in CNY. Only external generation nodes should be non-zero. */
  costCny?: number;
  /** Estimated wall-clock milliseconds for an uncached execution. */
  estimatedMs?: number;
}

export interface BuildGraph {
  version: 1;
  nodes: BuildNode[];
}

export class BuildGraphError extends Error {
  constructor(
    readonly code: "invalid-node" | "duplicate-node" | "unknown-input" | "cycle",
    message: string,
  ) {
    super(message);
    this.name = "BuildGraphError";
  }
}

function invalid(message: string): never {
  throw new BuildGraphError("invalid-node", message);
}

/** Validates shape, unique ids, existing inputs and acyclicity. */
export function createBuildGraph(nodes: readonly BuildNode[]): BuildGraph {
  if (!Array.isArray(nodes) || nodes.length === 0) invalid("A build graph needs at least one node");
  if (nodes.length > 100_000) invalid("Too many build nodes");
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id.trim()) invalid("Every node needs a non-empty string id");
    if (node.id.length > 200) invalid(`Node id too long: ${node.id.slice(0, 40)}…`);
    if (seen.has(node.id)) throw new BuildGraphError("duplicate-node", `Duplicate node id: ${node.id}`);
    seen.add(node.id);
    if (!NODE_KINDS.has(node.kind)) invalid(`Unknown node kind on ${node.id}: ${String(node.kind)}`);
    if (!Array.isArray(node.inputs)) invalid(`Node inputs must be an array: ${node.id}`);
    if (node.inputs.length > 512) invalid(`Too many inputs on ${node.id}`);
    if (node.executability !== undefined && !["deterministic", "snapshot", "opaque"].includes(node.executability)) invalid(`Bad executability on ${node.id}`);
    if (node.granularity !== undefined && !["layer", "scene", "project"].includes(node.granularity)) invalid(`Bad granularity on ${node.id}`);
    if (node.costCny !== undefined && (!Number.isFinite(node.costCny) || node.costCny < 0)) invalid(`Bad cost on ${node.id}`);
    if (node.estimatedMs !== undefined && (!Number.isFinite(node.estimatedMs) || node.estimatedMs < 0)) invalid(`Bad estimatedMs on ${node.id}`);
  }
  for (const node of nodes) {
    for (const input of node.inputs) {
      if (input === node.id) throw new BuildGraphError("cycle", `Node depends on itself: ${node.id}`);
      if (!seen.has(input)) throw new BuildGraphError("unknown-input", `Node ${node.id} depends on unknown input ${input}`);
    }
  }
  const normalized = nodes.map(node => ({ ...node, inputs: [...node.inputs] }));
  topologicalOrder({ nodes: normalized });
  return { version: 1, nodes: normalized };
}

/** Kahn topological order; throws BuildGraphError("cycle") on a cycle. */
export function topologicalOrder(graph: Pick<BuildGraph, "nodes">): string[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, node.inputs.length);
    for (const input of node.inputs) {
      const list = dependents.get(input) ?? [];
      list.push(node.id);
      dependents.set(input, list);
    }
  }
  const queue = graph.nodes.filter(node => node.inputs.length === 0).map(node => node.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = indegree.get(dependent)! - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length !== byId.size) {
    const stuck = [...byId.keys()].filter(id => !order.includes(id));
    throw new BuildGraphError("cycle", `Dependency cycle among: ${stuck.slice(0, 8).join(", ")}`);
  }
  return order;
}

/** JSON with sorted object keys, so digests never depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export interface EnvironmentFingerprint {
  node: string;
  platform: string;
  os: string;
  resvg?: string;
  browser?: string;
  fonts?: string;
  /** Extra host-specific markers; changing any of them invalidates the graph. */
  extra?: Record<string, string>;
}

export function nodeDigest(node: BuildNode, environment: EnvironmentFingerprint, inputDigests: Record<string, string>): string {
  const inputs = node.inputs.map(input => {
    const digest = inputDigests[input];
    if (!digest) throw new BuildGraphError("unknown-input", `Missing digest for input ${input} of ${node.id}`);
    return [input, digest];
  });
  return sha256Hex(canonicalJson({
    version: 1,
    kind: node.kind,
    params: node.params ?? null,
    executability: node.executability ?? "deterministic",
    granularity: node.granularity ?? "scene",
    environment,
    inputs,
  }));
}

export function computeDigests(graph: BuildGraph, environment: EnvironmentFingerprint): Record<string, string> {
  const order = topologicalOrder(graph);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const digests: Record<string, string> = {};
  for (const id of order) digests[id] = nodeDigest(byId.get(id)!, environment, digests);
  return digests;
}

export interface BuildManifest {
  version: 1;
  environment: EnvironmentFingerprint;
  digests: Record<string, string>;
  /** Render options the build used, so a later plan can reuse them as defaults. */
  profile?: Record<string, unknown>;
  createdAt?: string;
}

export interface BuildPlan {
  version: 1;
  /** Nodes that will execute, in dependency order. */
  predicted: string[];
  /** Nodes reused from cache / previous build. */
  reused: string[];
  /** Nodes whose digest changed (a strict subset of predicted, plus forced ones). */
  changed: string[];
  /** Nodes forced to run even when their digest is unchanged (cache miss, opaque node). */
  forced: string[];
  digests: Record<string, string>;
  costCny: number;
  estimatedMs: number;
}

/**
 * @param mustExecute nodes that cannot be reused even with an unchanged digest
 *   (e.g. a cache artifact is missing, or the node is opaque like audio mixing).
 */
export function planBuild(
  graph: BuildGraph,
  previous: BuildManifest | undefined,
  environment: EnvironmentFingerprint,
  mustExecute: Iterable<string> = [],
  options: { executionOnly?: boolean } = {},
): BuildPlan {
  const order = topologicalOrder(graph);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const digests = computeDigests(graph, environment);
  const forced = new Set<string>();
  for (const id of mustExecute) {
    if (!byId.has(id)) throw new BuildGraphError("unknown-input", `mustExecute references unknown node: ${id}`);
    forced.add(id);
  }
  const changed = new Set<string>();
  for (const id of order) {
    if (!previous || previous.digests[id] !== digests[id]) changed.add(id);
  }
  // executionOnly: a node whose new digest is already present in the content-addressed
  // cache will not run, so prediction must follow forced execution, not content change.
  const dirty = options.executionOnly ? new Set<string>(forced) : new Set<string>([...changed, ...forced]);
  // An executed node always forces its dependents: their inputs are rebuilt.
  for (const id of order) {
    if (!dirty.has(id)) continue;
    for (const dependent of graph.nodes) {
      if (dependent.inputs.includes(id)) dirty.add(dependent.id);
    }
  }
  const predicted = order.filter(id => dirty.has(id));
  const reused = order.filter(id => !dirty.has(id));
  const costCny = predicted.reduce((total, id) => total + (byId.get(id)!.costCny ?? 0), 0);
  const estimatedMs = predicted.reduce((total, id) => total + (byId.get(id)!.estimatedMs ?? 0), 0);
  return {
    version: 1,
    predicted,
    reused,
    changed: order.filter(id => changed.has(id)),
    forced: order.filter(id => forced.has(id)),
    digests,
    costCny: Math.round(costCny * 10_000) / 10_000,
    estimatedMs,
  };
}

export interface BudgetCheck {
  matches: boolean;
  missing: string[];
  extra: string[];
}

/** Compares the plan against what actually executed (L1 budget law). */
export function checkBudget(plan: BuildPlan, executed: Iterable<string>): BudgetCheck {
  const actual = new Set(executed);
  const predicted = new Set(plan.predicted);
  const missing = [...predicted].filter(id => !actual.has(id));
  const extra = [...actual].filter(id => !predicted.has(id));
  return { matches: missing.length === 0 && extra.length === 0, missing, extra };
}

export function createManifest(plan: BuildPlan, environment: EnvironmentFingerprint, createdAt = new Date().toISOString()): BuildManifest {
  return { version: 1, environment, digests: plan.digests, createdAt };
}

export type Reproducibility = "L0" | "L1" | "L2";

export interface ReceiptNode {
  id: string;
  kind: NodeKind;
  digest: string;
  executability: Executability;
  reused: boolean;
  costCny: number;
  wallMs?: number;
}

export type Origin = "rendered" | "footage" | "generated" | "unknown";

/** Inclusive [start, end] frame range and where its pixels came from (L3). */
export interface ProvenanceRange {
  frameRange: [number, number];
  origin: Origin;
  source?: string;
  model?: string;
  seed?: number;
}

export interface ReceiptVerification {
  law: "L1" | "L2" | "L3";
  pass: boolean;
  detail?: string;
}

export interface Receipt {
  format: "glint-receipt";
  version: 1;
  project: { id: string; revision: string; path?: string; /** Edits applied on top of path, so a rebuild reproduces the delivered cut. */ changes?: string[] };
  reproducibility: Reproducibility;
  environment: EnvironmentFingerprint;
  plan: { predicted: string[]; actual: string[]; matches: boolean; missing?: string[]; extra?: string[] };
  nodes: ReceiptNode[];
  /** Render options used for this cut; a rebuild must use the same ones. */
  recipe?: Record<string, unknown>;
  provenance?: ProvenanceRange[];
  output?: { path: string; sha256: string; bytes: number; frames?: number };
  verification: ReceiptVerification[];
  totals: { modelCalls: number; costCny: number; wallMs: number; executed: number; reused: number };
}

function receiptInvalid(message: string): never {
  throw new Error(`Invalid glint receipt: ${message}`);
}

/** Structural validation only; content verification is `verifyReceipt`. */
export function validateReceipt(value: unknown): Receipt {
  const receipt = value as Receipt;
  if (!receipt || receipt.format !== "glint-receipt") receiptInvalid("format must be glint-receipt");
  if (receipt.version !== 1) receiptInvalid("unsupported version");
  if (!receipt.project || typeof receipt.project.id !== "string" || !receipt.project.id || typeof receipt.project.revision !== "string" || !receipt.project.revision) receiptInvalid("project id/revision missing");
  if (!["L0", "L1", "L2"].includes(receipt.reproducibility)) receiptInvalid("reproducibility must be L0/L1/L2");
  if (!receipt.environment || typeof receipt.environment.node !== "string" || typeof receipt.environment.platform !== "string") receiptInvalid("environment fingerprint missing");
  if (!receipt.plan || !Array.isArray(receipt.plan.predicted) || !Array.isArray(receipt.plan.actual) || typeof receipt.plan.matches !== "boolean") receiptInvalid("plan block missing");
  if (!Array.isArray(receipt.nodes) || receipt.nodes.length === 0) receiptInvalid("nodes missing");
  for (const node of receipt.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || typeof node.digest !== "string" || !node.digest) receiptInvalid(`node ${String(node?.id)} is missing id/digest`);
    if (!["deterministic", "snapshot", "opaque"].includes(node.executability)) receiptInvalid(`node ${node.id} has a bad executability`);
    if (typeof node.reused !== "boolean") receiptInvalid(`node ${node.id} has a bad reused flag`);
  }
  if (receipt.output !== undefined) {
    const output = receipt.output;
    if (!output || typeof output.path !== "string" || !output.path || typeof output.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(output.sha256)) receiptInvalid("output block is malformed");
    if (!Number.isInteger(output.bytes) || output.bytes < 0) receiptInvalid("output bytes is malformed");
    if (output.frames !== undefined && (!Number.isInteger(output.frames) || output.frames <= 0)) receiptInvalid("output frames is malformed");
  }
  if (receipt.project.changes !== undefined && (!Array.isArray(receipt.project.changes) || receipt.project.changes.some(change => typeof change !== "string"))) receiptInvalid("project.changes must be an array of strings");
  if (receipt.provenance !== undefined) {
    if (!Array.isArray(receipt.provenance) || receipt.provenance.length === 0) receiptInvalid("provenance must be a non-empty array when present");
    for (const range of receipt.provenance) {
      if (!range || !Array.isArray(range.frameRange) || range.frameRange.length !== 2) receiptInvalid("provenance.frameRange must be [start, end]");
      const [start, end] = range.frameRange;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) receiptInvalid("provenance frame range is invalid");
      if (!["rendered", "footage", "generated", "unknown"].includes(range.origin)) receiptInvalid(`provenance origin is invalid: ${String(range.origin)}`);
      if (range.source !== undefined && typeof range.source !== "string") receiptInvalid("provenance source must be a string");
      if (range.seed !== undefined && !Number.isInteger(range.seed)) receiptInvalid("provenance seed must be an integer");
    }
  }
  if (!Array.isArray(receipt.verification)) receiptInvalid("verification missing");
  if (!receipt.totals || !Number.isFinite(receipt.totals.costCny) || !Number.isInteger(receipt.totals.executed)) receiptInvalid("totals missing");
  return receipt;
}

/** Environment drift between a receipt and the current host. */
export function environmentDrift(recorded: EnvironmentFingerprint, current: EnvironmentFingerprint): string[] {
  const keys: (keyof EnvironmentFingerprint)[] = ["node", "platform", "os", "resvg", "browser", "fonts"];
  const drift: string[] = [];
  for (const key of keys) {
    if ((recorded[key] ?? "") !== (current[key] ?? "")) drift.push(`${key}: ${String(recorded[key] ?? "unset")} → ${String(current[key] ?? "unset")}`);
  }
  // `extra` carries the renderer/source fingerprint; ignoring it here would let a
  // changed renderer pass the environment check while producing different pixels.
  const extraKeys = new Set([...Object.keys(recorded.extra ?? {}), ...Object.keys(current.extra ?? {})]);
  for (const key of [...extraKeys].sort()) {
    if ((recorded.extra?.[key] ?? "") !== (current.extra?.[key] ?? "")) drift.push(`extra.${key}: ${String(recorded.extra?.[key] ?? "unset")} → ${String(current.extra?.[key] ?? "unset")}`);
  }
  return drift;
}

/** SHA-256 over the canonical bytes; Node-only package, so use the platform primitive. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
/** True when the ranges cover every frame exactly once (L3 coverage). */
export function provenanceCovers(frames: number, ranges: readonly ProvenanceRange[]): boolean {
  if (!Number.isInteger(frames) || frames <= 0) return false;
  const coverage = new Uint16Array(frames);
  for (const range of ranges) {
    if (!range || !Array.isArray(range.frameRange) || range.frameRange.length !== 2) return false;
    const [start, end] = range.frameRange;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= frames) return false;
    for (let frame = start; frame <= end; frame++) coverage[frame] = (coverage[frame] ?? 0) + 1;
  }
  return coverage.every(count => count === 1);
}