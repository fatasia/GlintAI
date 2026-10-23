import { describe, expect, it } from "vitest";
import { analyzeFrames, buildGates, DEFAULT_QA_THRESHOLDS, frameDiff, frameStats } from "./qa";

const W = 192, H = 108;
const rgbFrame = (fill: (x: number, y: number) => [number, number, number]) => {
  const data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fill(x, y);
      const offset = (y * W + x) * 3;
      data[offset] = r; data[offset + 1] = g; data[offset + 2] = b;
    }
  }
  return data;
};

describe("frameStats", () => {
  it("reads flat gray as high-std-free and zero blue-purple", () => {
    const stats = frameStats(rgbFrame(() => [128, 128, 128]));
    expect(stats.meanLuma).toBeCloseTo(128, 0);
    expect(stats.pixelStd).toBeLessThan(1);
    expect(stats.bluePurpleShare).toBe(0);
  });

  it("counts saturated blue-purple pixels toward the slop share", () => {
    const stats = frameStats(rgbFrame(() => [124, 92, 255]));
    expect(stats.bluePurpleShare).toBeGreaterThan(0.9);
    expect(frameStats(rgbFrame(() => [14, 159, 119])).bluePurpleShare).toBe(0); // mint
  });
});

describe("frameDiff", () => {
  it("is zero for identical frames and grows with change", () => {
    const a = rgbFrame(() => [100, 100, 100]);
    expect(frameDiff(a, a)).toBe(0);
    const b = rgbFrame((x) => (x < W / 2 ? [30, 30, 30] : [220, 220, 220]));
    expect(frameDiff(a, b)).toBeGreaterThan(10);
  });
});

describe("analyzeFrames + buildGates", () => {
  it("green-lights a moving, on-palette film", () => {
    const frames = Array.from({ length: 8 }, (_, i) =>
      rgbFrame((x, y) => [(x * 2 + i * 40) % 256, (y * 2) % 256, 60 + ((x + i * 17) % 60)]));
    const analysis = analyzeFrames(frames);
    const spec = { width: 1920, height: 1080, fps: 30, durationSec: 20 };
    const gates = buildGates(analysis, spec);
    expect(gates.find((gate) => gate.id === "richness")!.level).not.toBe("red");
    expect(gates.find((gate) => gate.id === "blue-purple")!.level).toBe("green");
  });

  it("red-lights a frozen, purple slideshow", () => {
    const frames = Array.from({ length: 10 }, () => rgbFrame(() => [124, 92, 255]));
    const analysis = analyzeFrames(frames);
    expect(analysis.avgFrameDiff).toBeLessThan(DEFAULT_QA_THRESHOLDS.minAvgDiff);
    expect(analysis.bluePurpleRatio).toBeGreaterThan(DEFAULT_QA_THRESHOLDS.maxBluePurpleRatio);
    const gates = buildGates(analysis, { width: 1920, height: 1080, fps: 30, durationSec: 25 });
    expect(gates.find((gate) => gate.id === "blue-purple")!.level).toBe("red");
    expect(gates.find((gate) => gate.id === "richness")!.level).toBe("red");
    expect(gates.find((gate) => gate.id === "empty-frames")!.level).toBe("red");
  });

  it("marks missing duration as a broken spec", () => {
    const gates = buildGates({ avgFrameDiff: 9, longestStaticSec: 0, bluePurpleRatio: 0, flatFrameRatio: 0 },
      { width: 1920, height: 1080, fps: 30, durationSec: Number.NaN });
    expect(gates.find((gate) => gate.id === "spec")!.level).toBe("red");
  });
});

describe("first-frame gate", () => {
  it("red-lights an empty opening even when later frames move", () => {
    const frames = [rgbFrame(() => [0, 0, 0]), ...Array.from({ length: 6 }, (_, i) =>
      rgbFrame((x, y) => [(x * 3 + i * 30) % 256, (y * 2 + i * 15) % 256, 90]))];
    const gates = buildGates(analyzeFrames(frames), { width: 1920, height: 1080, fps: 30, durationSec: 15 });
    expect(gates.find(gate => gate.id === "first-frame")!.level).toBe("red");
  });
  it("green-lights a textured opening", () => {
    const first = rgbFrame((x, y) => ((x + y) % 2 ? [240, 235, 220] : [28, 30, 36]));
    const frames = [first, ...Array.from({ length: 5 }, (_, i) => rgbFrame((x, y) => [80 + i * 10, 120, 160]))];
    const gates = buildGates(analyzeFrames(frames), { width: 1920, height: 1080, fps: 30, durationSec: 15 });
    expect(gates.find(gate => gate.id === "first-frame")!.level).toBe("green");
  });
});
