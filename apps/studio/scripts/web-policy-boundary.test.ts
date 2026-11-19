// @ts-expect-error JavaScript server module exercised from the studio harness.
import { validateMakeInput } from "../../web/server/jobs.mjs";
import { describe, expect, it } from "vitest";

// MOTION-10: the Web tier stays a closed boundary for html/three scenes
// (ADR-014). The rejection must survive independently of the server's own test
// suite. The CLI pointer is returned before entering the shared renderer.
// Everything else — notably chart scenes — must keep flowing so the boundary stays narrow.
const base = { schemaVersion: 1, id: "boundary", title: "边界", aspect: "16:9", knowledgeSources: [], scenes: [] };
const sceneProject = (scene: Record<string, unknown>) => ({ project: { ...base, scenes: [scene] } });
const narration = { text: "边界场景" };

describe("web make boundary rejects executable scene kinds (MOTION-10 / ADR-014)", () => {
  it("rejects html scenes", () => {
    const result = validateMakeInput(sceneProject({ id: "a", kind: "html", html: "<p>x</p>", animation: "gsap", narration }));
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("glint render");
    expect(result.project).toBeUndefined();
  });
  it("rejects three scenes", () => {
    const result = validateMakeInput(sceneProject({ id: "b", kind: "three", model: "icosahedron", narration }));
    expect(result.error).toBeTruthy();
    expect(result.project).toBeUndefined();
  });
  it("rejects three gltf scenes", () => {
    const result = validateMakeInput(sceneProject({ id: "c", kind: "three", model: "gltf", src: "assets/models/cube.glb", narration }));
    expect(result.error).toBeTruthy();
    expect(result.project).toBeUndefined();
  });
  it("keeps chart scenes inside the boundary", () => {
    const result = validateMakeInput(sceneProject({ id: "d", kind: "chart", chartType: "bar", narration, data: [{ label: "1月", value: 12 }] }));
    expect(result.error).toBeUndefined();
    expect(result.project).toBeTruthy();
  });
});
