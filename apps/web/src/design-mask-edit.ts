// Masked local edit math (S-05). Mirrors the CLI pipeline: the gateway returns a
// full candidate, and the mask (white = edit, black = keep) blends locally so
// pixels outside the mask are preserved exactly — same contract as ffmpeg maskedmerge.
export const MASK_EDGES = 8; // luminance below this counts as "outside the mask"

export type Rgba = { data: Uint8ClampedArray; width: number; height: number };
export type MaskStats = {
  width: number; height: number;
  outsidePixels: number; outsideChangedPixels: number; maxOutsideDelta: number;
  insidePixels: number; insideChangedPixels: number; meanInsideDelta: number;
};

const clamp8 = (value: number) => value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
const luminance = (r: number, g: number, b: number) => (r * 77 + g * 150 + b * 29) >> 8;

/** Per-pixel blend: mask luminance picks between the original (0) and candidate (255). */
export function compositeMaskedPixels(original: Rgba, generated: Rgba, mask: Rgba): Rgba {
  if (generated.width !== original.width || generated.height !== original.height) throw new Error("候选尺寸与原图不一致，请先缩放到原图尺寸再合成。");
  if (mask.width !== original.width || mask.height !== original.height) throw new Error("掩膜尺寸与原图不一致。");
  const data = new Uint8ClampedArray(original.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const weight = luminance(mask.data[i]!, mask.data[i + 1]!, mask.data[i + 2]!);
    for (let channel = 0; channel < 3; channel++) {
      const kept = original.data[i + channel]!, edited = generated.data[i + channel]!;
      data[i + channel] = clamp8((kept * (255 - weight) + edited * weight) / 255);
    }
    data[i + 3] = original.data[i + 3]!;
  }
  return { data, width: original.width, height: original.height };
}

/** Evidence numbers: outside must be untouched by construction; inside should differ. */
export function maskDiffStats(before: Rgba, after: Rgba, mask: Rgba): MaskStats {
  if (after.width !== before.width || after.height !== before.height) throw new Error("对比尺寸不一致。");
  const stats: MaskStats = { width: before.width, height: before.height, outsidePixels: 0, outsideChangedPixels: 0, maxOutsideDelta: 0, insidePixels: 0, insideChangedPixels: 0, meanInsideDelta: 0 };
  let insideDeltaSum = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const inside = luminance(mask.data[i]!, mask.data[i + 1]!, mask.data[i + 2]!) >= MASK_EDGES;
    let delta = 0;
    for (let channel = 0; channel < 3; channel++) delta = Math.max(delta, Math.abs(after.data[i + channel]! - before.data[i + channel]!));
    if (inside) { stats.insidePixels++; if (delta > 0) { stats.insideChangedPixels++; insideDeltaSum += delta; } }
    else { stats.outsidePixels++; if (delta > 0) { stats.outsideChangedPixels++; stats.maxOutsideDelta = Math.max(stats.maxOutsideDelta, delta); } }
  }
  stats.meanInsideDelta = stats.insideChangedPixels ? Math.round((insideDeltaSum / stats.insideChangedPixels) * 10) / 10 : 0;
  return stats;
}

export function maskIsEmpty(mask: Rgba): boolean {
  for (let i = 0; i < mask.data.length; i += 4)
    if (luminance(mask.data[i]!, mask.data[i + 1]!, mask.data[i + 2]!) >= MASK_EDGES) return false;
  return true;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z\d+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("页面图片不是内联位图，无法安全提交。");
  const bytes = Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0));
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 8 MiB 限制（${bytes.length} 字节），未提交。`);
  return bytes;
}
export function libraryAssetName(src: string): string | null {
  return /^\/api\/media\/assets\/([a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp))$/.exec(src)?.[1] ?? null;
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export type SubmissionInput = { bindingId: string; type: "image"; model: string; prompt: string; params: Record<string, unknown>; referenceImage: string; referenceSha256: string };
export function buildSubmissionInput(parts: { bindingId: string; model: string; prompt: string; referenceImage: string; referenceSha256: string }): SubmissionInput {
  const prompt = parts.prompt.trim();
  if (!prompt) throw new Error("请填写修改描述，说明掩膜区域要改成什么。");
  if (!parts.bindingId) throw new Error("没有可用的图片模型绑定；请先在模型连接中绑定一个支持图片参考的模型。");
  if (prompt.length > 4000) throw new Error("修改描述超过 4000 字，请精简。");
  return { bindingId: parts.bindingId, type: "image", model: parts.model, prompt, params: {}, referenceImage: parts.referenceImage, referenceSha256: parts.referenceSha256 };
}
/** The selected node's inline/library image source, or null when it has no editable picture. */
export function selectedImageSrc(html: string, nodeId: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const node = doc.querySelector(`[data-design-id="${CSS.escape(nodeId)}"]`);
  const image = node?.tagName === "IMG" ? node : node?.querySelector("img");
  return image?.getAttribute("src") ?? null;
}
