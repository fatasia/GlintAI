export type ExpansionSize = "1536x864" | "864x1536";
export function expansionDimensions(size: ExpansionSize) {
  return size === "1536x864" ? { width: 1536, height: 864 } : { width: 864, height: 1536 };
}
export function expansionPlacement(sourceWidth: number, sourceHeight: number, size: ExpansionSize) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0 || sourceWidth * sourceHeight > 16_777_216) throw new Error("参考图片尺寸无效或超过 1600 万像素。");
  const target = expansionDimensions(size), scale = Math.min(target.width * 0.68 / sourceWidth, target.height * 0.68 / sourceHeight);
  const width = sourceWidth * scale, height = sourceHeight * scale;
  return { ...target, x: (target.width - width) / 2, y: (target.height - height) / 2, imageWidth: width, imageHeight: height };
}
/** Prepare a separate white-padded reference; the source is never modified. */
export async function makeExpansionReference(blob: Blob, size: ExpansionSize) {
  const bitmap = await createImageBitmap(blob);
  try {
    const box = expansionPlacement(bitmap.width, bitmap.height, size);
    const canvas = document.createElement("canvas"); canvas.width = box.width; canvas.height = box.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("当前浏览器无法准备扩画画布。");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, box.width, box.height);
    context.drawImage(bitmap, box.x, box.y, box.imageWidth, box.imageHeight);
    const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("扩画参考图生成失败。")), "image/png"));
    if (!result.size || result.size > 8 * 1024 * 1024) throw new Error("扩画参考图超过 8 MiB，请换用更简单的图片。");
    return result;
  } finally { bitmap.close(); }
}
export async function verifyExpansionSize(blob: Blob, size: ExpansionSize) {
  const bitmap = await createImageBitmap(blob);
  try {
    const expected = expansionDimensions(size);
    if (bitmap.width !== expected.width || bitmap.height !== expected.height) throw new Error(`输出尺寸 ${bitmap.width} × ${bitmap.height} 与目标 ${expected.width} × ${expected.height} 不一致，请检查网关结果。`);
    return expected;
  } finally { bitmap.close(); }
}
