// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { expansionPlacement, makeExpansionReference, verifyExpansionSize } from "./gateway-expand";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("centres the original proportionally and leaves room on all sides", () => {
  for (const size of ["1536x864", "864x1536"] as const) {
    const result = expansionPlacement(1200, 800, size);
    expect(result.imageWidth / result.imageHeight).toBeCloseTo(1.5);
    expect(result.x).toBeGreaterThan(0); expect(result.y).toBeGreaterThan(0);
    expect(result.x + result.imageWidth).toBeLessThan(result.width);
    expect(result.y + result.imageHeight).toBeLessThan(result.height);
  }
  expect(() => expansionPlacement(10000, 10000, "1536x864")).toThrow();
});

it("draws the source into a separate bounded reference canvas", async () => {
  const drawImage = vi.fn(), fillRect = vi.fn(), close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1200, height: 800, close })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect, drawImage, fillStyle: "" } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["png"], { type: "image/png" })));
  const blob = await makeExpansionReference(new Blob(["original"], { type: "image/jpeg" }), "1536x864");
  expect(blob.type).toBe("image/png"); expect(drawImage).toHaveBeenCalledOnce(); expect(fillRect).toHaveBeenCalledWith(0, 0, 1536, 864); expect(close).toHaveBeenCalledOnce();
});

it("reports mismatch instead of claiming a requested size", async () => {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1024, height: 1024, close: vi.fn() })));
  await expect(verifyExpansionSize(new Blob(["image"], { type: "image/png" }), "1536x864")).rejects.toThrow("不一致");
});
