export const WAV_SAMPLE_RATE = 24_000;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

/** 16-bit PCM mono silent WAV of the given duration. */
export function createSilentWav(
  durationMs: number,
  sampleRate = WAV_SAMPLE_RATE,
): Uint8Array {
  if (!(durationMs > 0)) {
    throw new Error(`durationMs must be positive, got ${durationMs}`);
  }
  const dataBytes = Math.ceil((durationMs / 1000) * sampleRate) * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

/** Duration from the WAV header; `fallbackMs` on anything unexpected. */
export function parseWavDurationMs(
  bytes: Uint8Array,
  fallbackMs: number,
): number {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
      return fallbackMs;
    }
    let sampleRate = 0;
    let channels = 0;
    let bitsPerSample = 0;
    let dataBytes = 0;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const id = readAscii(view, offset, 4);
      const size = view.getUint32(offset + 4, true);
      if (id === "fmt ") {
        channels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      } else if (id === "data") {
        dataBytes = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (!sampleRate || !channels || !bitsPerSample || !dataBytes) {
      return fallbackMs;
    }
    const seconds = dataBytes / (sampleRate * channels * (bitsPerSample / 8));
    return Math.max(1, Math.round(seconds * 1000));
  } catch {
    return fallbackMs;
  }
}
