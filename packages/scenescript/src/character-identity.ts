import { parseProject } from "./parse";
import type { AssetIdentity, SceneScriptProject } from "./types";

/** Product versions use the same pinned identity rules without changing narration. */
export function saveProductIdentity(project: SceneScriptProject, draft: AssetIdentity): SceneScriptProject {
  const current = parseProject(project);
  if (current.frozen || draft.kind !== "product" || draft.approval) throw new Error("只能在未冻结工程中保存商品草稿。");
  const existing = current.assets?.find(item => item.id === draft.id);
  if (existing?.approval || (existing && existing.kind !== "product")) throw new Error("资产已批准或编号被占用，请创建新版本。");
  if (existing && existing.version !== draft.version && current.scenes.some(scene => scene.assetRefs?.some(ref => ref.assetId === draft.id))) throw new Error("商品已被镜头引用，不能直接变更版本。");
  return parseProject({ ...current, assets: existing ? current.assets!.map(item => item.id === draft.id ? draft : item) : [...(current.assets ?? []), draft] });
}

export function bindProductToScene(project: SceneScriptProject, sceneId: string, assetId: string): SceneScriptProject {
  const current = parseProject(project), asset = current.assets?.find(item => item.id === assetId), scene = current.scenes.find(item => item.id === sceneId);
  if (current.frozen || !scene || scene.locked || !asset || asset.kind !== "product" || !asset.approval || scene.assetRefs?.some(ref => ref.assetId === assetId)) throw new Error("请选择已批准商品和未锁定、未绑定的镜头。");
  return parseProject({ ...current, scenes: current.scenes.map(item => item.id === sceneId ? { ...item, assetRefs: [...(item.assetRefs ?? []), { assetId, version: asset.version }] } : item) });
}

export function forkProductIdentity(project: SceneScriptProject, assetId: string, newId: string): SceneScriptProject {
  const current = parseProject(project), original = current.assets?.find(item => item.id === assetId);
  if (current.frozen || !original || original.kind !== "product" || !original.approval || current.assets?.some(item => item.id === newId)) throw new Error("请选择已批准商品和未占用的新编号。");
  const { approval: _approval, derivedFrom: _derivedFrom, ...rest } = original;
  return parseProject({ ...current, assets: [...(current.assets ?? []), { ...rest, id: newId, version: `${original.version.slice(0, 35)}-next`, derivedFrom: { assetId: original.id, version: original.version } }] });
}

export function upgradeProductScene(project: SceneScriptProject, sceneId: string, assetId: string): SceneScriptProject {
  const current = parseProject(project), asset = current.assets?.find(item => item.id === assetId), scene = current.scenes.find(item => item.id === sceneId);
  if (current.frozen || !asset || asset.kind !== "product" || !asset.approval || !asset.derivedFrom || !scene || scene.locked) throw new Error("请选择已批准的新商品版本和未锁定镜头。");
  const origin = asset.derivedFrom;
  if (!scene.assetRefs?.some(ref => ref.assetId === origin.assetId && ref.version === origin.version) || scene.assetRefs.some(ref => ref.assetId === asset.id)) throw new Error("当前镜头未绑定旧版本，或已绑定新版本。");
  return parseProject({ ...current, scenes: current.scenes.map(item => item.id === sceneId ? { ...item, assetRefs: scene.assetRefs!.map(ref => ref.assetId === origin.assetId ? { assetId: asset.id, version: asset.version } : ref) } : item) });
}

/** Editable drafts are project-owned; approved snapshots must not be changed in place. */
export function saveCharacterIdentity(project: SceneScriptProject, draft: AssetIdentity): SceneScriptProject {
  const current = parseProject(project);
  if (current.frozen) throw new Error("工程已冻结，不能修改角色资产。");
  if (draft.kind !== "character" || draft.approval) throw new Error("只能保存未批准的角色草稿。");
  const existing = current.assets?.find(item => item.id === draft.id);
  if (existing?.approval) throw new Error("角色已批准，不能原位修改；请创建新版本并重新审阅引用镜头。");
  if (existing && existing.kind !== "character") throw new Error("资产编号已被其他类型使用。");
  if (existing && existing.version !== draft.version && current.scenes.some(scene => scene.assetRefs?.some(ref => ref.assetId === draft.id))) throw new Error("角色已被镜头引用，不能直接变更版本。");
  return parseProject({ ...current, assets: existing ? current.assets!.map(item => item.id === draft.id ? draft : item) : [...(current.assets ?? []), draft] });
}

export function approveCharacterIdentity(project: SceneScriptProject, assetId: string): SceneScriptProject {
  const current = parseProject(project);
  if (current.frozen) throw new Error("工程已冻结，不能批准角色资产。");
  const asset = current.assets?.find(item => item.id === assetId);
  if (!asset || asset.kind !== "character") throw new Error("角色资产不存在。");
  if (asset.approval) return current;
  if (!asset.description?.trim() || !asset.voice?.trim() || !asset.refs?.length || asset.refs.some(ref => !/\.(png|jpg|jpeg|webp)$/i.test(ref))) throw new Error("批准前需要填写外观描述、音色 ID 和至少一张本地参考图片。");
  const approval = { name: asset.name, version: asset.version, description: asset.description, voice: asset.voice, refs: [...asset.refs] };
  return parseProject({ ...current, assets: current.assets!.map(item => item.id === assetId ? { ...item, approval } : item) });
}

/** Explicit action: attach a pinned approved identity and set this scene's voice. */
export function bindCharacterToScene(project: SceneScriptProject, sceneId: string, assetId: string): SceneScriptProject {
  const current = parseProject(project);
  if (current.frozen) throw new Error("工程已冻结，不能绑定角色。");
  const asset = current.assets?.find(item => item.id === assetId), scene = current.scenes.find(item => item.id === sceneId);
  if (!scene || scene.locked) throw new Error("目标镜头不存在或已锁定。");
  if (!asset || asset.kind !== "character" || !asset.approval || !asset.voice) throw new Error("请先批准角色资产。");
  if ((scene.assetRefs ?? []).some(ref => ref.assetId === assetId)) throw new Error("该角色已绑定当前镜头。");
  const updated = { ...scene, assetRefs: [...(scene.assetRefs ?? []), { assetId, version: asset.version }], narration: { ...scene.narration, voice: asset.voice } };
  return parseProject({ ...current, scenes: current.scenes.map(item => item.id === sceneId ? updated : item) });
}

/** A new ID keeps the old approved version and its scene bindings intact. */
export function forkCharacterIdentity(project: SceneScriptProject, assetId: string, newId: string): SceneScriptProject {
  const current = parseProject(project);
  if (current.frozen) throw new Error("工程已冻结，不能新建角色版本。");
  const original = current.assets?.find(asset => asset.id === assetId);
  if (!original || original.kind !== "character" || !original.approval) throw new Error("请先选择已批准的角色版本。");
  if (current.assets?.some(asset => asset.id === newId)) throw new Error("新角色编号已存在。");
  const { approval: _approval, derivedFrom: _derivedFrom, ...rest } = original;
  const draft = { ...rest, id: newId, version: `${original.version.slice(0, 35)}-next`, derivedFrom: { assetId: original.id, version: original.version } };
  return parseProject({ ...current, assets: [...(current.assets ?? []), draft] });
}

/** Rebind only the selected shot; never rewrite the original version or other shots. */
export function upgradeCharacterScene(project: SceneScriptProject, sceneId: string, assetId: string): SceneScriptProject {
  const current = parseProject(project);
  if (current.frozen) throw new Error("工程已冻结，不能更换角色版本。");
  const asset = current.assets?.find(item => item.id === assetId), scene = current.scenes.find(item => item.id === sceneId);
  if (!asset || asset.kind !== "character" || !asset.approval || !asset.derivedFrom || !asset.voice || !scene || scene.locked) throw new Error("请选择已批准的新版本和未锁定镜头。");
  const origin = asset.derivedFrom;
  if (!scene.assetRefs?.some(ref => ref.assetId === origin.assetId && ref.version === origin.version) || scene.assetRefs.some(ref => ref.assetId === asset.id)) throw new Error("当前镜头未绑定旧版本，或已绑定新版本。");
  const updated = { ...scene, assetRefs: scene.assetRefs.map(ref => ref.assetId === origin.assetId ? { assetId: asset.id, version: asset.version } : ref), narration: { ...scene.narration, voice: asset.voice } };
  return parseProject({ ...current, scenes: current.scenes.map(item => item.id === sceneId ? updated : item) });
}
