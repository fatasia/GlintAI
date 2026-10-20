import { describe, expect, it } from "vitest";
import { encodingOptions } from "./encoding";

describe("video encoding profiles", () => {
  it("defaults to compatible balanced H264 quality control", () => {
    expect(encodingOptions()).toEqual({ crf: 20, x264Preset: "slow", audioBitrate: "128k" });
  });
  it("reduces bitrate budget only by explicit compact selection", () => {
    expect(encodingOptions("compact").crf).toBeGreaterThan(encodingOptions().crf);
    expect(encodingOptions("quality").crf).toBeLessThan(encodingOptions().crf);
  });
  it.each(["invalid", "__proto__", "constructor", ""])("rejects invalid profile %s", (profile) => {
    expect(() => encodingOptions(profile)).toThrow(/encoding must/);
  });
});
