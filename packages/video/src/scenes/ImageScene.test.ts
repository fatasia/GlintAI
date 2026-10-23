import { Children, isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Img, useVideoConfig } from "remotion";
import { ImageSceneView } from "./ImageScene";

vi.mock("remotion", async (original) => ({
  ...await original<typeof import("remotion")>(),
  useVideoConfig: vi.fn(),
}));
// Layout-only inspection calls the view directly; resolver/provider behavior is covered separately.
vi.mock("../components/MediaAssetContext", () => ({ useMediaAssetSrc: (src: string) => src }));
const config = vi.mocked(useVideoConfig);
beforeEach(() => config.mockReturnValue({ width: 1920, height: 1080 } as ReturnType<typeof useVideoConfig>));

function layout(caption?: string) {
  const tree = ImageSceneView({ scene: { id: "tiny", kind: "image", src: "assets/checker.png", caption, narration: { text: "Tiny image" } } });
  if (!isValidElement<{ children: React.ReactNode; style: React.CSSProperties }>(tree)) throw new Error("Expected image scene root");
  const rows = Children.toArray(tree.props.children);
  const stage = rows[0];
  if (!isValidElement<{ style: React.CSSProperties; children: React.ReactNode }>(stage)) throw new Error("Expected bounded image stage");
  const image = stage.props.children;
  if (!isValidElement<{ style: React.CSSProperties; alt: string }>(image)) throw new Error("Expected image");
  return { tree, stage, image, rows };
}

describe("image media layout", () => {
  it("uses render-aware Img with explicit bounded width and height for tiny assets", () => {
    const { stage, image } = layout();
    expect(stage.props.style).toMatchObject({ width: "100%", height: 420, flexShrink: 0 });
    expect(image.type).toBe(Img);
    expect(image.props.style).toMatchObject({ width: "100%", height: "100%", maxHeight: "100%", objectFit: "contain", boxSizing: "border-box" });
    expect(image.props.alt).toBeTruthy();
  });
  it.each([[1920, 1080], [1080, 1920], [1080, 1080], [1280, 720]])(
    "keeps image and caption within the available %dx%d stage without flex shrink", (width, height) => {
      config.mockReturnValue({ width, height } as ReturnType<typeof useVideoConfig>);
      const { tree, stage, rows } = layout("Original 2×2 checker texture");
      const caption = rows[1];
      if (!isValidElement<{ style: React.CSSProperties }>(caption)) throw new Error("Expected separate caption row");
      expect(caption.props.style.flexShrink).toBe(0);
      expect(stage.props.style.flexShrink).toBe(0);
      const [top, , bottom] = String(tree.props.style.padding).split(" ").map(parseFloat);
      expect(Number(stage.props.style.height) + 136 + Number(tree.props.style.gap) + top! + bottom!).toBeLessThanOrEqual(height);
      expect(Number(stage.props.style.height)).toBeLessThanOrEqual(height * 420 / 1080);
      expect(tree.props.style.boxSizing).toBe("border-box");
    },
  );
  it("does not render an empty caption row", () => {
    expect(layout().rows).toHaveLength(1);
  });
});
