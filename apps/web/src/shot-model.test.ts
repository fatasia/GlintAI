// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { addElement, keyframeTimes, moveElement, removeElement, removeKeyframe, setElementAnimated, setElementText, upsertKeyframe } from "./shot-model";

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
});
