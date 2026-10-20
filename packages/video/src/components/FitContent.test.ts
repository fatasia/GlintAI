import { expect, it } from "vitest";
import { contentScale } from "./FitContent";
it("fits long or wide content without upscaling", () => {
  expect(contentScale(1000, 600, 1000, 1200)).toBe(0.5);
  expect(contentScale(700, 1400, 1400, 600)).toBe(0.5);
  expect(contentScale(1000, 600, 200, 200)).toBe(1);
});
