import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseProject, sceneDurationMs, buildTimeline, timelineToFrames, frameRateOf, type SceneScriptProject, type Scene } from "@glintai/scenescript";
import {
  checkBudget, computeDigests, createBuildGraph, createManifest, environmentDrift, planBuild, sha256Hex, validateReceipt,
  type BuildGraph, type BuildManifest, type BuildPlan, type EnvironmentFingerprint, type Receipt, type Reproducibility, type ReceiptNode, type ProvenanceRange,
} from "@glintai/buildgraph";
import { assetFingerprint, sceneMediaFingerprint, sceneAssetFingerprint, sceneCacheKey, sceneEncoding, nativeCacheEnvironment, visualSceneIdentity, cacheArtifactValid } from "./native-cache";
import { supportsNativeScene } from "./native-svg";
import { renderNative } from "./native-render";
import { cachedNarrationProject, narrationSignature } from "./native-audio";
import { readArg } from "./glint-runtime";
import { diffVideos, formatDiff, probeFrameCount } from "./frame-diff";
import { resolveTheme } from "@glintai/design-tokens";
import { FileSessionStore } from "@glintai/session/node";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = () => path.resolve(process.env.GLINT_CACHE_DIR ?? ".cache", "native-scenes");
const MANIFEST_RELATIVE = path.join(".glint", "manifest.json");

export interface RenderProfile { fast?: boolean; plate?: boolean; resolution?: string; tts?: string; music?: string }

/** L3 provenance for one scene: declared origin wins over kind-based defaults. */
export function provenanceForScene(scene: Scene, start: number, end: number): ProvenanceRange {
  const declared = (scene as { provenance?: { origin: "footage" | "generated"; source?: string; model?: string; seed?: number } }).provenance;
  const footage = scene.kind === "image" || scene.kind === "video";
  const range: ProvenanceRange = { frameRange: [start, end], origin: declared?.origin ?? (footage ? "footage" : "rendered") };
  const source = declared?.source ?? (footage ? (scene as { src: string }).src : undefined);
  if (source) range.source = source;
  if (declared?.model) range.model = declared.model;
  if (declared?.seed !== undefined) range.seed = declared.seed;
  return range;
}export interface PlanReport {
  projectId: string;
  revision: string;
  projectPath: string;
  exact: boolean;
  plan: BuildPlan;
  environment: EnvironmentFingerprint;
  notes: string[];
  /** Internal check that the narration used by the renderer is the one planned. */
  narrationSignature?: string;
  /** Planned TTS provider calls; null denotes unknown. */
  modelCalls: number | null;
}

export interface BuildReport extends PlanReport {
  output: string;
  receipt: Receipt;
  budget: { matches: boolean; missing: string[]; extra: string[] };
  elapsedMs: number;
}

export interface VerifyReport {
  receiptPath: string;
  valid: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  pass: boolean;
}

export function projectSha256(project: SceneScriptProject): string {
  return sha256Hex(JSON.stringify(project));
}

/** `scenes[2].title`, `scenes.2.title` and `narration.text` are all accepted. */
export function applyChange(root: unknown, expression: string): void {
  const equals = expression.indexOf("=");
  if (equals <= 0) throw new Error(`Change must look like path=value: ${expression}`);
  const rawPath = expression.slice(0, equals).trim(), rawValue = expression.slice(equals + 1).trim();
  if (!rawPath) throw new Error("Change path is empty");
  const segments = rawPath.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).map(segment => (/^\d+$/.test(segment) ? Number(segment) : segment));
  if (!segments.length || segments.length > 40) throw new Error("Change path is invalid");
  let value: unknown;
  try { value = JSON.parse(rawValue); } catch { value = rawValue; }
  let cursor = root as Record<string, unknown>;
  for (let index = 0; index < segments.length - 1; index++) {
    const key = segments[index]!;
    const next = (cursor as Record<string | number, unknown>)[key];
    if (!next || typeof next !== "object") throw new Error(`Change path not found at: ${segments.slice(0, index + 1).join(".")}`);
    cursor = next as Record<string, unknown>;
  }
  const last = segments[segments.length - 1]!;
  if (!(last in (cursor as object))) throw new Error(`Change path not found: ${rawPath}`);
  (cursor as Record<string | number, unknown>)[last] = value;
}

function changedProject(projectPath: string, changes: string[]): { project: SceneScriptProject; changed: boolean } {
  const raw = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  if (!changes.length) return { project: parseProject(raw), changed: false };
  for (const change of changes) applyChange(raw, change);
  return { project: parseProject(raw), changed: true };
}

function fontFiles(): string[] {
  return process.platform === "win32"
    ? ["msyh.ttc", "msyhbd.ttc", "simkai.ttf", "consola.ttf"].map(name => path.join(process.env.WINDIR ?? "C:/Windows", "Fonts", name)).filter(file => fs.existsSync(file))
    : [];
}

function frameSize(project: SceneScriptProject, options: { fast?: boolean; resolution?: string }): { width: number; height: number; fps: number } {
  const scale = options.resolution ? ({ "540": 0.5, "720": 2 / 3, "1080": 1, "1440": 4 / 3, "2160": 2 } as Record<string, number>)[options.resolution] ?? 1 : (options.fast ? 0.5 : 1);
  const dimensions = project.aspect === "9:16" ? [1080, 1920] : project.aspect === "1:1" ? [1080, 1080] : [1920, 1080];
  return { width: Math.round(dimensions[0]! * scale), height: Math.round(dimensions[1]! * scale), fps: frameRateOf(project.fps ?? 30).value };
}

export function environmentFingerprint(options: { browserRequired: boolean }): EnvironmentFingerprint {
  const cacheEnvironment = nativeCacheEnvironment(SCRIPT_DIR, { browserRequired: options.browserRequired, fontFiles: fontFiles() });
  return {
    node: process.version,
    platform: process.platform,
    os: `${os.type()} ${os.release()}`,
    resvg: cacheEnvironment.resvg,
    browser: cacheEnvironment.browser,
    fonts: sha256Hex(JSON.stringify(cacheEnvironment.fontIdentity)),
    extra: { renderer: String(cacheEnvironment.renderer), source: cacheEnvironment.sourceFingerprint },
  };
}

export interface GraphResult {
  graph: BuildGraph;
  environment: EnvironmentFingerprint;
  exact: boolean;
  sceneKeys: Record<string, string>;
  mustExecute: string[];
  narrationSignature?: string;
}

/** Maps a SceneScript project onto build nodes whose params are the renderer's own cache keys. */
export function graphForProject(project: SceneScriptProject, projectPath: string, options: { fast?: boolean; plate?: boolean; resolution?: string; tts?: string; music?: string; noCache?: boolean }): GraphResult {
  const projectDir = path.dirname(projectPath);
  const narration = cachedNarrationProject(project, projectDir, options);
  project = narration.project;
  const browserRequired = project.scenes.some(scene => !supportsNativeScene(scene));
  const cacheEnvironment = nativeCacheEnvironment(SCRIPT_DIR, { browserRequired, fontFiles: fontFiles() });
  const assets = browserRequired ? assetFingerprint(projectDir) : "no-assets";
  const theme = resolveTheme(project.theme);
  const size = frameSize(project, options);
  const { entries } = timelineToFrames(buildTimeline(project), size.fps);
  const nodes = project.scenes.map((scene, index) => {
    const previous = project.scenes[index - 1];
    const key = sceneCacheKey({
      environment: cacheEnvironment,
      scene: visualSceneIdentity(scene, Boolean(options.plate)),
      media: sceneMediaFingerprint(scene as Scene, projectDir, assets),
      assets: sceneAssetFingerprint(project, scene as Scene),
      previousShared: scene.transition?.in === "magic-move" ? previous?.sharedElements : scene.transition?.in === "shape-morph" ? previous?.elements : undefined,
      theme, width: size.width, height: size.height, fps: size.fps, duration: entries[index]!.duration, plate: Boolean(options.plate), encoding: sceneEncoding(options.fast),
    });
    return { id: `scene:${scene.id}`, kind: "scene/eval" as const, inputs: [] as string[], params: { cacheKey: key }, granularity: "scene" as const, estimatedMs: Math.round((entries[index]?.duration ?? 30) / size.fps * 18) };
  });
  const audioParams = { text: project.scenes.map(scene => scene.narration.text), voices: project.scenes.map(scene => scene.narration.voice ?? null), tts: options.tts ?? "existing", music: options.music ?? (project.music ? "existing" : "off") };
  const planNodes = [
    ...nodes,
    { id: "audio:mix", kind: "audio/mix" as const, inputs: [] as string[], params: audioParams, executability: "opaque" as const, granularity: "project" as const, estimatedMs: 400 },
    { id: "container", kind: "container" as const, inputs: [...nodes.map(node => node.id), "audio:mix"], params: { ...size, aspect: project.aspect, plate: Boolean(options.plate) }, granularity: "project" as const, estimatedMs: 300 },
  ];
  const graph = createBuildGraph(planNodes);
  const sceneKeys = Object.fromEntries(nodes.map(node => [node.id, (node.params as { cacheKey: string }).cacheKey]));
  const mustExecute = ["audio:mix", ...nodes.filter(node => options.noCache || !cacheArtifactValid(path.join(CACHE_DIR(), `${sceneKeys[node.id]}.mp4`))).map(node => node.id)];
  const exact = narration.exact;
  return { graph, environment: environmentFingerprint({ browserRequired }), exact, sceneKeys, mustExecute, narrationSignature: exact ? narrationSignature(project) : undefined };
}

export function manifestPath(projectPath: string): string { return path.join(path.dirname(projectPath), MANIFEST_RELATIVE); }

export function loadManifest(projectPath: string): BuildManifest | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(projectPath), "utf8")) as BuildManifest;
    return parsed?.version === 1 && parsed.digests && parsed.environment ? parsed : undefined;
  } catch { return undefined; }
}

export function saveManifest(projectPath: string, manifest: BuildManifest): void {
  const file = manifestPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  fs.renameSync(temporary, file);
}

export interface PlanInput {
  projectPath: string;
  changes?: string[];
  fast?: boolean;
  plate?: boolean;
  resolution?: string;
  tts?: string;
  music?: string;
  noCache?: boolean;
}

export function effectiveRenderProfile(input: RenderProfile, stored?: RenderProfile): RenderProfile {
  return {
    fast: input.fast ?? stored?.fast,
    plate: input.plate ?? stored?.plate,
    resolution: input.resolution ?? stored?.resolution,
    tts: input.tts ?? stored?.tts,
    music: input.music ?? stored?.music,
  };
}

export function planProject(input: PlanInput): PlanReport {
  return planProjectWithManifest(input, loadManifest(path.resolve(input.projectPath)));
}

function planProjectWithManifest(input: PlanInput, stored: BuildManifest | undefined, cacheOnlyTts = false): PlanReport {
  const projectPath = path.resolve(input.projectPath);
  const profile = stored?.profile as RenderProfile | undefined;
  // A plan without explicit flags must describe the same render profile as the last
  // build; otherwise every cache key changes and the budget becomes meaningless.
  const effective: PlanInput = { ...input, ...effectiveRenderProfile(input, profile) };
  const { project } = changedProject(projectPath, effective.changes ?? []);
  const graphResult = graphForProject(project, projectPath, effective);
  // Without a manifest, a valid scene cache still proves which nodes already exist;
  // treating it as "everything is dirty" would make the first build after a cache
  // warm-up fail its own L1 budget.
  let previous = stored;
  const notes: string[] = [];
  if (!previous) {
    const digests = computeDigests(graphResult.graph, graphResult.environment);
    const seeded: Record<string, string> = {};
    for (const [nodeId, key] of Object.entries(graphResult.sceneKeys)) if (cacheArtifactValid(path.join(CACHE_DIR(), `${key}.mp4`))) seeded[nodeId] = digests[nodeId]!;
    previous = { version: 1, environment: graphResult.environment, digests: seeded };
    if (Object.keys(seeded).length) notes.push(`没有 manifest，但场景缓存命中 ${Object.keys(seeded).length} 个节点，按已构建处理。`);
  }
  const plan = planBuild(graphResult.graph, previous, graphResult.environment, graphResult.mustExecute, { executionOnly: true });
  const tts = effective.tts ?? "existing";
  const plannedCallsKnown = ["existing", "mock"].includes(tts) || (cacheOnlyTts && graphResult.exact && tts !== "auto");
  const plannedCalls: number | null = plannedCallsKnown ? 0 : null;
  if (!plannedCallsKnown) { plan.costCny = null; notes.push("TTS 供应方调用数及费用未知，计划不会发起请求；费用不代表零。"); }
  if (profile && ["fast", "plate", "resolution", "tts", "music"].some(key => (input as unknown as Record<string, unknown>)[key] !== undefined && (input as unknown as Record<string, unknown>)[key] !== (profile as Record<string, unknown>)[key])) notes.push("本次显式渲染参数与上次构建不同：缓存 key 会全部变化。");
  if (!graphResult.exact) notes.push("旁白时长（durationMs）或合成结果尚未确定：计划仅为估算；--assert-budget 会在渲染或 TTS 请求前拒绝。旧版或无效缓存不会复用；普通构建重合成可能产生费用，请先确认供应商价格。");
  if (!stored) notes.push("没有上一次构建的 manifest：除缓存命中外均视为需要重建。");
  return {
    projectId: project.id, revision: `sha256:${projectSha256(project)}`, projectPath,
    exact: graphResult.exact, plan, environment: graphResult.environment, notes, narrationSignature: graphResult.narrationSignature, modelCalls: plannedCalls,
  };
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function fileSha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export interface BuildInput extends PlanInput {
  output: string;
  assertBudget?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export async function buildProject(input: BuildInput): Promise<BuildReport> {
  const started = performance.now();
  const log = input.log ?? console.log;
  const projectPath = path.resolve(input.projectPath), output = path.resolve(input.output);
  const { project, changed } = changedProject(projectPath, input.changes ?? []);
  const stored = loadManifest(projectPath);
  const effective = effectiveRenderProfile(input, stored?.profile as RenderProfile | undefined);
  // Use one manifest snapshot and profile for prediction, rendering and receipts.
  const report = planProjectWithManifest({ ...input, ...effective }, stored, Boolean(input.assertBudget));
  if (input.assertBudget && !report.exact) throw new Error("Budget cannot be asserted before rendering: narration duration or TTS result is unknown; check provider pricing before retrying without --assert-budget, because rejected or legacy cache entries may trigger a paid TTS request.");
  if (!report.exact && !["existing", "mock"].includes(effective.tts ?? "existing")) log("[glint] TTS cache unavailable, unverified or bypassed: synthesis may call the provider and incur charges. Check provider pricing before retrying.");
  let renderPath = projectPath;
  let temporaryProject: string | undefined;
  let providerCalls = 0;
  try {
    if (changed) {
      temporaryProject = path.join(path.dirname(projectPath), `.glint-change-${randomUUID()}.json`);
      fs.writeFileSync(temporaryProject, JSON.stringify(project, null, 2));
      renderPath = temporaryProject;
    }
    const rendered = await renderNative({
      projectPath: renderPath, output,
      tts: effective.tts ?? "existing", music: effective.music, fast: effective.fast, plate: effective.plate,
      resolution: effective.resolution as never, noCache: input.noCache, ttsCacheOnly: input.assertBudget, expectedNarrationSignature: input.assertBudget ? report.narrationSignature : undefined, onProviderCall: () => { providerCalls++; }, signal: input.signal, log,
    });
    const executed = new Set<string>(["audio:mix", "container"]);
    for (const scene of rendered.scenes) if (!scene.cached) executed.add(`scene:${scene.id}`);
    const actual = [...executed];
    const budget = report.exact ? checkBudget(report.plan, actual) : { matches: false, missing: [], extra: [] };
    const reproducibility: Reproducibility = project.scenes.some(scene => !supportsNativeScene(scene)) ? "L1" : "L0";
    const nodes: ReceiptNode[] = report.plan.predicted.concat(report.plan.reused).map(id => ({
      id,
      kind: (id.startsWith("scene:") ? "scene/eval" : id === "audio:mix" ? "audio/mix" : "container") as ReceiptNode["kind"],
      digest: report.plan.digests[id] ?? "",
      executability: (id === "audio:mix" ? "opaque" : "deterministic") as ReceiptNode["executability"],
      reused: !executed.has(id),
      costCny: id === "audio:mix" && rendered.modelCalls > 0 ? null : 0,
    }));
    // L3: describe where every delivered frame came from, using the project the renderer actually wrote (audio durations included).
    const delivered = parseProject(JSON.parse(fs.readFileSync(`${output}.project.json`, "utf8")));
    const deliveredTimeline = timelineToFrames(buildTimeline(delivered), delivered.fps ?? 30);
    let cursor = 0;
    const provenance = deliveredTimeline.entries.map(entry => {
      const start = cursor, end = start + entry.duration - 1;
      cursor += entry.duration;
      return provenanceForScene(entry.scene, start, end);
    });
    const totalFrames = cursor;
    const coverage = new Uint16Array(totalFrames);
    for (const range of provenance) for (let frame = range.frameRange[0]; frame <= range.frameRange[1]; frame++) coverage[frame] = (coverage[frame] ?? 0) + 1;
    const covered = totalFrames > 0 && coverage.every(count => count === 1);
    const receipt: Receipt = {
      format: "glint-receipt", version: 1,
      project: { id: project.id, revision: report.revision, path: projectPath, changes: input.changes ?? [] },
      reproducibility,
      recipe: { fast: effective.fast ?? false, plate: effective.plate ?? false, resolution: effective.resolution, tts: effective.tts, music: effective.music },
      environment: report.environment,
      plan: { predicted: report.plan.predicted, actual, matches: budget.matches, missing: budget.missing, extra: budget.extra },
      nodes,
      provenance,
      output: { path: output, sha256: fileSha256(output), bytes: fs.statSync(output).size, frames: totalFrames },
      verification: [
        { law: "L1", pass: budget.matches, detail: !report.exact ? "not verified: narration timing unknown before execution" : budget.matches ? undefined : `missing: ${budget.missing.join(",") || "-"}; extra: ${budget.extra.join(",") || "-"}` },
        { law: "L2", pass: true, detail: `sha256=${fileSha256(output)}` },
        { law: "L3", pass: covered, detail: covered ? `${totalFrames} frames covered by ${provenance.length} provenance range(s)` : "provenance does not cover every frame exactly once" },
      ],
      totals: { modelCalls: rendered.modelCalls, costCny: rendered.modelCalls > 0 ? null : 0, wallMs: Math.round(performance.now() - started), executed: executed.size, reused: report.plan.reused.length },
    };
    atomicWrite(`${output}.receipt.json`, JSON.stringify(receipt, null, 2));
    saveManifest(projectPath, { ...createManifest(report.plan, report.environment), profile: { ...effective } });
    return { ...report, output, receipt, budget, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    // A failed provider call may still incur charges. Never replace an existing user file.
    const attemptId = randomUUID();
    const failureFile = `${output}.failure.${attemptId}.receipt.json`;
    const failure = { format: "glint-build-failure", version: 1, attemptId, status: "failed", stage: "build-execution", project: { id: project.id, revision: report.revision }, output, providerCalls, costCny: providerCalls ? null : 0, note: "Provider attempts are not proof of billing; check the provider's account before retrying.", elapsedMs: Math.round(performance.now() - started) };
    try { fs.writeFileSync(failureFile, JSON.stringify(failure, null, 2), { flag: "wx" }); log(`[glint] failure receipt: ${failureFile}`); }
    catch (writeError) { log(`[glint] could not write failure receipt ${failureFile}: ${writeError instanceof Error ? writeError.message : String(writeError)}; provider attempts=${providerCalls}, cost=${providerCalls ? "unknown" : "0"}`); }
    throw error;
  } finally {
    if (temporaryProject) fs.rmSync(temporaryProject, { force: true });
  }
}

export interface VerifyInput {
  receiptPath: string;
  rebuild?: boolean;
  /** Cross-machine check: validate structure/output but report environment drift as informational. */
  skipEnvironment?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export async function verifyReceipt(input: VerifyInput): Promise<VerifyReport> {
  const log = input.log ?? console.log;
  const receiptPath = path.resolve(input.receiptPath);
  const checks: VerifyReport["checks"] = [];
  const receipt = validateReceipt(JSON.parse(fs.readFileSync(receiptPath, "utf8")));
  checks.push({ name: "receipt-structure", pass: true, detail: `${receipt.nodes.length} nodes, ${receipt.reproducibility}` });
  checks.push({ name: "plan-matches", pass: receipt.plan.matches, detail: receipt.plan.matches ? `predicted = actual (${receipt.plan.actual.length})` : `L1 failed: missing=${receipt.plan.missing?.join(",") || "-"} extra=${receipt.plan.extra?.join(",") || "-"}` });
  if (receipt.output) {
    const exists = fs.existsSync(receipt.output.path);
    const actualSha = exists ? fileSha256(receipt.output.path) : "";
    const bytes = exists ? fs.statSync(receipt.output.path).size : 0;
    checks.push({ name: "output-sha256", pass: exists && actualSha === receipt.output.sha256 && bytes === receipt.output.bytes, detail: exists ? `${actualSha.slice(0, 12)}… / ${bytes} bytes` : "output missing" });
    if (exists && receipt.output.frames) {
      const decoded = await probeFrameCount(receipt.output.path);
      if (decoded !== undefined) checks.push({ name: "encoded-frames", pass: decoded === receipt.output.frames, detail: `${decoded} decoded ≠ ${receipt.output.frames} provenance frames` .replace(" ≠ ", decoded === receipt.output.frames ? " = " : " ≠ ") });
    }
  }
  if (receipt.provenance?.length && receipt.output?.frames) {
    const coverage = new Uint16Array(receipt.output.frames);
    for (const range of receipt.provenance) for (let frame = range.frameRange[0]; frame <= range.frameRange[1] && frame < coverage.length; frame++) coverage[frame] = (coverage[frame] ?? 0) + 1;
    const covered = coverage.every(count => count === 1);
    checks.push({ name: "provenance-coverage", pass: covered, detail: covered ? `${receipt.output.frames} frames covered` : "provenance has gaps or overlaps" });
  } else {
    checks.push({ name: "provenance-coverage", pass: false, detail: "receipt records no provenance (L3 not verified)" });
  }
  const browserRequired = (receipt.environment.browser ?? "none") !== "none";
  const drift = environmentDrift(receipt.environment, environmentFingerprint({ browserRequired }));
  if (input.skipEnvironment) checks.push({ name: "environment", pass: true, detail: drift.length ? `skipped by flag; drift: ${drift.join("; ")}` : "matches this host" });
  else checks.push({ name: "environment", pass: drift.length === 0, detail: drift.length ? drift.join("; ") : "matches this host" });
  if (input.rebuild) {
    if (!receipt.project.path) throw new Error("Receipt has no project path; cannot rebuild");
    const output = receipt.output?.path;
    if (!output) throw new Error("Receipt has no output to rebuild");
    const rebuilt = path.join(path.dirname(output), `.verify-${randomUUID()}.mp4`);
    let rebuildPath = receipt.project.path;
    let temporaryProject: string | undefined;
    try {
      if (receipt.project.changes?.length) {
        temporaryProject = path.join(path.dirname(receipt.project.path), `.glint-verify-${randomUUID()}.json`);
        const raw = JSON.parse(fs.readFileSync(receipt.project.path, "utf8"));
        for (const change of receipt.project.changes) applyChange(raw, change);
        fs.writeFileSync(temporaryProject, JSON.stringify(parseProject(raw), null, 2));
        rebuildPath = temporaryProject;
      }
      const recipe = (receipt.recipe ?? {}) as { fast?: boolean; plate?: boolean; resolution?: string; tts?: string; music?: string };
      await renderNative({ projectPath: rebuildPath, output: rebuilt, fast: recipe.fast, plate: recipe.plate, resolution: recipe.resolution as never, tts: recipe.tts, music: recipe.music, log });
      const rebuiltSha = fileSha256(rebuilt);
      if (rebuiltSha === receipt.output!.sha256) checks.push({ name: "rebuild", pass: true, detail: "byte-identical" });
      else if (receipt.reproducibility === "L1" && fs.existsSync(output)) {
        const diff = await diffVideos(output, rebuilt, { fps: 2, maxChangedRatio: 0.02 });
        checks.push({ name: "rebuild", pass: diff.pass, detail: `L1 tolerance: ${formatDiff(diff, 2)}` });
      } else checks.push({ name: "rebuild", pass: false, detail: `sha256 differs: ${rebuiltSha.slice(0, 12)}… ≠ ${receipt.output!.sha256.slice(0, 12)}…` });
    } finally { fs.rmSync(rebuilt, { force: true }); if (temporaryProject) fs.rmSync(temporaryProject, { force: true }); }
  }
  const pass = checks.every(check => check.pass);
  log(`[glint] verify ${pass ? "PASS" : "FAIL"}`);
  for (const check of checks) log(`  ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  return { receiptPath, valid: true, checks, pass };
}

function printPlan(report: PlanReport): void {
  const { plan } = report;
  console.log(`[glint] plan ${report.projectId} · ${report.revision.slice(0, 19)} · exact=${report.exact}`);
  console.log(`  predicted: ${plan.predicted.length} node(s) · TTS provider calls: ${report.modelCalls ?? "unknown"} · cost: ${plan.costCny === null ? "unknown" : `¥${plan.costCny.toFixed(2)}`} · ~${(plan.estimatedMs / 1000).toFixed(1)}s`);
  if (plan.changed.length) console.log(`  changed:   ${plan.changed.join(", ")}`);
  if (plan.forced.length) console.log(`  forced:    ${plan.forced.join(", ")} (cache miss or opaque)`);
  if (plan.reused.length) console.log(`  reused:    ${plan.reused.length} node(s)`);
  for (const note of report.notes) console.log(`  note: ${note}`);
}

/** `glint plan --project=p.json [--set path=value ...] [--out=plan.json]` */
export function runPlan(args: string[]): PlanReport {
  const projectPath = readArg(args, "project");
  if (!projectPath) throw new Error("plan requires --project=<scenescript.json>");
  const report = planProject({
    projectPath,
    changes: args.filter(arg => arg.startsWith("--set=")).map(arg => arg.slice(6)),
    fast: args.includes("--fast") ? true : undefined, plate: args.includes("--plate") ? true : undefined,
    resolution: readArg(args, "resolution"), tts: readArg(args, "tts"), music: readArg(args, "music"), noCache: args.includes("--no-cache"),
  });
  printPlan(report);
  const out = readArg(args, "out");
  if (out) { atomicWrite(path.resolve(out), JSON.stringify(report, null, 2)); console.log(`[glint] plan → ${path.resolve(out)}`); }
  return report;
}

/** `glint build --project=p.json --out=out.mp4 [--set path=value] [--assert-budget]` */
export async function runBuild(args: string[]): Promise<BuildReport> {
  const projectPath = readArg(args, "project"), output = readArg(args, "out");
  if (!projectPath || !output) throw new Error("build requires --project=<scenescript.json> and --out=<file.mp4>");
  const report = await buildProject({
    projectPath, output, assertBudget: args.includes("--assert-budget"),
    changes: args.filter(arg => arg.startsWith("--set=")).map(arg => arg.slice(6)),
    fast: args.includes("--fast") ? true : undefined, plate: args.includes("--plate") ? true : undefined,
    resolution: readArg(args, "resolution"), tts: readArg(args, "tts"), music: readArg(args, "music"), noCache: args.includes("--no-cache"),
  });
  console.log(`[glint] build ${!report.exact ? "budget-unverified" : report.budget.matches ? "budget-matched" : "BUDGET-MISMATCH"}: ${report.plan.predicted.length} predicted / ${report.receipt.totals.executed} executed · ${report.elapsedMs}ms`);
  console.log(`  receipt → ${report.output}.receipt.json`);
  if (report.exact && !report.budget.matches) console.log(`  missing: ${report.budget.missing.join(", ") || "-"}; extra: ${report.budget.extra.join(", ") || "-"}`);
  if (args.includes("--assert-budget")) {
    if (!report.budget.matches) { process.exitCode = 1; throw new Error("Build exceeded its predicted change set"); }
  }
  return report;
}

/** `glint verify --receipt=r.json [--rebuild]` */
export async function runVerify(args: string[]): Promise<VerifyReport> {
  const receiptPath = readArg(args, "receipt");
  if (!receiptPath) throw new Error("verify requires --receipt=<file.receipt.json>");
  const report = await verifyReceipt({ receiptPath, rebuild: args.includes("--rebuild"), skipEnvironment: args.includes("--skip-env") });
  if (!report.pass) process.exitCode = 1;
  return report;
}

/** Shared by the MCP server: never throw for expected validation failures. */
export function safePlan(input: PlanInput): { ok: true; report: PlanReport } | { ok: false; error: string } {
  try { return { ok: true, report: planProject(input) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export interface ApplyInput { projectPath: string; changes: string[]; expectedRevision?: string }


/** Writes a validated project atomically and returns its new content revision. */
export function writeProjectJson(projectPath: string, project: SceneScriptProject): string {
  atomicWrite(projectPath, JSON.stringify(project, null, 2));
  return `sha256:${projectSha256(project)}`;
}

/**
 * Compare-and-swap edit of the project file: the revision is the hash of the
 * parsed project, so a stale agent proposal cannot overwrite a newer edit.
 */
export function applyProjectChanges(input: ApplyInput): { projectId: string; revision: string; changes: string[] } {
  const projectPath = path.resolve(input.projectPath);
  if (!input.changes.length) throw new Error("apply requires at least one change");
  const raw = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const current = parseProject(raw);
  const revision = `sha256:${projectSha256(current)}`;
  if (input.expectedRevision && input.expectedRevision !== revision) {
    throw new Error(`Revision conflict: expected ${input.expectedRevision}, found ${revision}. Re-read the project and re-apply.`);
  }
  for (const change of input.changes) applyChange(raw, change);
  const next = parseProject(raw);
  const revisionAfter = writeProjectJson(projectPath, next);
  return { projectId: next.id, revision: revisionAfter, changes: input.changes };
}

/** CORE-09: MCP semantic edits ride the shared session domain — the same
 * durable history and undo line as the web and CLI entries — and are written
 * back so file consumers stay byte-identical with the session. The CAS
 * contract (expectedRevision over the content hash) is unchanged.
 */
export function applySessionChanges(input: ApplyInput & { sessionDirectory?: string }): { projectId: string; revision: string; changes: string[] } {
  const projectPath = path.resolve(input.projectPath);
  if (!input.changes.length) throw new Error("apply requires at least one change");
  const raw = JSON.parse(fs.readFileSync(projectPath, "utf8")) as Record<string, unknown>;
  const current = parseProject(raw);
  const revision = `sha256:${projectSha256(current)}`;
  if (input.expectedRevision && input.expectedRevision !== revision) {
    throw new Error(`Revision conflict: expected ${input.expectedRevision}, found ${revision}. Re-read the project and re-apply.`);
  }
  const operations = input.changes.map(change => {
    const equals = change.indexOf("=");
    if (equals <= 0) throw new Error(`Change must look like path=value: ${change}`);
    const editPath = change.slice(0, equals).trim().replace(/\[(\d+)\]/g, ".$1").split(".").map(segment => segment.trim()).filter(Boolean);
    if (!editPath.length || editPath.length > 40) throw new Error(`Change path is invalid: ${change}`);
    let value: unknown;
    try { value = JSON.parse(change.slice(equals + 1).trim()); } catch { value = change.slice(equals + 1).trim(); }
    return { kind: "set" as const, path: editPath, value };
  });
  const store = new FileSessionStore(input.sessionDirectory, document => { parseProject(document); });
  const projectId = current.id;
  const opened = store.open(projectId, raw);
  if (opened.conflict) throw new Error("Session and project file have diverged; open the work in the studio to reconcile before applying MCP edits.");
  const { look } = store.snapshot(projectId);
  const applied = store.applyTransform(projectId, { id: `mcp-${randomUUID()}`, baseRevision: look.revision, actor: "cli", scope: {}, intent: "MCP glint_apply" }, () => operations);
  if (applied.receipt.stage !== "verified") throw new Error(`Session apply refused (${applied.receipt.stage}): ${"reason" in applied.receipt && applied.receipt.reason ? applied.receipt.reason : "transaction rejected"}`);
  const document = store.snapshot(projectId).snapshot.document as SceneScriptProject;
  return { projectId, revision: writeProjectJson(projectPath, document), changes: input.changes };
}
