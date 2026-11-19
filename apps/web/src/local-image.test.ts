import { expect, it } from "vitest";
import { checkedOutputSize, removeKeyColor } from "./local-image";

it("creates transparent background while preserving foreground and existing alpha", () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 255, 127]);
  removeKeyColor(rgba, [255, 255, 255], 0, 0);
  expect([...rgba]).toEqual([255, 255, 255, 0, 255, 0, 0, 255, 0, 0, 255, 127]);
});
it("feathers near colours without increasing existing alpha", () => {
  const rgba = new Uint8ClampedArray([250, 250, 250, 200, 100, 100, 100, 123]);
  removeKeyColor(rgba, [255, 255, 255], 0, 5);
  expect(rgba[3]).toBeGreaterThan(0); expect(rgba[3]).toBeLessThan(200); expect(rgba[7]).toBe(123);
});
it("checks real output dimensions and bounds", () => {
  expect(checkedOutputSize(80, 60, 2)).toEqual({ width: 160, height: 120 });
  expect(checkedOutputSize(80, 60, 4)).toEqual({ width: 320, height: 240 });
  expect(() => checkedOutputSize(5000, 100, 2)).toThrow();
  expect(() => checkedOutputSize(3000, 3000, 2)).toThrow();
  expect(() => checkedOutputSize(1, 1, 3)).toThrow();
});
