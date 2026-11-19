import { useMemo, useState } from "react";
import type { Series } from "@glintai/composer/drama-series";
import { previzFromScene } from "@glintai/composer/drama-previz";
import type { PrevizDocument } from "../../../packages/previz/src/index";
import { parsePrevizDraft } from "./storyboard-previz-model";
import { usePrevizDraft, previzError } from "./storyboard-previz-draft";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import { PrevizEditorBody } from "./PrevizEditorBody";
import "./storyboard-previz.css";
type Draft = ReturnType<typeof usePrevizDraft>;
type Props = {
  series: Series;
  sceneId: string;
  shotId: string;
  projectId: string;
  onClose(): void;
};

function DraftActions({ state, onClose }: { state: Draft; onClose(): void }) {
  return (
    <div className="previz-actions">
      <label className="ws-label">
        {t("previz.import")}
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void state.importFile(file);
          }}
        />
      </label>
      <Button onClick={state.exportFile}>{t("previz.export")}</Button>
      {state.downloaded && (
        <>
          <p role="status">{t("previz.exported")}</p>
          <Button onClick={state.confirmSaved}>{t("previz.savedConfirm")}</Button>
        </>
      )}
      {state.dirty && (
        <Button variant="ghost" onClick={state.discard}>
          {t("previz.discard")}
        </Button>
      )}
      <Button variant="ghost" onClick={onClose}>
        {t("previz.close")}
      </Button>
    </div>
  );
}
function DraftHeading({ state }: { state: Draft }) {
  return (
    <>
      <header>
        <h3>{t("previz.title")}</h3>
        <p className="ws-note">{t("previz.boundary")}</p>
      </header>
      <p role="status">{t(state.dirty ? "previz.pending" : "previz.initial")}</p>
      {state.error && <p role="alert">{state.error}</p>}
    </>
  );
}
type PrevizPanelProps = {
  initial: PrevizDocument;
  initialShot: string;
  projectId: string;
  onClose(): void;
};
function PrevizPanel({ initial, initialShot, projectId, onClose }: PrevizPanelProps) {
  const state = usePrevizDraft(initial, projectId, initialShot),
    [frame, setFrame] = useState(0);
  return (
    <section className="storyboard-previz" aria-label={t("previz.title")}>
      <DraftHeading state={state} />
      <PrevizEditorBody state={state} frame={frame} onFrame={setFrame} onShot={state.selectShot} />
      <DraftActions state={state} onClose={onClose} />
    </section>
  );
}
export default function StoryboardPreviz(props: Props) {
  const prepared = useMemo(() => {
    try {
      return { doc: parsePrevizDraft(previzFromScene(props.series, props.sceneId).doc) };
    } catch (error) {
      return { error: previzError(error) };
    }
  }, [props.series, props.sceneId]);
  if (!prepared.doc) return <p role="alert">{prepared.error}</p>;
  const shot =
    prepared.doc.shots.find((item) => item.dramaShotId === props.shotId) ?? prepared.doc.shots[0]!;
  return (
    <PrevizPanel
      key={`${props.projectId}:${props.sceneId}:${props.shotId}`}
      initial={prepared.doc}
      initialShot={shot.id}
      projectId={props.projectId}
      onClose={props.onClose}
    />
  );
}
