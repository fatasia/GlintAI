interface FrameHeader { length: number; samples: number; sampleRate: number }

function frameHeader(bytes: Uint8Array, i: number): FrameHeader | undefined {
  if (i + 4 > bytes.length || bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) return;
  const version = (bytes[i + 1]! >> 3) & 3, layer = (bytes[i + 1]! >> 1) & 3;
  const bitrateIndex = bytes[i + 2]! >> 4, sampleIndex = (bytes[i + 2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return;
  const table = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = [44100, 48000, 32000][sampleIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor((version === 3 ? 144 : 72) * table[bitrateIndex]! * 1000 / sampleRate) + ((bytes[i + 2]! >> 1) & 1);
  return { length, samples, sampleRate };
}

/** Walk real MPEG-1/2/2.5 Layer III frames; payload sync lookalikes are not frame boundaries. */
export function parseMp3DurationMs(bytes: Uint8Array, fallbackMs: number): number {
  let start = 0;
  if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "ID3") {
    const tagLength = ((bytes[6]! & 127) << 21) | ((bytes[7]! & 127) << 14) | ((bytes[8]! & 127) << 7) | (bytes[9]! & 127);
    start = 10 + tagLength + ((bytes[5]! & 16) ? 10 : 0);
  }
  if (start > bytes.length || (start + 4 <= bytes.length && bytes[start] !== 0xff)) return fallbackMs;
  const i = start;
  const first = frameHeader(bytes, i);
  if (!first || i + first.length > bytes.length) return fallbackMs;
    let cursor = i, duration = 0, count = 0;
    while (cursor + 4 <= bytes.length) {
      const frame = frameHeader(bytes, cursor);
      if (!frame || frame.sampleRate !== first.sampleRate || cursor + frame.length > bytes.length) break;
      duration += frame.samples * 1000 / frame.sampleRate; cursor += frame.length; count++;
    }
    // ID3v1 is the only accepted trailer; an incomplete frame is never padding.
    const end = bytes.length - cursor === 128 && String.fromCharCode(...bytes.subarray(cursor, cursor + 3)) === "TAG" ? cursor + 128 : cursor;
    if (!count || end !== bytes.length) return fallbackMs;
    // Xing/Info or VBRI frames carry duration and encoder delay/padding that
    // this frame-counting parser cannot reliably turn into playback samples.
    // Ancillary encoder strings are not markers: they can occur in ordinary audio.
    const mono = (bytes[i + 3]! >> 6) === 3;
    const mpeg1 = ((bytes[i + 1]! >> 3) & 3) === 3;
    const crc = (bytes[i + 1]! & 1) === 0 ? 2 : 0;
    const xingOffset = i + 4 + crc + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    const marker = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (xingOffset + 4 <= i + first.length && ["Xing", "Info"].includes(marker(xingOffset))) return fallbackMs;
    if (i + 40 <= i + first.length && marker(i + 36) === "VBRI") return fallbackMs;
    return Math.max(1, Math.round(duration));
}
