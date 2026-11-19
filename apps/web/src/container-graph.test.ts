import { expect, it } from "vitest";
import type { ProjectContainer } from "@glintai/scenescript/project-container";
import { savedWorkGraph } from "./container-graph";

function fixture(): ProjectContainer {
  const make = (id: string, objectId: string, title: string) => ({
    id,
    objectId,
    payload: { title },
    contentDigest: "a".repeat(64),
    actor: "user",
    transactionId: "test",
    sources: [],
    references: [],
  });
  return {
    format: "glint-project",
    version: 1,
    id: "work-graph",
    objects: [
      { id: "scene", kind: "scene-document", currentVersionId: "scene-v1" },
      { id: "timeline", kind: "timeline-document", currentVersionId: "timeline-v1" },
      { id: "generated", kind: "generation-result", currentVersionId: "generated-v2" },
      { id: "asset", kind: "asset", currentVersionId: "asset-v1" },
    ],
    versions: [
      {
        ...make("scene-v1", "scene", "中文分镜"),
        sources: [{ objectId: "generated", versionId: "generated-v1" }],
      },
      make("timeline-v1", "timeline", "精剪时间线"),
      make("generated-v1", "generated", "旧生成结果"),
      make("generated-v2", "generated", "新生成结果"),
      make("asset-v1", "asset", "素材元数据"),
    ],
  };
}
it("distinguishes pinned historical sources from the object's current result", () => {
  const graph = savedWorkGraph(fixture());
  expect(graph.nodes).toHaveLength(5);
  expect(graph.edges).toEqual([{ from: "history:generated-v1", to: "current:scene" }]);
  expect(graph.nodes.find((node) => node.id === "history:generated-v1")).toMatchObject({
    current: false,
    editable: false,
  });
  expect(graph.nodes.filter((node) => node.editable).map((node) => node.objectId)).toEqual([
    "scene",
    "timeline",
  ]);
});
it("searches saved titles and object IDs without losing the exact referenced version", () => {
  const graph = savedWorkGraph(fixture(), "中文");
  expect(graph.matched).toBe(1);
  expect(graph.currentShown).toBe(1);
  expect(graph.nodes.map((node) => node.id)).toEqual(["current:scene", "history:generated-v1"]);
  expect(savedWorkGraph(fixture(), "TIMELINE").nodes[0]?.objectId).toBe("timeline");
  expect(savedWorkGraph(fixture(), "not-present").nodes).toEqual([]);
});
it("deduplicates source/reference edges and never changes the supplied work", () => {
  const work = fixture();
  work.versions[0]!.references = [...work.versions[0]!.sources];
  const before = JSON.stringify(work),
    graph = savedWorkGraph(work);
  expect(graph.edges).toHaveLength(1);
  expect(JSON.stringify(work)).toBe(before);
});
it("bounds nodes and reports omitted references instead of redirecting edges", () => {
  const graph = savedWorkGraph(fixture(), "", 1);
  expect(graph.nodes).toHaveLength(1);
  expect(graph.edges).toEqual([]);
  expect(graph.truncated).toBe(true);
  expect(graph.omittedReferences).toBe(1);
  expect(savedWorkGraph(fixture(), "", NaN).nodes).toHaveLength(5);
});
it("enforces the 200-node ceiling on large containers", () => {
  const work = fixture();
  work.objects = Array.from({ length: 250 }, (_, n) => ({
    id: `doc-${n}`,
    kind: "scene-document",
    currentVersionId: "scene-v1",
  }));
  const graph = savedWorkGraph(work, "", 10000);
  expect(graph.nodes.length).toBeLessThanOrEqual(200);
  expect(graph.truncated).toBe(true);
});
it("does not expose edit actions for unverified assets or missing versions", () => {
  const work = fixture();
  work.versions = work.versions.filter((version) => version.id !== "timeline-v1");
  const graph = savedWorkGraph(work);
  expect(graph.nodes.some((node) => node.objectId === "timeline")).toBe(false);
  expect(graph.nodes.find((node) => node.objectId === "asset")?.editable).toBe(false);
});
