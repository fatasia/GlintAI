/** Duration of a CBR mp3 buffer in ms, estimated from frame headers; fallback when parsing fails. */
export function parseMp3DurationMs(bytes: Uint8Array, fallbackMs: number): number {
  // Locate the first frame sync (0xFFEx) and read bitrate/samplerate.
  for (let i = 0; i < Math.min(bytes.length - 4, 4096); i++) {
    if (bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0) {
      const versionBits = (bytes[i + 1]! & 0x18) >> 3;
      const layerBits = (bytes[i + 1]! & 0x06) >> 1;
      if (versionBits !== 3 || layerBits !== 1) continue; // want MPEG1 Layer3
      const bitrateIndex = (bytes[i + 2]! & 0xf0) >> 4;
      const sampleRateIndex = (bytes[i + 2]! & 0x0c) >> 2;
      const padding = (bytes[i + 2]! & 0x02) >> 1;
      const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
      const sampleRates = [44100, 48000, 32000];
      const bitrate = (bitrates[bitrateIndex] ?? 0) * 1000;
      const sampleRate = sampleRates[sampleRateIndex] ?? 0;
      if (bitrate === 0 || sampleRate === 0) continue;
      const samplesPerFrame = 1152;
      const bytesPerFrame = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
      if (bytesPerFrame <= 0) continue;
      const frameCount = Math.floor((bytes.length - i) / bytesPerFrame);
      return Math.max(1, Math.round((frameCount * samplesPerFrame * 1000) / sampleRate));
    }
  }
  return fallbackMs;
}
