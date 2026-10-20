import { expect, it } from "vitest";
import { analyzePcm16Wav } from "./audio-quality";
import { createSilentWav } from "./wav";
it("rejects silence even when the WAV header is nonzero", () => {
  expect(analyzePcm16Wav(createSilentWav(1000)).passed).toBe(false);
});
it("measures waveform energy and clipping", () => {
  const audio = createSilentWav(1000), view = new DataView(audio.buffer);
  for (let i = 44; i < audio.length; i += 2) view.setInt16(i, Math.round(8000 * Math.sin(i / 20)), true);
  expect(analyzePcm16Wav(audio).passed).toBe(true);
  for (let i = 44; i < audio.length; i += 2) view.setInt16(i, 32767, true);
  expect(analyzePcm16Wav(audio).checks.noClipping).toBe(false);
});
it("rejects truncated and unsupported WAVs", () => {
  const audio = createSilentWav(1000);
  expect(() => analyzePcm16Wav(audio.subarray(0, 200))).toThrow(/Truncated/);
  new DataView(audio.buffer).setUint16(20, 3, true);
  expect(() => analyzePcm16Wav(audio)).toThrow(/PCM16/);
});
