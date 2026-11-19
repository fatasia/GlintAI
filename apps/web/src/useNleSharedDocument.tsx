import { useEffect, useRef, useState } from "react";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { canonicalJson } from "@glintai/session";
import { StudioSessionClient, type SessionView } from "./session-client";
import { createContainerDocumentTransport, loadContainerDocument, type ContainerDocumentBinding } from "./container-document-transport";
import { useAuthoringLeaveGuard } from "./authoring-leave";
import { downloadJson } from "./editor-model";
import type { NleSession } from "./nle-session";
import { t } from "./ui/i18n";

export type SharedNleBinding = ContainerDocumentBinding & {
  onCommitted?(): void;
  onStatus?(status: { busy: boolean; conflict: boolean; revision: number; undoDepth: number; redoDepth: number }): void;
};

/** Only gesture projection is local; durable state/history belong to StudioSessionClient. */
export function useNleSharedDocument(binding: SharedNleBinding | undefined, onProject: (project: NleProject) => void) {
  const [view, setView] = useState<SessionView<NleProject> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openingError, setOpeningError] = useState(false), [previewConflict, setPreviewConflict] = useState(false);
  const client = useRef<StudioSessionClient<NleProject> | null>(null);
  const preview = useRef<{ project: NleProject; revision: number } | null>(null);
  const stale = useRef(false), callbacks = useRef({ binding, onProject }); callbacks.current = { binding, onProject };
  const committed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!binding) return;
    let live = true;
    setView(null); setOpeningError(false); setPreviewConflict(false); stale.current = false; preview.current = null;
    void loadContainerDocument(binding, parseNleProject).then(initial => {
      if (!live) return;
      callbacks.current.onProject(initial);
      const next = new StudioSessionClient(initial, value => {
        if (!live) return;
        setView(value);
        if (preview.current) {
          if (value.look && value.look.revision !== preview.current.revision) { stale.current = true; setPreviewConflict(true); }
        } else callbacks.current.onProject(value.project);
        const receipt = value.receipt;
        if (value.status === "ready" && receipt?.stage === "verified" && committed.current !== receipt.transactionId) {
          committed.current = receipt.transactionId; callbacks.current.binding?.onCommitted?.();
        }
        callbacks.current.binding?.onStatus?.({ busy: value.status === "saving" || value.status === "opening", conflict: value.status === "conflict" || stale.current,
          revision: value.look?.revision ?? 0, undoDepth: value.look?.undoDepth ?? 0, redoDepth: value.look?.redoDepth ?? 0 });
      }, undefined, createContainerDocumentTransport(binding, parseNleProject));
      client.current = next; void next.connect();
    }).catch(() => { if (live) setOpeningError(true); });
    const poll = setInterval(() => { if (!preview.current) void client.current?.poll(); }, 1500);
    return () => { live = false; clearInterval(poll); client.current?.dispose(); client.current = null; };
  }, [binding?.projectId, binding?.objectId, attempt]);
  const unsettled = () => {
    const current = client.current?.state();
    return !current || current.dirty || current.status !== "ready" || Boolean(preview.current) || stale.current;
  };
  useAuthoringLeaveGuard(binding?.projectId, () => { if (unsettled()) throw new Error(t("nle.shared.leaveBlocked")); });
  const commit = (next: NleProject) => {
    const current = client.current;
    if (!current || current.state().status === "opening" || stale.current) return false;
    const parsed = parseNleProject(next);
    if (parsed.id !== current.state().project.id) throw new Error(t("nle.shared.unavailable"));
    preview.current = null; current.update(parsed); return true;
  };
  const beginGesture = () => {
    const value = client.current?.state();
    if (!value || value.status !== "ready" || value.dirty || stale.current) return false;
    preview.current = { project: value.project, revision: value.look!.revision }; return true;
  };
  const previewProject = (next: NleProject) => {
    if (!preview.current && !beginGesture()) return false;
    preview.current!.project = next; return true;
  };
  const endGesture = (next: NleProject) => {
    if (stale.current) return false;
    if (preview.current && canonicalJson(next) === canonicalJson(client.current?.state().project)) { preview.current = null; return true; }
    return commit(next);
  };
  const history = (action: "undo" | "redo") => { if (!unsettled()) void client.current?.history(action); };
  // Compatibility reads only. Shared editing must never enter the local NLE history/store.
  const denied = (): never => { throw new Error(t("nle.shared.unavailable")); };
  const session: NleSession = { document: () => client.current?.state().project ?? denied(), revision: () => view?.look?.revision ?? 0,
    undoDepth: () => unsettled() ? 0 : view?.look?.undoDepth ?? 0, redoDepth: () => unsettled() ? 0 : view?.look?.redoDepth ?? 0,
    apply: denied, amendTo: denied, undo: denied, redo: denied, exportState: denied, restore: denied };
  const backupReload = async () => {
    const current = client.current; if (!current || current.state().status === "saving") return;
    const draft = preview.current?.project ?? current.state().project;
    const key = `glint.container-draft:${binding!.projectId}:${binding!.objectId}:${crypto.randomUUID()}`;
    const raw = JSON.stringify(draft); localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error(t("nle.shared.leaveBlocked"));
    await current.reload();
    if (current.state().status === "ready") { preview.current = null; stale.current = false; setPreviewConflict(false); callbacks.current.onProject(current.state().project); }
  };
  const error = openingError || previewConflict || view?.status === "error" || view?.status === "conflict";
  const label = openingError ? "nle.shared.error" : previewConflict || view?.status === "conflict" ? "nle.shared.conflict" : view?.status === "error" ? "nle.shared.error" : view?.status === "saving" ? "nle.shared.saving" : !view || view.status === "opening" ? "nle.shared.opening" : "nle.shared.ready";
  const panel = binding && <div className="nle-alert" role={error ? "alert" : "status"} aria-label={t("nle.shared.ready", { revision: view?.look?.revision ?? 0 })}>
    {t(label, { revision: view?.look?.revision ?? 0 })}
    {error && <><button type="button" className="g-btn g-btn--sm" disabled={previewConflict} onClick={() => { if (client.current) void client.current.retry(); else setAttempt(value => value + 1); }}>{t("nle.shared.retry")}</button>
      <button type="button" className="g-btn g-btn--sm" disabled={!client.current} onClick={() => void backupReload().catch(() => setOpeningError(true))}>{t("nle.shared.reload")}</button>
      <button type="button" className="g-btn g-btn--sm" disabled={!client.current} onClick={() => downloadJson("timeline-draft.json", preview.current?.project ?? client.current!.state().project)}>{t("nle.shared.export")}</button></>}
  </div>;
  return { session, panel, commit, beginGesture, previewProject, endGesture, history, unavailable: t("nle.shared.unavailable"), ready: Boolean(view && view.status !== "opening" && !stale.current) };
}
