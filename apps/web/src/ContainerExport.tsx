import { useEffect, useRef, useState } from "react";
import { assertAllAuthoringCanLeave } from "./authoring-leave";
import { readContainer } from "./container-workspace-client";
import { downloadJson } from "./editor-model";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";

/** Export a verified saved snapshot, not the currently visible editing draft. */
export function ContainerExport({ projectId }: { projectId: string }) {
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState<number | null>(null);
  useEffect(() => {
    setBusy(false); setError(""); setRevision(null);
    return () => { request.current?.abort(); request.current = null; };
  }, [projectId]);
  const run = async () => {
    if (request.current) return;
    let controller: AbortController | undefined;
    try {
      assertAllAuthoringCanLeave();
      controller = new AbortController(); request.current = controller;
      setBusy(true); setError(""); setRevision(null);
      const snapshot = await readContainer(projectId, controller.signal);
      controller.signal.throwIfAborted();
      assertAllAuthoringCanLeave();
      downloadJson(`${snapshot.container.id}-r${snapshot.look.revision}.glint.json`, snapshot.container);
      setRevision(snapshot.look.revision);
    } catch (cause) {
      if (!controller?.signal.aborted) setError(cause instanceof Error ? cause.message : t("container.exportFailed"));
    } finally {
      if (controller && request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  return <section className="ws-group" aria-label={t("container.exportSaved")}>
    <div className="ws-actions"><Button disabled={busy} onClick={() => void run()}>{busy ? t("container.exportReading") : t("container.exportSaved")}</Button></div>
    <p className="ws-note">{t("container.exportSavedHint")}</p>
    {error && <p role="alert" className="ws-note">{error}</p>}
    {revision !== null && <p role="status" className="ws-note">{t("container.exportSavedDone", { revision })}</p>}
  </section>;
}
