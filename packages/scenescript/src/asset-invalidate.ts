import { parseProject } from "./parse";
import type { SceneScriptProject } from "./types";

/**
 * TEAM-03 资产失效影响面：资产升级前，反查引用了它的场景清单。
 * 纯查询不重算。「失效仅影响引用它的场景」由两半共同保证：
 * schema 强制场景 pin 等于资产当前版本（types.ts superRefine），本模块给出
 * 升级前的影响面清单——先按清单重生成场景，再统一 bump 资产版本。
 */
export interface AssetChange { assetId: string; newVersion: string }

export function scenesAffectedByAsset(project: SceneScriptProject, assetId: string): string[] {
  parseProject(project);
  return project.scenes
    .filter(scene => (scene.assetRefs ?? []).some(ref => ref.assetId === assetId))
    .map(scene => scene.id);
}

export function invalidationReport(project: SceneScriptProject, changes: AssetChange[]): Array<AssetChange & { affectedSceneIds: string[]; needsRegeneration: boolean }> {
  parseProject(project);
  return changes.map(change => {
    const affectedSceneIds = scenesAffectedByAsset(project, change.assetId);
    return { ...change, affectedSceneIds, needsRegeneration: affectedSceneIds.length > 0 };
  });
}

/** One scene's regeneration step. Pure: returns the replacement scene content. */
export type SceneRegenerator = (scene: SceneScriptProject["scenes"][number], change: { assetId: string; fromVersion: string; toVersion: string }) => SceneScriptProject["scenes"][number];

export interface RegenReceipt {
  ok: boolean; assetId: string; fromVersion: string; toVersion: string;
  /** Scenes regenerated before success — or before a failure stopped the run. */
  regeneratedSceneIds: string[]; failedSceneId?: string; reason?: string;
}

/**
 * TEAM-03 重算执行流：按影响面清单逐镜重生成，全部完成后才统一 bump 资产版本。
 * 约束：原子性——要么重生成 → 统一重 pin → bump → schema 门全部通过后一次生效，
 * 要么原工程原样返回；中途失败绝不留下「半新半旧」的 pin 组合。
 * 重 pin 由执行流统一负责：schema 强制 pin==当前版本，重生成器只负责场景内容。
 */
export function executeAssetRegeneration(project: SceneScriptProject, change: AssetChange, regenerate: SceneRegenerator): { project: SceneScriptProject; receipt: RegenReceipt } {
  parseProject(project);
  const asset = project.assets?.find(entry => entry.id === change.assetId);
  if (!asset) return { project, receipt: { ok: false, assetId: change.assetId, fromVersion: "", toVersion: change.newVersion, regeneratedSceneIds: [], reason: `unknown asset "${change.assetId}"` } };
  if (asset.version === change.newVersion) return { project, receipt: { ok: true, assetId: change.assetId, fromVersion: asset.version, toVersion: change.newVersion, regeneratedSceneIds: [] } };
  const affected = scenesAffectedByAsset(project, change.assetId);
  const refusal = project.frozen ? "project is frozen" : asset.approval ? "approved asset identity cannot be changed in place" : affected.some(id => project.scenes.find(scene => scene.id === id)?.locked) ? "affected scene is locked" : undefined;
  if (refusal) return { project, receipt: { ok: false, assetId: change.assetId, fromVersion: asset.version, toVersion: change.newVersion, regeneratedSceneIds: [], reason: refusal } };
  const regeneratedSceneIds: string[] = [];
  let current = "";
  try {
    const next = structuredClone(project);
    for (const sceneId of affected) {
      current = sceneId;
      const index = next.scenes.findIndex(scene => scene.id === sceneId);
      const original = next.scenes[index]!;
      const fresh = regenerate(structuredClone(original), { assetId: change.assetId, fromVersion: asset.version, toVersion: change.newVersion });
      const oldRefs = original.assetRefs ?? [], newRefs = fresh?.assetRefs ?? [];
      if (!fresh || fresh.id !== original.id || newRefs.length !== oldRefs.length || newRefs.some((ref, i) => ref.assetId !== oldRefs[i]!.assetId || ref.version !== oldRefs[i]!.version)) throw new Error(`regenerator changed scene identity or asset references for "${sceneId}"`);
      for (const ref of fresh.assetRefs ?? []) if (ref.assetId === change.assetId) ref.version = change.newVersion;
      next.scenes[index] = fresh;
      regeneratedSceneIds.push(sceneId);
    }
    next.assets!.find(entry => entry.id === change.assetId)!.version = change.newVersion;
    parseProject(next); // 原子门：任一场景不合格（含 pin 不一致）则整体回退
    return { project: next, receipt: { ok: true, assetId: change.assetId, fromVersion: asset.version, toVersion: change.newVersion, regeneratedSceneIds } };
  } catch (error) {
    return { project, receipt: { ok: false, assetId: change.assetId, fromVersion: asset.version, toVersion: change.newVersion, regeneratedSceneIds, ...(current ? { failedSceneId: current } : {}), reason: error instanceof Error ? error.message : String(error) } };
  }
}
