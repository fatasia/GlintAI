import { createPrevizDocument } from "../../../packages/previz/src/index";
import { parseNleProject, parseProject } from "@glintai/scenescript";
import {
  type ContainerDocumentKind,
  parseUnifiedContainer,
} from "@glintai/scenescript/project-container-v2";
import { projectContentDigest } from "@glintai/scenescript/project-container";
import { createDesignDocument } from "./design-editor-seeds";
import { t } from "./ui/i18n";

export function createContainerDocumentPayload(kind: ContainerDocumentKind, title: string) {
  const id = `doc-${crypto.randomUUID()}`;
  if (kind === "scene-document")
    return parseProject({
      schemaVersion: 1,
      id,
      title,
      aspect: "16:9",
      knowledgeSources: [],
      scenes: [
        { id: "opening", kind: "title", title, narration: { text: title, durationMs: 2000 } },
      ],
    });
  if (kind === "timeline-document")
    return parseNleProject({
      schemaVersion: 1,
      id,
      title,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [],
    });
  if (kind === "script-document")
    return { id, title, kind: "script" as const, content: "", updatedAt: Date.now() };
  if (kind === "design-document") return { ...createDesignDocument("slides", title), id };
  return createPrevizDocument(id, title);
}
export async function createUnifiedProject(kind: ContainerDocumentKind, title: string) {
  const projectId = `work-${crypto.randomUUID()}`,
    objectId = `document-${crypto.randomUUID()}`,
    versionId = `version-${crypto.randomUUID()}`;
  const payload = createContainerDocumentPayload(kind, title || t(`containerV2.${kind}`));
  return parseUnifiedContainer({
    format: "glint-project",
    version: 2,
    id: projectId,
    objects: [{ id: objectId, kind, currentVersionId: versionId, archived: false }],
    versions: [
      {
        id: versionId,
        objectId,
        payload,
        contentDigest: await projectContentDigest(payload),
        actor: "user",
        transactionId: `create-${crypto.randomUUID()}`,
        sources: [],
        references: [],
      },
    ],
  });
}
