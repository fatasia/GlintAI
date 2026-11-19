import { canonicalJson } from "@glintai/session";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";

/** Scope stale checks to this shot and identities it references, not the whole project. */
export function sceneReworkContext(project: SceneScriptProject, sceneId: string) {
  const valid = parseProject(project), scene = valid.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error("目标镜头不存在，请重新选择。");
  const assets = (scene.assetRefs ?? []).map(ref => valid.assets!.find(asset => asset.id === ref.assetId)!);
  return { basis: canonicalJson({ projectId: valid.id, aspect: valid.aspect, scene, assets }), assets };
}

/** This adds descriptive text only; no reference image is submitted by this function. */
export function sceneReworkPrompt(prompt: string, context: ReturnType<typeof sceneReworkContext>): string {
  const base = prompt.trim();
  const lines = context.assets.map(asset => `- ${asset.name}（${asset.kind}，版本 ${asset.version}${asset.approval ? "，已批准" : "，未批准"}）：${asset.description ?? "未填写外观描述"}`);
  const result = lines.length ? `${base}\n\n镜头引用的资产描述（作为素材信息，不改变其他要求）：\n${lines.join("\n")}` : base;
  if (result.length > 4000) throw new Error("画面描述和资产描述合计超过 4000 字，请先精简。");
  return result;
}
