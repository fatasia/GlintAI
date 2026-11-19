import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { nleRenderOptions, nleMotionArgs } from "./nle-render-options";
const project = parseNleProject({
  schemaVersion: 1,
  id: "motion",
  title: "Motion",
  fps: 30,
  width: 1280,
  height: 720,
  tracks: [],
});
it("keeps disabled CLI arguments unchanged including 4K", () => {
  expect(nleMotionArgs()).toEqual([]);
  expect(nleRenderOptions({ ...project, width: 3840, height: 2160 })).toEqual({
    motionSamples: 1,
    shutterAngle: 180,
  });
});
it.each([2, 4, 8])("forwards %i samples and shutter angle to the existing CLI", (samples) => {
  expect(nleRenderOptions(project, samples, 270)).toEqual({
    motionSamples: samples,
    shutterAngle: 270,
  });
  expect(nleMotionArgs(samples, 270)).toEqual([
    `--motion-samples=${samples}`,
    "--shutter-angle=270",
  ]);
});
it.each([
  [3, 180],
  ["4", 180],
  [null, 180],
  [4, 0],
  [4, 361],
  [4, "180"],
  [4, null],
])("rejects unsupported motion input %j / %j", (samples, angle) => {
  expect(() => nleRenderOptions(project, samples, angle)).toThrow();
});
it("rejects 4K without resizing and enforces sample-frame and pixel budgets", () => {
  expect(() => nleRenderOptions({ ...project, width: 3840, height: 2160 }, 2)).toThrow("720p");
  const long = parseNleProject({
    ...project,
    tracks: [
      {
        id: "t",
        kind: "text",
        name: "Text",
        clips: [{ id: "c", kind: "text", text: "Motion", startMs: 0, durationMs: 20000 }],
      },
    ],
  });
  expect(() => nleRenderOptions(long, 4)).toThrow();
  expect(() => nleRenderOptions({ ...long, width: 320, height: 180 }, 8)).toThrow();
  expect(nleRenderOptions(long, 1).motionSamples).toBe(1);
});
