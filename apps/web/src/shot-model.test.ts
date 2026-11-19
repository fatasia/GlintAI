// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { addElement, keyframeTimes, moveElement, moveKeyframeByFrame, removeElement, removeKeyframe, setElementAnimated, setElementText, setKeyframeEasing, setRectProperty, upsertKeyframe } from "./shot-model";

const scene = parseProject({
  schemaVersion: 1, id: "shot-model", title: "Shot", aspect: "16:9", knowledgeSources: [],
  scenes: [{
    id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 1000 },
    elements: [{ id: "price", kind: "text", text: "199", x: 0.5, y: 0.5 }],
    tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.2 }, { atMs: 500, value: 0.8 }] }],
  }],
}).scenes[0]!;

describe("shot model", () => {
  it("moves a static axis on the base element and an animated axis at the playhead", () => {
    const moved = moveElement(scene, "price", { x: 0.9, y: 0.3 }, 250);
    expect(moved.elements?.[0]).toMatchObject({ x: 0.5, y: 0.3 });
    expect(keyframeTimes(moved, "price", "x")).toEqual([0, 250, 500]);
    expect(moved.tracks?.find(track => track.property === "x")?.keyframes.find(key => key.atMs === 250)?.value).toBeCloseTo(0.9);
  });
  it("clamps drag positions into the canvas", () => {
    const moved = moveElement(scene, "price", { x: -1, y: 4 });
    expect(moved.elements?.[0]).toMatchObject({ x: 0, y: 1 });
  });
  it("upserts unique sorted keyframes and removes them", () => {
    const added = upsertKeyframe(scene, "price", "opacity", 300, 0.4);
    expect(keyframeTimes(added, "price", "opacity")).toEqual([300]);
    const replaced = upsertKeyframe(added, "price", "opacity", 300, 0.9);
    expect(replaced.tracks?.find(track => track.property === "opacity")?.keyframes).toEqual([{ atMs: 300, value: 0.9 }]);
    expect(keyframeTimes(removeKeyframe(replaced, "price", "opacity", 300), "price", "opacity")).toEqual([]);
  });
  it("edits one position axis without changing the other axis or its animation", () => {
    const animated = upsertKeyframe(scene, "price", "y", 0, 0.3);
    const changedX = setElementAnimated(animated, "price", "x", 250, 0.7);
    expect(changedX.tracks?.find(track => track.property === "y")).toEqual(animated.tracks?.find(track => track.property === "y"));
    expect(changedX.tracks?.find(track => track.property === "x")?.keyframes.find(key => key.atMs === 250)?.value).toBe(0.7);
    const staticX = { ...scene, tracks: [] };
    const changedY = setElementAnimated(staticX, "price", "y", 250, 2);
    expect(changedY.elements?.[0]).toMatchObject({ x: 0.5, y: 1 });
    expect(changedY.tracks).toEqual([]);
    expect(() => setElementAnimated(scene, "ghost", "x", 0, 0.1)).toThrow(/Unknown/);
    expect(() => setElementAnimated(scene, "price", "y", 0, NaN)).toThrow(/finite/);
  });
  it("clamps opacity to 0..1", () => {
    expect(setElementAnimated(scene, "price", "opacity", 0, 5).tracks?.find(track => track.property === "opacity")?.keyframes[0]?.value).toBe(1);
  });
  it("edits text, adds and removes elements with their tracks", () => {
    expect(setElementText(scene, "price", "299").elements?.[0]).toMatchObject({ text: "299" });
    const added = addElement(scene, { id: "logo", kind: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.1, fill: "#ff0000" });
    expect(added.elements).toHaveLength(2);
    const removed = removeElement(added, "price");
    expect(removed.elements?.map(element => element.id)).toEqual(["logo"]);
    expect(removed.tracks).toEqual([]);
  });
  it("rejects unknown elements and duplicate ids", () => {
    expect(() => moveElement(scene, "ghost", { x: 0, y: 0 })).toThrow(/Unknown element/);
    expect(() => addElement(scene, { id: "price", kind: "text", text: "x" })).toThrow(/already exists/);
  });
  it("moves keyframes by project frames without losing value or easing", () => {
    const original = setKeyframeEasing(scene, "price", "x", 500, "ease-in");
    const moved = moveKeyframeByFrame(original, "price", "x", 500, 1, 30, 1000);
    expect(moved.atMs).toBe(533);
    expect(moved.scene.tracks?.[0]?.keyframes[1]).toEqual({ atMs: 533, value: 0.8, easing: "ease-in" });
    expect(original.tracks?.[0]?.keyframes[1]?.atMs).toBe(500);
    expect(moveKeyframeByFrame(moved.scene, "price", "x", 533, -1, 30, 1000).atMs).toBe(500);
    expect(moveKeyframeByFrame(scene, "price", "x", 500, 1, 29.97, 1000).atMs).toBe(534);
  });
  it("rejects absent, out-of-bounds and colliding keyframe moves", () => {
    expect(() => moveKeyframeByFrame(scene, "price", "x", 123, 1, 30, 1000)).toThrow(/没有/);
    expect(() => moveKeyframeByFrame(scene, "price", "x", 0, -1, 30, 1000)).toThrow(/开始之前/);
    expect(() => moveKeyframeByFrame(scene, "price", "x", 500, 1, 30, 500)).toThrow(/结束之后/);
    const collision = upsertKeyframe(scene, "price", "x", 533, 0.7);
    expect(() => moveKeyframeByFrame(collision, "price", "x", 500, 1, 30, 1000)).toThrow(/已有/);
    expect(keyframeTimes(collision, "price", "x")).toEqual([0, 500, 533]);
  });
  it("validates shape properties and sets easing only at existing keyframes", () => {
    const added = addElement(scene, { id: "box", kind: "rect", x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: "#112233" });
    expect(setRectProperty(added, "box", "w", 0.6).elements?.[1]).toMatchObject({ w: 0.6 });
    expect(() => setRectProperty(added, "box", "w", 0)).toThrow();
    expect(() => setRectProperty(added, "box", "fill", "red")).toThrow();
    const eased = setKeyframeEasing(added, "price", "x", 500, "ease-in");
    expect(eased.tracks?.[0]?.keyframes[1]).toMatchObject({ easing: "ease-in" });
    expect(() => setKeyframeEasing(added, "price", "x", 499, "linear")).toThrow();
  });
});
