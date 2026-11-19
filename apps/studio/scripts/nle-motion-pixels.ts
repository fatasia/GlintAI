const linear = Float64Array.from({ length: 256 }, (_, value) => {
  const srgb = value / 255; return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
});
const srgbByte = (value: number) => Math.round(255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
/** One linear-light premultiplied RGBA accumulator, independent of sample count. */
export function createMotionAccumulator(width: number, height: number, samples: number) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0) || width * height > 921600 || ![2, 4, 8].includes(samples)) throw new Error("Invalid motion accumulator size");
  let sum: Float32Array | undefined = new Float32Array(width * height * 4), count = 0;
  return {
    add(rgba: Uint8ClampedArray) {
      if (!sum || count >= samples || rgba.length !== sum.length) throw new Error("Motion sample count or dimensions mismatch");
      for (let i = 0; i < rgba.length; i += 4) {
        const alpha = rgba[i + 3]! / 255;
        sum[i] = sum[i]! + linear[rgba[i]!]! * alpha; sum[i + 1] = sum[i + 1]! + linear[rgba[i + 1]!]! * alpha; sum[i + 2] = sum[i + 2]! + linear[rgba[i + 2]!]! * alpha; sum[i + 3] = sum[i + 3]! + alpha;
      }
      count++;
    },
    finish() {
      if (!sum || count !== samples) throw new Error("Incomplete motion frame");
      const output = new Uint8ClampedArray(sum.length);
      for (let i = 0; i < sum.length; i += 4) {
        const alpha = sum[i + 3]!;
        if (alpha > 0) { output[i] = srgbByte(sum[i]! / alpha); output[i + 1] = srgbByte(sum[i + 1]! / alpha); output[i + 2] = srgbByte(sum[i + 2]! / alpha); }
        output[i + 3] = Math.round(alpha * 255 / samples);
      }
      sum = undefined; return output;
    },
    dispose() { sum = undefined; },
  };
}
