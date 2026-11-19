import type { RefObject } from "react";
import type { SessionDocument, SessionView, StudioSessionClient } from "./session-client";
import { downloadJson } from "./editor-model";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
export function ContainerDocumentStatus<T extends SessionDocument>({
  view,
  client,
}: {
  view: SessionView<T>;
  client: RefObject<StudioSessionClient<T> | null>;
}) {
  return (
    <div className="ws-actions" aria-label={t("container.save")}>
      <span role="status">{view.message}</span>
      {view.status === "error" && (
        <Button onClick={() => void client.current?.retry()}>{t("container.retry")}</Button>
      )}
      {(view.status === "error" || view.status === "conflict") && (
        <Button
          onClick={() => {
            downloadJson("document-draft.json", view.project);
            void client.current?.reload();
          }}
        >
          {t("container.reload")}
        </Button>
      )}
      <Button onClick={() => downloadJson("document-draft.json", view.project)}>
        {t("container.export")}
      </Button>
    </div>
  );
}
