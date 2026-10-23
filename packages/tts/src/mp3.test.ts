import { describe, expect, it } from "vitest";
import { parseMp3DurationMs } from "./mp3";

function mp3Frames(header: number[], size: number, count: number) {
  const bytes = new Uint8Array(size * count);
  for (let i = 0; i < count; i++) bytes.set(header, i * size);
  return bytes;
}

describe("MP3 frame duration", () => {
  it("measures Edge 24kHz MPEG-2 48kbps without mistaking payload for MPEG-1", () => {
    const bytes = mp3Frames([0xff, 0xf3, 0x64, 0xc4], 144, 137);
    bytes.set([0xff, 0xfb, 0x90, 0x00], 30);
    expect(parseMp3DurationMs(bytes, 9999)).toBe(3288);
  });
  it("measures MPEG-1 and MPEG-2.5 frames", () => {
    expect(parseMp3DurationMs(mp3Frames([0xff, 0xfb, 0x90, 0], 417, 100), 9999)).toBe(2612);
    expect(parseMp3DurationMs(mp3Frames([0xff, 0xe3, 0x64, 0], 288, 100), 9999)).toBe(4800);
  });
  it("skips an ID3 tag and accepts a small trailing tag", () => {
    const audio = mp3Frames([0xff, 0xf3, 0x64, 0], 144, 10), bytes = new Uint8Array(10 + 5 + audio.length + 128);
    bytes.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 5]); bytes.set(audio, 15);
    expect(parseMp3DurationMs(bytes, 123)).toBe(240);
  });
  it("uses fallback for junk, truncated streams and false sync", () => {
    expect(parseMp3DurationMs(new Uint8Array(1024), 456)).toBe(456);
    expect(parseMp3DurationMs(new Uint8Array([255, 251, 144, 0, 1]), 456)).toBe(456);
  });
});
