import type { ProjectVersion } from "@glintai/scenescript/project-container";
import { isContainerDocument, type UnifiedProjectContainer } from "@glintai/scenescript/project-container-v2";
type ProjectObject = UnifiedProjectContainer["objects"][number];
import { boardPosition } from "./project-board-layout";

export type WorkGraphNode = {
  id: string;
  objectId: string;
  versionId: string;
  kind: ProjectObject["kind"];
  current: boolean;
  editable: boolean;
  title: string;
  digest: string;
  position: { x: number; y: number };
};
export type WorkGraph = {
  nodes: WorkGraphNode[];
  edges: { from: string; to: string }[];
  matched: number;
  currentShown: number;
  omittedReferences: number;
  truncated: boolean;
};
const currentKey = (id: string) => `current:${id}`;
const historyKey = (id: string) => `history:${id}`;
function nodeOf(
  object: ProjectObject,
  version: ProjectVersion,
  current: boolean,
  index: number,
): WorkGraphNode {
  const payload = version.payload;
  const title =
    payload &&
    typeof payload === "object" &&
    "title" in payload &&
    typeof payload.title === "string"
      ? payload.title.slice(0, 120)
      : object.id;
  return {
    id: current ? currentKey(object.id) : historyKey(version.id),
    objectId: object.id,
    versionId: version.id,
    kind: object.kind,
    current,
    title,
    digest: version.contentDigest,
    editable: current && isContainerDocument(object.kind) && !("archived" in object && object.archived),
    position: boardPosition(index),
  };
}

/** Saved-version projection only; no new graph store or engineering writes. */
export function savedWorkGraph(
  container: UnifiedProjectContainer,
  query = "",
  requestedLimit = 200,
): WorkGraph {
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(200, Math.floor(requestedLimit)))
    : 200;
  const versions = new Map(container.versions.map((version) => [version.id, version]));
  const objects = new Map(container.objects.map((object) => [object.id, object]));
  const matches = container.objects.filter((object) => {
    const version = versions.get(object.currentVersionId);
    if (!version) return false;
    const node = nodeOf(object, version, true, 0);
    return `${node.title} ${node.objectId} ${node.kind}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  });
  const nodes = matches
    .slice(0, limit)
    .map((object, index) => nodeOf(object, versions.get(object.currentVersionId)!, true, index));
  const shown = new Set(nodes.map((node) => node.id)),
    edges = new Map<string, { from: string; to: string }>();
  const currentShown = nodes.length;
  let omittedReferences = 0;
  for (const target of nodes.slice()) {
    const version = versions.get(target.versionId)!;
    for (const ref of [...version.sources, ...version.references]) {
      const source = objects.get(ref.objectId),
        sourceVersion = versions.get(ref.versionId);
      if (!source || !sourceVersion) {
        omittedReferences++;
        continue;
      }
      const current = source.currentVersionId === ref.versionId;
      const key = current ? currentKey(source.id) : historyKey(ref.versionId);
      if (!shown.has(key)) {
        if (nodes.length >= limit) {
          omittedReferences++;
          continue;
        }
        nodes.push(nodeOf(source, sourceVersion, current, nodes.length));
        shown.add(key);
      }
      const edge = { from: key, to: target.id };
      edges.set(`${key}>${target.id}`, edge);
    }
  }
  return {
    nodes,
    edges: [...edges.values()],
    matched: matches.length,
    currentShown,
    omittedReferences,
    truncated: matches.length > currentShown || omittedReferences > 0,
  };
}
