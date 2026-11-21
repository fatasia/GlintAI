import { describe, expect, it } from "vitest";
import { parsePlanPreviewIntent, PlanPreviewError, previewContainerPlan } from "./project-plan-preview";

const sceneProject = (scenes: unknown[]) => ({ schemaVersion: 1, id: "proj", title: "作品", aspect: "16:9", knowledgeSources: [], scenes });
const titleScene = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: "title", title: id, narration: { text: "讲解", durationMs: 1000 }, ...extra });
const aigcScene = (id: string) => ({ id, kind: "image", title: id, src: "assets/gen.png", narration: { text: "讲解", durationMs: 1000 }, provenance: { origin: "generated", source: "assets/gen.png" } });
const nleProject = (clips: unknown[]) => ({ schemaVersion: 1, id: "nle", title: "剪辑", fps: 30, width: 1920, height: 1080, tracks: [{ id: "track", kind: "text", name: "字幕", clips }] });
const textClip = (id: string, startMs: number, durationMs: number) => ({ id, kind: "text", startMs, durationMs, text: "字幕" });

function snapshot(overrides: Partial<{ objects: unknown[]; versions: unknown[] }> = {}) {
  return {
    projectId: "work",
    revision: 7,
    document: {
      objects: overrides.objects ?? [
        { id: "doc-scene", kind: "scene-document", currentVersionId: "v1" },
        { id: "doc-timeline", kind: "timeline-document", currentVersionId: "tv1" },
      ],
      versions: overrides.versions ?? [
        { id: "v1", objectId: "doc-scene", payload: sceneProject([titleScene("s1"), aigcScene("s2")]) },
        { id: "tv1", objectId: "doc-timeline", payload: nleProject([textClip("c1", 0, 1500)]) },
      ],
    },
  };
}

describe("parsePlanPreviewIntent", () => {
  it("accepts an absent intent and strict object/scene id lists", () => {
    expect(parsePlanPreviewIntent(undefined)).toEqual({});
    expect(parsePlanPreviewIntent({ objectIds: ["doc-scene"], sceneIds: ["s1"] })).toEqual({ objectIds: ["doc-scene"], sceneIds: ["s1"] });
  });

  it("refuses unknown fields, empty or oversized lists and malformed ids", () => {
    expect(() => parsePlanPreviewIntent({ extra: 1 })).toThrow(PlanPreviewError);
    expect(() => parsePlanPreviewIntent({ objectIds: [] })).toThrow(/1\.\.100/);
    expect(() => parsePlanPreviewIntent({})).toThrow(/意图为空/);
    expect(() => parsePlanPreviewIntent({ sceneIds: [""] })).toThrow(/非法 id/);
    expect(() => parsePlanPreviewIntent({ sceneIds: ["x".repeat(201)] })).toThrow(/非法 id/);
    expect(() => parsePlanPreviewIntent("all")).toThrow(/意图必须是对象/);
    expect(() => parsePlanPreviewIntent({ sceneIds: Array.from({ length: 101 }, (_, i) => `s${i}`) })).toThrow(/1\.\.100/);
  });
});

describe("previewContainerPlan", () => {
  it("without intent predicts the whole graph: scenes, audio mix and container, with nonzero time and zero cost", () => {
    const reply = previewContainerPlan(snapshot(), {});
    expect(reply.version).toBe(1);
    expect(reply.scope).toBe("all");
    expect(reply.impact.totalNodes).toBe(4);
    expect(reply.impact.predicted).toEqual(["scene:s1", "scene:s2", "audio:mix", "container"]);
    expect(reply.impact.reusedCount).toBe(0);
    expect(reply.impact.estimatedMs).toBeGreaterThan(0);
    expect(reply.impact.costCny).toBe(0);
    expect(reply.impact.costType).toBe("quote-required");
    expect(reply.impact.quoteRequired).toEqual([{ nodeId: "scene:s2", sceneId: "s2" }]);
    expect(reply.impact.affectedObjects).toEqual(["doc-scene"]);
    expect(reply.timelineExports).toEqual([{ objectId: "doc-timeline", clips: 1, durationMs: 1500 }]);
  });

  it("with a scene intent predicts only the forced closure and reuses the rest", () => {
    const reply = previewContainerPlan(snapshot(), { sceneIds: ["s1"] });
    expect(reply.scope).toBe("intent");
    expect(reply.impact.predicted).toEqual(["scene:s1", "audio:mix", "container"]);
    expect(reply.impact.reusedCount).toBe(1);
    expect(reply.impact.totalNodes).toBe(4);
  });

  it("maps document intents onto their scene nodes and reports timeline intents as unmapped", () => {
    const scenes = previewContainerPlan(snapshot(), { objectIds: ["doc-scene"] });
    expect(scenes.impact.predicted).toHaveLength(4);
    expect(scenes.unmappedIntents).toEqual([]);
    const timeline = previewContainerPlan(snapshot(), { objectIds: ["doc-timeline"] });
    expect(timeline.impact.predicted).toEqual([]);
    expect(timeline.unmappedIntents).toEqual(["doc-timeline"]);
    expect(timeline.notes.some(note => note.includes("剪辑文档"))).toBe(true);
    expect(timeline.timelineExports).toHaveLength(1);
  });

  it("treats local-only scenes as free and never lists them as quote-required", () => {
    const local = snapshot({ versions: [{ id: "v1", objectId: "doc-scene", payload: sceneProject([titleScene("s1")]) }] });
    const reply = previewContainerPlan(local, {});
    expect(reply.impact.costType).toBe("local-free");
    expect(reply.impact.quoteRequired).toEqual([]);
  });

  it("returns a zero-node impact for a container without scene documents", () => {
    const empty = snapshot({
      objects: [{ id: "doc-timeline", kind: "timeline-document", currentVersionId: "tv1" }],
      versions: [{ id: "tv1", objectId: "doc-timeline", payload: nleProject([]) }],
    });
    const reply = previewContainerPlan(empty, {});
    expect(reply.impact.totalNodes).toBe(0);
    expect(reply.impact.predicted).toEqual([]);
    expect(reply.impact.estimatedMs).toBe(0);
    expect(reply.notes.some(note => note.includes("没有可预测的分镜节点"))).toBe(true);
    expect(reply.timelineExports).toEqual([{ objectId: "doc-timeline", clips: 0, durationMs: 100 }]);
  });

  it("refuses intents pointing at unknown, archived documents or unknown scenes", () => {
    expect(() => previewContainerPlan(snapshot(), { objectIds: ["ghost"] })).toThrow(/不存在或已归档/);
    expect(() => previewContainerPlan(snapshot(), { sceneIds: ["ghost"] })).toThrow(/不存在的镜头/);
    const archived = snapshot({
      objects: [{ id: "doc-scene", kind: "scene-document", currentVersionId: "v1", archived: true }],
    });
    expect(() => previewContainerPlan(archived, { objectIds: ["doc-scene"] })).toThrow(/不存在或已归档/);
  });

  it("skips unparseable scene payloads with a note instead of failing the whole preview", () => {
    const broken = snapshot({ versions: [{ id: "v1", objectId: "doc-scene", payload: { scenes: "nope" } }] });
    const reply = previewContainerPlan(broken, {});
    expect(reply.impact.totalNodes).toBe(0);
    expect(reply.notes.some(note => note.includes("无法解析"))).toBe(true);
  });

  it("is deterministic: two identical calls produce identical predictions", () => {
    expect(previewContainerPlan(snapshot(), { sceneIds: ["s1"] })).toEqual(previewContainerPlan(snapshot(), { sceneIds: ["s1"] }));
  });

  it("estimates time on the CLI basis (18ms per second of scene, plus mix and container)", () => {
    const reply = previewContainerPlan(snapshot({ versions: [{ id: "v1", objectId: "doc-scene", payload: sceneProject([titleScene("s1")]) }] }), {});
    // 1s scene → 18ms, audio 400ms, container 300ms.
    expect(reply.impact.estimatedMs).toBe(718);
  });
});
