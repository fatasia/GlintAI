/** Remove a selected solid colour while retaining the original alpha. */
export function removeKeyColor(data: Uint8ClampedArray, color: [number, number, number], tolerance: number, feather: number) {
  if (!Number.isFinite(tolerance) || !Number.isFinite(feather) || tolerance < 0 || tolerance > 100 || feather < 0 || feather > 100) throw new Error("Invalid colour-key settings");
  const inner = tolerance / 100 * Math.sqrt(3 * 255 ** 2);
  const outer = inner + feather / 100 * Math.sqrt(3 * 255 ** 2);
  for (let i = 0; i < data.length; i += 4) {
    const distance = Math.hypot(data[i]! - color[0], data[i + 1]! - color[1], data[i + 2]! - color[2]);
    const opacity = distance <= inner ? 0 : outer <= inner || distance >= outer ? 1 : (distance - inner) / (outer - inner);
    data[i + 3] = Math.round(data[i + 3]! * opacity);
  }
}

export function checkedOutputSize(width: number, height: number, scale: number) {
  const w = width * scale, h = height * scale;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || ![1, 2, 4].includes(scale) || w > 8192 || h > 8192 || w * h > 16_777_216) throw new Error("输出不能超过 8192 像素/边或 1600 万像素，请减小倍率或换用小图。");
  return { width: w, height: h };
}
