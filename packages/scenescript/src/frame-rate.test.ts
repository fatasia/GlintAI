import { describe, expect, it } from "vitest";
import { frameRateOf, framesForMs, msForFrame, resolveFrameRate, sourceTimeForFrame, videoSourceWindow } from "./frame-rate";

describe("frame rate rationals", () => {
  it("keeps integer rates exact", () => {
    const rate = frameRateOf(30);
    expect(rate).toMatchObject({ value: 30, text: "30" });
    expect(framesForMs(1000, rate)).toBe(30);
    expect(framesForMs(500, rate)).toBe(15);
  });
  it("maps 29.97 and 23.976 to NTSC rationals", () => {
    expect(frameRateOf(29.97)).toMatchObject({ text: "30000/1001", numerator: 30000, denominator: 1001 });
    expect(frameRateOf(29.97002997).text).toBe("30000/1001");
    expect(frameRateOf(23.976).text).toBe("24000/1001");
    expect(frameRateOf(59.94).text).toBe("60000/1001");
  });
  it("never drifts on 1001ms boundaries", () => {
    const rate = frameRateOf(29.97);
    expect(framesForMs(1001, rate)).toBe(30);
    expect(framesForMs(10_010, rate)).toBe(300);
    expect(msForFrame(30, rate)).toBeCloseTo(1001, 6);
  });
  it("supports 23.976 with the same 1001ms boundary", () => {
    const rate = frameRateOf(23.976);
    expect(framesForMs(1001, rate)).toBe(24);
    expect(msForFrame(24, rate)).toBeCloseTo(1001, 6);
  });
  it("rejects impossible values and excess precision", () => {
    expect(() => frameRateOf(0)).toThrow(/1\.\.120/);
    expect(() => frameRateOf(Number.NaN)).toThrow(/1\.\.120/);
    expect(() => frameRateOf(29.9501)).toThrow(/three decimals/);
  });
  it("defaults to 30", () => {
    expect(resolveFrameRate(undefined).value).toBe(30);
  });
});

describe("retime", () => {
  it("maps composition frames to source time with speed and trim", () => {
    expect(sourceTimeForFrame(0, 30)).toBe(0);
    expect(sourceTimeForFrame(30, 30)).toBeCloseTo(1, 9);
    expect(sourceTimeForFrame(30, 30, { speed: 2 })).toBeCloseTo(2, 9);
    expect(sourceTimeForFrame(30, 30, { speed: 0.5, trimStartSec: 5 })).toBeCloseTo(5.5, 9);
  });
  it("rejects out-of-range speed", () => {
    expect(() => sourceTimeForFrame(1, 30, { speed: 8 })).toThrow(/0\.25\.\.4/);
  });
});

describe("video source window", () => {
  it("maps trim, speed and duration onto source frames", () => {
    expect(videoSourceWindow({}, 30, 60)).toEqual({ startFrom: 0, endAt: 60, playbackRate: 1 });
    expect(videoSourceWindow({ trimStartSec: 2, speed: 2 }, 30, 30)).toEqual({ startFrom: 60, endAt: 120, playbackRate: 2 });
    expect(videoSourceWindow({ trimStartSec: 1, trimEndSec: 3 }, 30, 30)).toEqual({ startFrom: 30, endAt: 90, playbackRate: 1 });
    expect(videoSourceWindow({ speed: 0.5 }, 30, 60)).toEqual({ startFrom: 0, endAt: 30, playbackRate: 0.5 });
  });
  it("rejects an inverted or empty window", () => {
    expect(() => videoSourceWindow({ trimStartSec: 2, trimEndSec: 1 }, 30, 30)).toThrow(/trim start/);
    expect(() => videoSourceWindow({ speed: 8 }, 30, 30)).toThrow(/0\.25\.\.4/);
    expect(() => videoSourceWindow({}, 30, 0)).toThrow(/durationFrames/);
  });
});