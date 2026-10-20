/** Signal checks for PCM16 WAV; these do not measure naturalness or speaker identity. */
export function analyzePcm16Wav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, n: number) => String.fromCharCode(...bytes.subarray(offset, offset + n));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("Expected RIFF WAV");
  let rate = 0, channels = 0, dataStart = -1, dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > bytes.length) throw new Error("Truncated WAV chunk");
    if (ascii(offset, 4) === "fmt ") {
      if (size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16) throw new Error("Expected PCM16 WAV");
      channels = view.getUint16(start + 2, true); rate = view.getUint32(start + 4, true);
    }
    if (ascii(offset, 4) === "data") { dataStart = start; dataSize = size; }
    offset = start + size + size % 2;
  }
  if (!rate || !channels || dataStart < 0 || !dataSize || dataSize % (2 * channels)) throw new Error("Invalid WAV samples");
  const frames = dataSize / (channels * 2), threshold = 10 ** (-45 / 20);
  let peak = 0, energy = 0, clipped = 0, active = 0, first = frames, last = -1;
  for (let frame = 0; frame < frames; frame++) {
    let framePeak = 0;
    for (let ch = 0; ch < channels; ch++) {
      const raw = view.getInt16(dataStart + (frame * channels + ch) * 2, true), sample = Math.abs(raw / 32768);
      peak = Math.max(peak, sample); framePeak = Math.max(framePeak, sample); energy += sample * sample;
      if (Math.abs(raw) >= 32767) clipped++;
    }
    if (framePeak > threshold) { active++; first = Math.min(first, frame); last = frame; }
  }
  const rmsDbfs = 10 * Math.log10(Math.max(energy / (frames * channels), 1e-12));
  const metrics = { sampleRate: rate, channels, durationMs: frames / rate * 1000, peakDbfs: 20 * Math.log10(Math.max(peak, 1e-6)), rmsDbfs, clippedFraction: clipped / (frames * channels), activeFraction: active / frames, leadingSilenceMs: first / rate * 1000, trailingSilenceMs: (frames - last - 1) / rate * 1000 };
  const checks = { audible: rmsDbfs > -40 && active / frames > 0.1, noClipping: metrics.clippedFraction <= 0.001, boundedSilence: metrics.leadingSilenceMs <= 2000 && metrics.trailingSilenceMs <= 2000 };
  return { ...metrics, checks, passed: Object.values(checks).every(Boolean) };
}
