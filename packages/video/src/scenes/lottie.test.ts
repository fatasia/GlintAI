import { expect, it } from "vitest";
import { lottieFrameAt } from "./html-runtime";
it("uses relative Lottie frames, including nonzero in-points and fps conversion", () => {
  expect(lottieFrameAt(0, { fr: 24, ip: 100, op: 112 })).toBe(0);
  expect(lottieFrameAt(5 / 24, { fr: 24, ip: 100, op: 112 })).toBe(5);
  expect(lottieFrameAt(10, { fr: 24, ip: 100, op: 112 })).toBe(11);
  expect(lottieFrameAt(0.1, { fr: 24, ip: 0, op: 24 })).toBe(2);
});
it("rejects invalid Lottie time bases", () => {
  for (const data of [
    { fr: 0, ip: 0, op: 12 },
    { fr: 24, ip: 12, op: 0 },
    { fr: NaN, ip: 0, op: 12 },
  ])
    expect(() => lottieFrameAt(0, data)).toThrow("Invalid Lottie");
});
