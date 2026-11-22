// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildSubmissionInput, compositeMaskedPixels, dataUrlBytes, libraryAssetName, maskDiffStats, maskIsEmpty, selectedImageSrc } from "./design-mask-edit";

const rgba = (width: number, height: number, fill: (x: number, y: number) => [number, number, number]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fill(x, y), i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width, height };
};
const leftHalf = (width: number, height: number, value: number) => rgba(width, height, x => x < width / 2 ? [value, value, value] : [0, 0, 0]);

describe("compositeMaskedPixels", () => {
  it("keeps outside pixels exactly and blends inside", () => {
    const original = leftHalf(4, 2, 10), generated = leftHalf(4, 2, 200);
    const mask = rgba(4, 2, x => (x === 1 ? [255, 255, 255] : [0, 0, 0]));
    const result = compositeMaskedPixels(original, generated, mask);
    expect(result.data[0]).toBe(10);        // x=0 outside: untouched
    expect(result.data[4]).toBe(200);       // x=1 inside full white mask: candidate
    expect(result.data[8]).toBe(0);         // x=2 outside: untouched (original is 0 here)
    // outside must be byte-exact across the whole image
    for (let i = 0; i < result.data.length; i += 4) {
      const inside = mask.data[i]! >= 8;
      if (!inside) for (let c = 0; c < 3; c++) expect(result.data[i + c]).toBe(original.data[i + c]);
    }
  });
  it("blends partially by mask luminance", () => {
    const solid = rgba(1, 1, () => [10, 10, 10]), edited = rgba(1, 1, () => [110, 110, 110]);
    const half = rgba(1, 1, () => [128, 128, 128]);
    const mixed = compositeMaskedPixels(solid, edited, half);
    expect(Math.abs(mixed.data[0]! - 60)).toBeLessThanOrEqual(1);
  });
  it("keeps sub-threshold antialiased edge pixels byte-exact instead of micro-blending", () => {
    const solid = rgba(1, 1, () => [10, 10, 10]), edited = rgba(1, 1, () => [110, 110, 110]);
    const faint = rgba(1, 1, () => [5, 5, 5]); // below MASK_EDGES (8): counts as outside
    const mixed = compositeMaskedPixels(solid, edited, faint);
    expect([...mixed.data]).toEqual([...solid.data]);
    const stats = maskDiffStats(solid, mixed, faint);
    expect(stats.outsideChangedPixels).toBe(0);
  });
  it("rejects size mismatches", () => {
    expect(() => compositeMaskedPixels(leftHalf(4, 2, 1), leftHalf(2, 2, 1), leftHalf(4, 2, 1))).toThrow(/尺寸/);
    expect(() => compositeMaskedPixels(leftHalf(4, 2, 1), leftHalf(4, 2, 1), leftHalf(2, 2, 1))).toThrow(/掩膜尺寸/);
  });
});

describe("maskDiffStats", () => {
  it("reports exact zero outside and counted changes inside", () => {
    const original = leftHalf(4, 2, 10), after = leftHalf(4, 2, 10);
    after.data[4] = 200; after.data[5] = 200; after.data[6] = 200; // x=1 inside
    const mask = rgba(4, 2, x => (x === 1 || x === 3 ? [255, 255, 255] : [0, 0, 0]));
    const stats = maskDiffStats(original, after, mask);
    expect(stats.outsideChangedPixels).toBe(0);
    expect(stats.maxOutsideDelta).toBe(0);
    expect(stats.insidePixels).toBe(4);
    expect(stats.insideChangedPixels).toBe(1);
    expect(stats.meanInsideDelta).toBe(190);
  });
});

describe("mask helpers", () => {
  it("maskIsEmpty detects empty and painted masks", () => {
    const empty = rgba(2, 2, () => [0, 0, 0]);
    const painted = rgba(2, 2, x => (x === 1 ? [255, 255, 255] : [0, 0, 0]));
    expect(maskIsEmpty(empty)).toBe(true);
    expect(maskIsEmpty(painted)).toBe(false);
  });
  it("dataUrlBytes enforces format and size", () => {
    const onePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(dataUrlBytes(onePixel).length).toBeGreaterThan(0);
    expect(() => dataUrlBytes("data:text/html;base64,PGI+")).toThrow();
    expect(() => dataUrlBytes("https://example.com/a.png")).toThrow();
  });
  it("libraryAssetName only accepts managed paths", () => {
    expect(libraryAssetName("/api/media/assets/abc.png")).toBe("abc.png");
    expect(libraryAssetName("https://example.com/a.png")).toBeNull();
    expect(libraryAssetName("/api/media/assets/../etc/passwd")).toBeNull();
  });
  it("buildSubmissionInput guards prompt, binding and length", () => {
    expect(() => buildSubmissionInput({ bindingId: "b", model: "m", prompt: "  ", referenceImage: "a.png", referenceSha256: "x" })).toThrow(/修改描述/);
    expect(() => buildSubmissionInput({ bindingId: "", model: "m", prompt: "改", referenceImage: "a.png", referenceSha256: "x" })).toThrow(/绑定/);
    const input = buildSubmissionInput({ bindingId: "b", model: "m", prompt: "改成蓝色", referenceImage: "a.png", referenceSha256: "x" });
    expect(input).toEqual({ bindingId: "b", type: "image", model: "m", prompt: "改成蓝色", params: {}, referenceImage: "a.png", referenceSha256: "x" });
  });
  it("selectedImageSrc finds the img of a node or its child", () => {
    const html = `<body><img data-design-id="pic" src="/api/media/assets/a.png"><figure data-design-id="card"><img data-design-id="inner" src="data:image/png;base64,AAA"></figure></body>`;
    expect(selectedImageSrc(html, "pic")).toBe("/api/media/assets/a.png");
    expect(selectedImageSrc(html, "card")).toBe("data:image/png;base64,AAA");
    expect(selectedImageSrc(html, "missing")).toBeNull();
  });
});
