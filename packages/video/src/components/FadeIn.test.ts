import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { FadeIn } from "./FadeIn";
vi.mock("remotion", () => ({
  useCurrentFrame: () => 5, useVideoConfig: () => ({ fps: 24 }), spring: () => .713245,
}));
describe("entrance rasterization", () => {
  it("aligns the translated layer to CSS pixels without quantizing opacity", () => {
    const tree = FadeIn({ children: "content", distance: 30 });
    if (!isValidElement<{ style: React.CSSProperties }>(tree)) throw new Error("Expected fade layer");
    expect(tree.props.style.transform).toBe("translateY(9px)");
    expect(tree.props.style.opacity).toBe(.713245);
  });
});
