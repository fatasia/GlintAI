import { lazy } from "react";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { useContainerDocumentSession } from "./container-auxiliary-session";
import { ContainerDocumentStatus } from "./ContainerDocumentStatus";
import { t } from "./ui/i18n";
const SceneEditor = lazy(() =>
  import("./SceneEditor").then((module) => ({ default: module.SceneEditor })),
);
type Props = {
  binding: { projectId: string; objectId: string; onCommitted(): void };
  initial: SceneScriptProject;
  active: boolean;
};
export function ContainerScene({ binding, initial, active }: Props) {
  const { view, client, settled } = useContainerDocumentSession(
    binding,
    parseProject,
    initial,
    active,
  );
  if (!view) return <p role="status">{t("container.loading")}</p>;
  return (
    <>
      <ContainerDocumentStatus view={view} client={client} />
      <fieldset
        className="workspace-editor"
        disabled={
          view.project.frozen === true || ["opening", "conflict", "error"].includes(view.status)
        }
      >
        <SceneEditor
          project={view.project}
          documentOnly
          onChange={(project, actor) => client.current?.update(project, { actor })}
          canApproveCharacter={false}
          canApproveProduct={false}
          history={{
            undoDepth: settled ? (view.look?.undoDepth ?? 0) : 0,
            redoDepth: settled ? (view.look?.redoDepth ?? 0) : 0,
            undo: () => void client.current?.history("undo"),
            redo: () => void client.current?.history("redo"),
          }}
        />
      </fieldset>
    </>
  );
}
