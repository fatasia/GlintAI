import { parseProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
export function prepareMediaInput(input, mediaJobs, sessionStore) {
  // Only a durable, approved and shot-bound identity can contribute a reference.
  // Do not accept an arbitrary local file path from the browser.
  delete input.referenceImage;
  delete input.referenceSha256;
  delete input.referenceBinding;
  if (
    [input.canvasReference, input.reference, input.libraryReference].filter(
      (value) => value !== undefined,
    ).length > 1
  )
    throw new Error("Choose only one reference source");
  if (
    input.canvasReference !== undefined &&
    (!input.canvasReference ||
      typeof input.canvasReference !== "object" ||
      typeof input.canvasReference.taskId !== "string" ||
      typeof input.canvasReference.sha256 !== "string")
  )
    throw new Error("Invalid canvas reference receipt");
  if (input.libraryReference !== undefined) {
    const ref = input.libraryReference;
    if (
      !ref ||
      typeof ref !== "object" ||
      typeof ref.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp)$/.test(ref.name) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256 ?? "")
    )
      throw new Error("Invalid library reference");
    mediaJobs.verifyReference(ref.name, ref.sha256);
    input.referenceImage = ref.name;
    input.referenceSha256 = ref.sha256;
    delete input.libraryReference;
  }
  if (input.reference) {
    const { projectId, sceneId, assetId, basis } = input.reference;
    if (
      typeof projectId !== "string" ||
      typeof sceneId !== "string" ||
      typeof assetId !== "string" ||
      typeof basis !== "string"
    )
      throw new Error("Invalid reference request");
    const project = parseProject(sessionStore.snapshot(projectId).snapshot.document);
    if (project.frozen) throw new Error("工程已冻结，无法采用参考候选；请先解除冻结再提交任务。");
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene || scene.locked) throw new Error("Reference shot is unavailable or locked");
    const assets = (scene.assetRefs ?? []).map((ref) =>
      project.assets.find((item) => item.id === ref.assetId),
    );
    if (canonicalJson({ projectId: project.id, aspect: project.aspect, scene, assets }) !== basis)
      throw new Error("镜头或资产已变化，请同步工程后重新确认。");
    const character = assets.find(
      (item) =>
        item?.id === assetId && ["character", "product"].includes(item.kind) && item.approval,
    );
    const ref = character?.approval?.refs?.[0],
      sha256 = character?.approval?.refSha256;
    if (!sha256) throw new Error("旧批准未绑定图片内容；请新建版本并重新批准后使用参考图。");
    if (!ref || !/^assets\/[a-zA-Z0-9_-]{1,100}\.(png|jpg|webp)$/.test(ref))
      throw new Error("请选择已批准且绑定镜头的素材库角色参考图。");
    input.referenceImage = ref.slice("assets/".length);
    input.referenceSha256 = sha256;
    input.referenceBinding = {
      projectId,
      sceneId,
      assetId,
      basis,
      referenceImage: input.referenceImage,
      sha256,
    };
    delete input.reference;
  }
  return input;
}
