import { expect, it } from "vitest";
import { waveformPeaks } from "./VoiceWaveform";
it("normalizes the peak envelope and keeps silence at zero", () => {
  const samples = new Float32Array([0, 0, 0.5, -0.25, 0.1, 0.1, 0, 1, -1, 0.25]);
  const peaks = waveformPeaks(samples, 5);
  expect(peaks).toHaveLength(5);
  expect(Math.max(...peaks)).toBe(1);
  expect(peaks[4]).toBeGreaterThan(0);
  expect(waveformPeaks(new Float32Array(0), 3)).toEqual([0, 0, 0]);
});
