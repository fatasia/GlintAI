import { Children, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ThreeSceneView } from "./ThreeScene";
vi.mock("remotion", async (original) => ({
  ...await original<typeof import("remotion")>(),
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30 }),
}));
describe("3D capture surface", () => {
  it("preserves the last manual drawing buffer for still capture", () => {
    const tree = ThreeSceneView({
      scene: { id: "cube", kind: "three", model: "gltf", src: "assets/cube.glb", narration: { text: "模型" } },
      colors: { accent: "#567", accent2: "#789", text: "#fff" },
    });
    if (!isValidElement<{ children: React.ReactNode }>(tree)) throw new Error("Expected scene root");
    const canvas = Children.toArray(tree.props.children)[0];
    if (!isValidElement<{ gl: Record<string, unknown> }>(canvas)) throw new Error("Expected ThreeCanvas");
    expect(canvas.props.gl).toMatchObject({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  });
});
