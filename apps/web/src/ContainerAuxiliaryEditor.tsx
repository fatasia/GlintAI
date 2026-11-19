import { lazy, Suspense, useRef, useState } from "react";
import { parseProject } from "@glintai/scenescript";
import { parseAuxiliaryDocument } from "@glintai/scenescript/project-container-v2";
import type { DesignDocument, ProjectDesignDocuments } from "./design-artifacts";
import type { ProjectDocuments } from "./script-documents";
import {
  auxiliaryEditorState,
  createAuthoringBuffer,
  useContainerDocumentSession,
} from "./container-auxiliary-session";
import { DesignExportPanel } from "./DesignExportPanel";
import { ContainerDocumentStatus } from "./ContainerDocumentStatus";
import { t } from "./ui/i18n";
const ScriptEditor = lazy(() => import("./ScriptEditor"));
const DesignEditor = lazy(() => import("./DesignEditor"));
const PrevizEditor = lazy(() => import("./PrevizDocumentEditor"));
type Props = {
  kind: string;
  initial: unknown;
  active: boolean;
  binding: { projectId: string; objectId: string; onCommitted(): void };
};

function useAuxiliaryEditor(props: Props) {
  const { kind, initial, active, binding } = props;
  const session = useContainerDocumentSession(
    binding,
    (input) => parseAuxiliaryDocument(kind, input),
    parseAuxiliaryDocument(kind, initial),
    active,
  );
  const { view, client, settled } = session;
  const editorId = `${binding.projectId}-${binding.objectId}`;
  const buffer = useRef(
    createAuthoringBuffer(auxiliaryEditorState(editorId, parseAuxiliaryDocument(kind, initial))),
  );
  const [exporting, setExporting] = useState<DesignDocument | null>(null);
  const state = view && auxiliaryEditorState(editorId, view.project);
  // A readback is visible to child CAS reconciliation in this render, before child effects.
  if (settled && state) buffer.current.replace(state);
  // Only a settled readback may advance the child's adoption revision: a conflict
  // reply also bumps the shared revision but never delivers a new document to adopt.
  const readbackRevision = settled && view ? (view.look?.revision ?? 0) + 1 : 0;
  const persistence = {
    storage: buffer.current,
    label: t("containerV2.buffer"),
    history: {
      canUndo: settled && !!view?.look?.undoDepth,
      canRedo: settled && !!view?.look?.redoDepth,
      undo: () => void client.current?.history("undo"),
      redo: () => void client.current?.history("redo"),
    },
  };
  const changed = (next: ProjectDocuments | ProjectDesignDocuments) => {
    if (!view || next.documents.length !== 1 || next.documents[0]!.id !== view.project.id) return;
    client.current?.update(parseAuxiliaryDocument(kind, next.documents[0]));
  };
  return { view, state, editorId, persistence, changed, client, exporting, setExporting, readbackRevision };
}
export default function ContainerAuxiliaryEditor(props: Props) {
  const { view, state, editorId, persistence, changed, client, exporting, setExporting, readbackRevision } =
    useAuxiliaryEditor(props);
  const { kind, active } = props;
  if (!view || !state) return <p role="status">{t("container.loading")}</p>;
  return (
    <>
      <ContainerDocumentStatus view={view} client={client} />
      <fieldset
        className="workspace-editor"
        disabled={
          view.status === "opening" || view.status === "error" || view.status === "conflict"
        }
      >
        <Suspense fallback={<p role="status">{t("container.loading")}</p>}>
          <TextDesignSurface
            kind={kind}
            editorId={editorId}
            view={view}
            state={state}
            active={active}
            persistence={persistence}
            changed={changed}
            readbackRevision={readbackRevision}
            onExport={setExporting}
          />
          {kind === "previz-document" && (
            <PrevizEditor
              document={view.project as import("../../../packages/previz/src/index").PrevizDocument}
              active={active}
              onChange={(next) => client.current?.update(next)}
            />
          )}
        </Suspense>
      </fieldset>
      {exporting && <DesignExportPanel document={exporting} onClose={() => setExporting(null)} />}
    </>
  );
}

type SurfaceProps = {
  kind: string;
  editorId: string;
  view: import("./session-client").SessionView<
    import("./container-auxiliary-session").AuxiliaryDocument
  >;
  state: ReturnType<typeof auxiliaryEditorState>;
  active: boolean;
  persistence: import("./authoring-persistence").AuthoringPersistence;
  changed(next: ProjectDocuments | ProjectDesignDocuments): void;
  onExport(document: DesignDocument): void;
};
function TextDesignSurface({
  kind,
  editorId,
  view,
  state,
  active,
  persistence,
  changed,
  readbackRevision,
  onExport,
}: SurfaceProps & { readbackRevision: number }) {
  return (
    <>
      {kind === "script-document" && (
        <ScriptEditor
          project={editorShell(editorId, view.project.title)}
          active={active}
          persistence={persistence}
          externalState={state as ProjectDocuments}
          revision={readbackRevision}
          onDocumentsChange={changed}
        />
      )}
      {kind === "design-document" && (
        <DesignEditor
          projectId={editorId}
          persistence={persistence}
          externalState={state as ProjectDesignDocuments}
          revision={readbackRevision}
          onDocumentsChange={changed}
          onExport={(context) => onExport(context.document)}
        />
      )}
    </>
  );
}
function editorShell(id: string, title: string) {
  return parseProject({
    schemaVersion: 1,
    id,
    title,
    aspect: "16:9",
    knowledgeSources: [],
    scenes: [{ id: "document", kind: "title", title, narration: { text: title } }],
  });
}
