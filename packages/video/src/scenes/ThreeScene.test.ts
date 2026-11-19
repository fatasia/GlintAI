import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Scene, type ThreeScene as ThreeSceneType } from "@glintai/scenescript";
import { fittedCameraDistance } from "./gltf";
import { GltfModel } from "./GltfModel";
import { ThreeSceneView } from "./ThreeScene";
vi.mock("remotion", async (original) => ({
  ...await original<typeof import("remotion")>(),
  useCurrentFrame: () => 0,
  useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30 }),
}));
// The frame is a pure function of t, so MOTION-04's mixing contract is asserted
// structurally: the 3D canvas and the 2D caption must be siblings in this exact
// order, and the camera must expose the model-dependent framing.
const colors = { accent: "#567", accent2: "#789", text: "#fff" };
const narration = { text: "三维场景" };
const find = (node: ReactNode, type: unknown): ReactElement | null => {
  const elements = Children.toArray(node).filter(isValidElement);
  for (const element of elements) {
    if (element.type === type) return element;
    const nested = find((element.props as { children?: ReactNode }).children as ReactNode, type);
    if (nested) return nested;
  }
  return null;
};
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  const elements = Children.toArray(node).filter(isValidElement);
  return elements.map((element) => textOf((element.props as { children?: ReactNode }).children as ReactNode)).join("");
};
describe("three scene contract (MOTION-04)", () => {
  it("parses primitive and gltf variants and keeps the discriminated src rule", () => {
    expect((Scene.parse({ id: "s1", kind: "three", model: "icosahedron", narration }) as ThreeSceneType).model).toBe("icosahedron");
    expect((Scene.parse({ id: "s2", kind: "three", model: "gltf", src: "assets/models/cube.glb", narration }) as ThreeSceneType & { src: string }).src).toBe("assets/models/cube.glb");
    expect(() => Scene.parse({ id: "s3", kind: "three", model: "gltf", narration })).toThrow();
    expect(() => Scene.parse({ id: "s4", kind: "three", model: "gltf", src: "assets/model.fbx", narration })).toThrow();
    expect(() => Scene.parse({ id: "s5", kind: "three", model: "teapot", narration })).toThrow();
    expect(Scene.parse({ id: "s6", kind: "three", model: "gltf", src: "assets/model.glb", animationClip: "Turn", morphTargets: { Smile: 0.4 }, narration })).toMatchObject({ animationClip: "Turn", morphTargets: { Smile: 0.4 } });
    expect(() => Scene.parse({ id: "s7", kind: "three", model: "gltf", src: "assets/model.glb", morphTargets: { Smile: 1.1 }, narration })).toThrow();
    expect(() => Scene.parse({ id: "s8", kind: "three", model: "gltf", src: "assets/model.glb", morphTargets: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`m${i}`, 0.5])), narration })).toThrow();
  });
});
describe("2D/3D mixing composition", () => {
  it("keeps the 2D caption as a sibling layered after the 3D canvas", () => {
    const tree = ThreeSceneView({ scene: { id: "mix", kind: "three", model: "sphere", caption: "混合字幕", narration }, colors });
    if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected scene root");
    const layers = Children.toArray(tree.props.children).filter(isValidElement);
    expect(layers).toHaveLength(2);
    const canvas = layers[0]!, caption = layers[1]!;
    if (!isValidElement<{ children: ReactNode }>(caption)) throw new Error("Expected caption element");
    expect(textOf(caption.props.children as ReactNode)).toContain("混合字幕");
    if (!isValidElement<{ camera: { position: number[]; fov: number }; gl: Record<string, unknown>; children: ReactNode }>(canvas)) throw new Error("Expected ThreeCanvas");
    expect(canvas.props.camera).toMatchObject({ position: [0, 0, 5.6], fov: 40 });
    expect(canvas.props.gl).toMatchObject({ preserveDrawingBuffer: true });
    expect(find(canvas.props.children, "span")).toBeNull();
  });
  it("routes gltf models through the skeletal mixer path with fitted framing", () => {
    const tree = ThreeSceneView({ scene: { id: "g", kind: "three", model: "gltf", src: "assets/models/cube.glb", animationClip: "Turn", morphTargets: { Smile: 0.5 }, narration }, colors });
    if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected scene root");
    const canvas = Children.toArray(tree.props.children).filter(isValidElement)[0]!;
    if (!isValidElement<{ camera: { position: number[] }; children: ReactNode }>(canvas)) throw new Error("Expected ThreeCanvas");
    expect(canvas.props.camera.position[2]).toBeCloseTo(fittedCameraDistance(1920 / 1080), 6);
    const model = find(canvas.props.children, GltfModel);
    expect(model?.props).toMatchObject({ src: "assets/models/cube.glb", frame: 0, fps: 30, animationClip: "Turn", morphTargets: { Smile: 0.5 } });
  });
  it("stays caption-free when the scene declares no caption", () => {
    const tree = ThreeSceneView({ scene: { id: "bare", kind: "three", model: "torus-knot", narration }, colors });
    if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected scene root");
    expect(Children.toArray(tree.props.children).filter(isValidElement)).toHaveLength(1);
  });
});
describe("safety boundary surfaces", () => {
  it("keeps capture dependent on the preserved buffer, not a repaint race", () => {
    const scene: ThreeSceneType = { id: "cube", kind: "three", model: "gltf", src: "assets/cube.glb", narration };
    const tree = ThreeSceneView({ scene, colors });
    if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected scene root");
    const canvas = Children.toArray(tree.props.children).filter(isValidElement)[0]!;
    if (!isValidElement<{ gl: Record<string, unknown> }>(canvas)) throw new Error("Expected ThreeCanvas");
    expect(canvas.props.gl).toMatchObject({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  });
});
