import { lazy, Suspense, useMemo, useState } from "react";
import { parseProject } from "@glintai/scenescript";
import {
  isContainerDocument,
  type ContainerDocumentKind,
} from "@glintai/scenescript/project-container-v2";
import type { ContainerSnapshot } from "./container-workspace-client";
import { createContainerDocumentPayload } from "./container-document-seeds";
import { useContainerActions } from "./useContainerActions";
import { ContainerDocumentForm } from "./ContainerDocumentForm";
import { ContainerPlanPreview } from "./ContainerPlanPreview";
import { ContainerScene } from "./ContainerScene";
import { ContainerExport } from "./ContainerExport";
import { AuthoringVisibility } from "./authoring-visibility";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./container-v2.css";
const NleEditor = lazy(() =>
  import("./NleEditor").then((module) => ({ default: module.NleEditor })),
);
const AuxiliaryEditor = lazy(() => import("./ContainerAuxiliaryEditor"));
const ContainerGraph = lazy(() => import("./ContainerGraph"));
type Props = {
  snapshot: ContainerSnapshot;
  objectId?: string;
  active: boolean;
  onOpen(projectId: string, objectId?: string): void;
  onCommitted(): void;
};
type Actions = ReturnType<typeof useContainerActions>;

function useWorkspaceV2(props: Props) {
  const { snapshot, objectId, onOpen, onCommitted } = props;
  const { container, look } = snapshot;
  const actions = useContainerActions({ onCommitted, onOpen });
  const documents = container.objects.filter((item) => isContainerDocument(item.kind));
  const activeDocuments = documents.filter((item) => !("archived" in item && item.archived));
  const selected = objectId
    ? activeDocuments.find((item) => item.id === objectId)
    : activeDocuments[0];
  const version = container.versions.find((item) => item.id === selected?.currentVersionId);
  const binding = useMemo(
    () =>
      selected && {
        projectId: container.id,
        objectId: selected.id,
        onCommitted,
        onStatus: ({ busy, revision }: { busy: boolean; revision: number }) => {
          if (!busy && revision > look.revision) onCommitted();
        },
      },
    [container.id, selected?.id, look.revision],
  );
  const { lifecycle, add, history } = workspaceMutations(actions, container.id, look.revision);
  return {
    ...props,
    actions,
    activeDocuments,
    documents,
    selected,
    version,
    binding,
    lifecycle,
    add,
    history,
  };
}
type Workspace = ReturnType<typeof useWorkspaceV2>;
function DocumentLifecycle({ model }: { model: Workspace }) {
  const [confirmed, setConfirmed] = useState(false);
  const { selected, version, actions, lifecycle, documents, activeDocuments } = model;
  const archived = documents.filter((item) => "archived" in item && item.archived);
  const frozen = !!(version?.payload as { frozen?: boolean })?.frozen;
  return (
    <details className="container-document-tools">
      <summary>{t("containerV2.add")}</summary>
      {selected && (
        <ContainerPlanPreview
          projectId={model.snapshot.container.id}
          intent={{ objectIds: [selected.id] }}
        />
      )}
      <ContainerDocumentForm
        busy={actions.pending}
        label="containerV2.add"
        onSubmit={(kind, title) => void model.add(kind, title)}
      />
      <p className="ws-note">{t("containerV2.archiveHint")}</p>
      {selected && (
        <div className="ws-actions">
          <label className="tool-check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={actions.pending || frozen || activeDocuments.length < 2}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {t("containerV2.confirmArchive")}
          </label>
          <Button
            disabled={!confirmed || actions.pending || frozen || activeDocuments.length < 2}
            onClick={() => {
              void lifecycle("archive", selected.id);
              setConfirmed(false);
            }}
          >
            {t("containerV2.archive")}
          </Button>
        </div>
      )}
      {!!archived.length && (
        <section aria-label={t("containerV2.archived")}>
          <h3>{t("containerV2.archived")}</h3>
          {archived.map((item) => (
            <div className="ws-actions" key={item.id}>
              <code>{item.id}</code>
              <Button disabled={actions.pending} onClick={() => void lifecycle("restore", item.id)}>
                {t("containerV2.restore")}
              </Button>
            </div>
          ))}
        </section>
      )}
    </details>
  );
}
export function ContainerActionStatus({ actions }: { actions: Actions }) {
  return (
    <>
      {actions.error && <p role="alert">{actions.error}</p>}
      {actions.pending && !actions.busy && (
        <div className="ws-actions">
          <p role="status">{t("containerV2.pending")}</p>
          <Button onClick={() => void actions.retry()}>{t("container.retry")}</Button>
        </div>
      )}
    </>
  );
}
function DocumentContent({ model }: { model: Workspace }) {
  const { selected, version, binding, active } = model;
  if (!selected || !version || !binding) return <p role="status">{t("containerV2.unknown")}</p>;
  return (
    <AuthoringVisibility active={active}>
      <Suspense fallback={<p role="status">{t("container.loading")}</p>}>
        {selected.kind === "scene-document" ? (
          <ContainerScene
            key={binding.objectId}
            binding={binding}
            initial={parseProject(version.payload)}
            active={active}
          />
        ) : selected.kind === "timeline-document" ? (
          <NleEditor key={binding.objectId} shared={binding} active={active} />
        ) : (
          <AuxiliaryEditor
            key={binding.objectId}
            kind={selected.kind}
            initial={version.payload}
            binding={binding}
            active={active}
          />
        )}
      </Suspense>
    </AuthoringVisibility>
  );
}
export default function ContainerWorkspaceV2(props: Props) {
  const model = useWorkspaceV2(props),
    { container, look } = props.snapshot;
  return (
    <section className="workspace-page container-workspace-v2" aria-label={t("containerV2.title")}>
      <header className="workspace-bar">
        <div>
          <h1 className="workspace-bar-title">{t("containerV2.title")}</h1>
          <p className="ws-note">{t("containerV2.version", { revision: look.revision })}</p>
        </div>
        <div className="ws-actions">
          <Button
            disabled={model.actions.pending || !look.undoDepth}
            onClick={() => void model.history("undo")}
          >
            {t("containerV2.undo")}
          </Button>
          <Button
            disabled={model.actions.pending || !look.redoDepth}
            onClick={() => void model.history("redo")}
          >
            {t("containerV2.redo")}
          </Button>
        </div>
      </header>
      <p className="ws-note">{t("containerV2.summary")}</p>
      <a className="g-link" href="#/c">
        {t("containerV2.back")}
      </a>
      <ContainerActionStatus actions={model.actions} />
      <nav className="container-document-tabs" aria-label={t("container.document")}>
        {model.activeDocuments.map((item) => (
          <Button
            key={item.id}
            aria-pressed={item.id === model.selected?.id}
            disabled={model.actions.pending}
            onClick={() => props.onOpen(container.id, item.id)}
          >
            {t(`containerV2.${item.kind as ContainerDocumentKind}`)} ·{" "}
            {
              (
                container.versions.find((version) => version.id === item.currentVersionId)
                  ?.payload as { title?: string }
              )?.title
            }
          </Button>
        ))}
      </nav>
      <DocumentLifecycle key={model.selected?.id} model={model} />
      <DocumentContent model={model} />
      <details className="container-document-tools">
        <summary>{t("workGraph.title")}</summary>
        <Suspense fallback={null}>
          <ContainerGraph container={container} onOpen={(id) => props.onOpen(container.id, id)} />
        </Suspense>
      </details>
      <ContainerExport projectId={container.id} />
    </section>
  );
}

function workspaceMutations(actions: Actions, projectId: string, revision: number) {
  const transaction = () => ({
    id: `workbench-${crypto.randomUUID()}`,
    baseRevision: revision,
    actor: "user",
    scope: {},
    intent: "Workspace document operation",
  });
  const lifecycle = (action: "archive" | "restore", id: string) =>
    actions.submit("lifecycle", {
      projectId: projectId,
      transaction: transaction(),
      change: { action, objectId: id },
    });
  const add = (kind: ContainerDocumentKind, title: string) => {
    const objectId = `document-${crypto.randomUUID()}`;
    return actions.submit(
      "lifecycle",
      {
        projectId: projectId,
        transaction: transaction(),
        change: {
          action: "add",
          objectId,
          versionId: `version-${crypto.randomUUID()}`,
          kind,
          payload: createContainerDocumentPayload(kind, title),
        },
      },
      objectId,
    );
  };
  const history = (action: "undo" | "redo") =>
    actions.submit(action, {
      projectId: projectId,
      transactionId: transaction().id,
      baseRevision: revision,
      actor: "user",
    });
  return { lifecycle, add, history };
}
