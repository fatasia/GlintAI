import { ContainerCreate, ContainerMigrate } from "./ContainerCreate";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { parseProject } from "@glintai/scenescript";
import type { DocumentKind } from "@glintai/scenescript/project-container";
import { assertAllAuthoringCanLeave, useAuthoringLeaveGuard } from "./authoring-leave";
import { AuthoringVisibility } from "./authoring-visibility";
import { importContainerCopy, importContainerPair, readContainer, type ContainerSnapshot } from "./container-workspace-client";
import { downloadJson } from "./editor-model";
import { ContainerScene } from "./ContainerScene";
import { ContainerExport } from "./ContainerExport";
import { ContainerProjectList } from "./ContainerProjectList";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
const WorkspaceV2 = lazy(() => import("./ContainerWorkspaceV2"));
const NleEditor = lazy(() => import("./NleEditor").then(module => ({ default: module.NleEditor })));
const ContainerGraph = lazy(() => import("./ContainerGraph"));

export default function ContainerWorkspace({ projectId, objectId, active = true, onOpen }: {
  projectId?: string; objectId?: string; active?: boolean; onOpen(projectId: string, objectId?: string): void;
}) {
  const [snapshot, setSnapshot] = useState<ContainerSnapshot | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0), [identifier, setIdentifier] = useState("");
  useEffect(() => {
    if (!projectId) { setSnapshot(null); return; }
    const controller = new AbortController(); setLoading(true); setError("");
    void readContainer(projectId, controller.signal).then(value => { if (!controller.signal.aborted) setSnapshot(value); })
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, refresh]);
  const current = snapshot?.container.id === projectId ? snapshot : null;
  const documents = current?.container.objects.filter(object => ["scene-document", "timeline-document"].includes(object.kind)) ?? [];
  const selected = objectId ? documents.find(object => object.id === objectId) : documents[0];
  const version = current?.container.versions.find(item => item.id === selected?.currentVersionId);
  const snapshotRevision = useRef(current?.look.revision ?? -1); snapshotRevision.current = current?.look.revision ?? -1;
  const binding = useMemo(() => {
    if (!projectId || !selected) return undefined;
    let requestedRevision = -1;
    return { projectId, objectId: selected.id, onCommitted: () => setRefresh(value => value + 1),
      onStatus: ({ revision, busy }: { revision: number; busy: boolean }) => {
        if (busy || revision <= snapshotRevision.current || revision <= requestedRevision) return;
        requestedRevision = revision; setRefresh(value => value + 1);
      } };
  }, [projectId, selected?.id]);
  const open = (id: string, documentId?: string) => {
    try {
      assertAllAuthoringCanLeave();
      onOpen(id, documentId);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  if (current?.container.version === 2) return <Suspense fallback={<p role="status">{t("container.loading")}</p>}>
    <WorkspaceV2 snapshot={current} objectId={objectId} active={active} onOpen={open} onCommitted={() => setRefresh(value => value + 1)} />
  </Suspense>;
  return (
    <section className="workspace-page" aria-label={t("container.title")}>
      <header className="workspace-bar">
        <h1 className="workspace-bar-title">{t("container.title")}</h1>
        {current && (
          <span role="status">{t("container.revision", { revision: current.look.revision })}</span>
        )}
      </header>
      <p className="ws-note">{t("container.boundary")}</p>
      {projectId && (
        <a
          className="g-link"
          href="#/c"
          onClick={(event) => {
            try {
              assertAllAuthoringCanLeave();
            } catch (cause) {
              event.preventDefault();
              setError((cause as Error).message);
            }
          }}
        >
          {t("container.listBack")}
        </a>
      )}
      {!projectId && (
        <>
          <ContainerCreate onOpen={open} /><ContainerProjectList onOpen={open} />
          <label className="ws-label">
            {t("container.id")}
            <input
              className="g-field"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
          </label>
          <Button
            disabled={!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identifier)}
            onClick={() => open(identifier)}
          >
            {t("container.open")}
          </Button>
          <ContainerImport onOpen={(id) => open(id)} />
        </>
      )}
      {loading && !current && <p role="status">{t("container.loading")}</p>}
      {error && <p role="alert">{error}</p>}
      {current && <ContainerMigrate projectId={current.container.id} onOpen={open} />}{current && <ContainerExport key={current.container.id} projectId={current.container.id} />}
      {current && (
        <Suspense fallback={null}>
          <ContainerGraph
            key={current.container.id}
            container={current.container}
            onOpen={(id) => open(current.container.id, id)}
          />
        </Suspense>
      )}
      {current && (
        <label className="ws-label">
          {t("container.document")}
          <select
            className="g-field"
            value={selected?.id ?? ""}
            onChange={(event) => open(current.container.id, event.target.value)}
          >
            {documents.map((object) => (
              <option key={object.id} value={object.id}>
                {object.id} ·{" "}
                {t(object.kind === "scene-document" ? "container.scene" : "container.timeline")}
              </option>
            ))}
          </select>
        </label>
      )}
      {current && (!selected || !version) && (
        <p role="status">{objectId ? t("container.unknown") : t("container.empty")}</p>
      )}
      {selected && version && binding && (
        <AuthoringVisibility active={active}>
          <Suspense fallback={<p role="status">{t("container.loading")}</p>}>
            {selected.kind === "scene-document" ? (
              <ContainerScene
                key={`${projectId}:${selected.id}`}
                binding={binding}
                initial={parseProject(version.payload)}
                active={active}
              />
            ) : (
              <NleEditor key={`${projectId}:${selected.id}`} shared={binding} active={active} />
            )}
          </Suspense>
        </AuthoringVisibility>
      )}
    </section>
  );
}

function ContainerImport({ onOpen }: { onOpen(id: string): void }) {
  const [kind, setKind] = useState<DocumentKind | "container" | "paired">("scene-document"), [file, setFile] = useState<File>(), [timelineFile, setTimelineFile] = useState<File>();
  const importing = useRef(false), mounted = useRef(true), importController = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importController.current?.abort(); }; }, []);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useAuthoringLeaveGuard(busy ? "container-import" : undefined, () => { if (importing.current) throw new Error(t("container.blocked")); });
  const run = async () => {
    if (!file || !confirmed || busy || importing.current || kind === "paired" && !timelineFile) return;
    setBusy(true); setError("");
    try {
      assertAllAuthoringCanLeave(); importing.current = true;
      const controller = new AbortController(); importController.current = controller;
      const files = kind === "paired" ? [file, timelineFile!] : [file];
      if (files.some(item => item.size > 2 * 1024 * 1024)) throw new Error(t("container.tooLarge"));
      const inputs = await Promise.all(files.map(async item => JSON.parse(await item.text()) as unknown));
      if (!mounted.current) return;
      const value = kind === "paired" ? await importContainerPair(inputs[0], inputs[1], undefined, controller.signal) : await importContainerCopy(inputs[0], kind);
      importing.current = false; if (mounted.current) onOpen(value.container.id);
    } catch (cause) { if (mounted.current) setError((cause as Error).message); } finally { importing.current = false; importController.current = null; if (mounted.current) setBusy(false); }
  };
  return <fieldset className="ws-group" disabled={busy}><legend>{t("container.import")}</legend><p className="ws-note">{t("container.importHint")}</p>
    <label className="ws-label">{t("container.kind")}<select className="g-field" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setTimelineFile(undefined); setConfirmed(false); }}>
      <option value="scene-document">{t("container.scene")}</option><option value="timeline-document">{t("container.timeline")}</option><option value="container">{t("container.format")}</option><option value="paired">{t("container.paired")}</option>
    </select></label>
    {kind === "paired" && <p className="ws-note">{t("container.pairHint")}</p>}
    <label className="ws-label">{t(kind === "paired" ? "container.sceneFile" : "container.file")}<input type="file" aria-label={t(kind === "paired" ? "container.sceneFile" : "container.file")} accept=".json,application/json" onChange={event => { setFile(event.target.files?.[0]); setConfirmed(false); }} /></label>
    {kind === "paired" && <label className="ws-label">{t("container.timelineFile")}<input type="file" aria-label={t("container.timelineFile")} accept=".json,application/json" onChange={event => { setTimelineFile(event.target.files?.[0]); setConfirmed(false); }} /></label>}
    <label className="tool-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("container.confirm")}</label>
    <Button disabled={!file || !confirmed || kind === "paired" && !timelineFile} onClick={() => void run()}>{t("container.import")}</Button>{error && <p role="alert">{error}</p>}
  </fieldset>;
}

