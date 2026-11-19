import { expect, it } from "vitest";
import { parseCanvasViewport } from "./canvas-viewport";
it("restores finite viewport values without converting strings", () => {
  expect(parseCanvasViewport(null)).toBeUndefined();
  expect(parseCanvasViewport('{"x":-400,"y":120,"zoom":0.5}')).toEqual({x:-400,y:120,zoom:0.5});
});
it.each(['null','[]','{}','bad','{"x":0,"y":0,"zoom":"1"}','{"x":0,"y":0,"zoom":0}','{"x":1000001,"y":0,"zoom":1}'])("rejects corrupt viewport %s", raw => {
  expect(() => parseCanvasViewport(raw)).toThrow();
});
