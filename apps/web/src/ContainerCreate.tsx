import { useRef, useState } from "react";
import { createUnifiedProject } from "./container-document-seeds";
import { ContainerDocumentForm } from "./ContainerDocumentForm";
import { ContainerActionStatus } from "./ContainerWorkspaceV2";
import { useContainerActions } from "./useContainerActions";
import "./container-v2.css";
type Props = { onOpen(projectId: string, objectId?: string): void };
export function ContainerCreate({ onOpen }: Props) {
  const actions = useContainerActions({ onCommitted() {}, onOpen });
  const preparing = useRef(false), [error, setError] = useState("");
  return (
    <section className="ws-group">
      <ContainerDocumentForm
        busy={actions.pending}
        label="containerV2.new"
        onSubmit={async (kind, title) => {
          if (preparing.current) return;
          preparing.current = true; setError("");
          try {
            const project = await createUnifiedProject(kind, title);
            await actions.submit("open", { projectId: project.id, project, createOnly: true });
          } catch (cause) { setError((cause as Error).message); }
          finally { preparing.current = false; }
        }}
      />
      {error && <p role="alert">{error}</p>}<ContainerActionStatus actions={actions} />
    </section>
  );
}
export function ContainerMigrate({ projectId, onOpen }: Props & { projectId: string }) {
  const actions = useContainerActions({ onCommitted() {}, onOpen });
  return (
    <section className="ws-group">
      <p className="ws-note">{t("containerV2.migrationHint")}</p>
      <Button
        disabled={actions.pending}
        onClick={() =>
          void actions.submit("migrate-copy", {
            projectId: `work-${crypto.randomUUID()}`,
            sourceProjectId: projectId,
          })
        }
      >
        {t("containerV2.migrate")}
      </Button>
      <ContainerActionStatus actions={actions} />
    </section>
  );
}
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
