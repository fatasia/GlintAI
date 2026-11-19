import { normalizeCommandArgs } from "./glint-runtime";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { checkMotionBudget, motionCliOptions, motionOptions, motionTimes } from "./nle-motion";
import { createMotionAccumulator } from "./nle-motion-pixels";
it("keeps default sample time and clamps fixed midpoint samples at starts and cuts", () => {
  expect(motionTimes(1, 20, [0], motionOptions())).toEqual([50]);
  expect(motionTimes(1, 20, [0], motionOptions(4, 360))).toEqual([6.25, 18.75, 31.25, 43.75]);
  expect(motionTimes(0, 20, [0], motionOptions(8))).toEqual(Array(8).fill(0));
  expect(motionTimes(2, 20, [0, 100], motionOptions(4))).toEqual(Array(4).fill(100));
  expect(motionTimes(3, 20, [0, 100, 145], motionOptions(4, 360))).toEqual([145, 145, 145, 145]);
  expect(motionTimes(3, 20, [0, 125], motionOptions(4, 360))).toEqual([125, 125, 131.25, 143.75]);
});
it("validates options strictly while leaving disabled exports free of the new limits", () => {
  for (const n of [0, 3, 16, NaN]) expect(() => motionOptions(n)).toThrow();
  for (const n of [0, -1, 361, Infinity]) expect(() => motionOptions(2, n)).toThrow();
  for (const args of [["--motion-samples"], ["--motion-samples="], ["--motion-samples=2", "--motion-samples=4"], ["--shutter-angle=nan"]]) expect(() => motionCliOptions(args)).toThrow();
  expect(motionCliOptions(["--motion-samples=4", "--shutter-angle=270"])).toEqual({ samples: 4, shutterAngle: 270 });
  expect(() => checkMotionBudget(motionOptions(), 3840, 2160, 100000)).not.toThrow();
  expect(() => checkMotionBudget(motionOptions(4), 1280, 720, 300)).not.toThrow();
  for (const [w,h,f] of [[1920,1080,1], [1280,720,301], [320,180,601]]) expect(() => checkMotionBudget(motionOptions(4), w!,h!,f!)).toThrow();
});
it("averages linear light rather than encoded values", () => {
  const a = createMotionAccumulator(1, 1, 2); a.add(new Uint8ClampedArray([0,0,0,255])); a.add(new Uint8ClampedArray([255,255,255,255]));
  expect([...a.finish()]).toEqual([188,188,188,255]); expect(() => a.finish()).toThrow();
});
it("uses premultiplied alpha so transparent black cannot darken moving edges", () => {
  const a = createMotionAccumulator(1,1,2); a.add(new Uint8ClampedArray([255,0,0,255])); a.add(new Uint8ClampedArray([0,0,0,0]));
  expect([...a.finish()]).toEqual([255,0,0,128]);
  const b = createMotionAccumulator(1,1,2); expect(() => b.finish()).toThrow(); expect(() => b.add(new Uint8ClampedArray(3))).toThrow(); b.dispose(); expect(() => b.add(new Uint8ClampedArray(4))).toThrow();
});

it("rejects motion parameters on unsupported CLI paths instead of ignoring them", () => {
  const script = fileURLToPath(new URL("./glint.ts", import.meta.url));
  for (const command of ["render-native", "render", "alpha-webm"]) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(new URL("../package.json", import.meta.url)).resolve("tsx")).href, script, command, "--motion-samples=4"], { encoding: "utf8" });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("supported only by nle-render");
  }
});

it("preserves delivery policy normalization and ordinary arguments before path handling", () => {
  expect(normalizeCommandArgs("delivery-check", ["--audio=required", "--audio=optional", "--audio=forbidden", "--audio=clip.wav"])).toEqual(["--audio-policy=required", "--audio-policy=optional", "--audio-policy=forbidden", "--audio=clip.wav"]);
  const normal = ["--audio=required", "--out=result.mp4"]; expect(normalizeCommandArgs("nle-render", normal)).toEqual(normal);
  expect(normalizeCommandArgs("nle-render", ["--motion-samples=4", "--shutter-angle=180"])).toEqual(["--motion-samples=4", "--shutter-angle=180"]);
  expect(() => normalizeCommandArgs("render", ["--shutter-angle=180"])).toThrow("only by nle-render");
});
