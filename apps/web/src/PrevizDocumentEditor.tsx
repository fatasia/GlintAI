import { useState } from "react";
import type { PrevizDocument } from "../../../packages/previz/src/index";
import { PrevizEditorBody } from "./PrevizEditorBody";
import { editPreviz, parsePrevizDraft } from "./storyboard-previz-model";
import { previzError } from "./storyboard-previz-draft";
import type { PrevizEditingState } from "./previz-editor-state";
import { t } from "./ui/i18n";
import "./storyboard-previz.css";
export type PrevizDocumentEditorProps = {
  document: PrevizDocument;
  onChange(document: PrevizDocument): void;
  active?: boolean;
  readOnly?: boolean;
};
/** Controlled document editor. The host owns saving, CAS, history and error recovery. */
export default function PrevizDocumentEditor({
  document,
  onChange,
  active = true,
  readOnly = false,
}: PrevizDocumentEditorProps) {
  const [selection, select] = useState(""),
    [frame, setFrame] = useState(0),
    [error, setError] = useState("");
  let doc: PrevizDocument;
  try {
    doc = parsePrevizDraft(document);
  } catch (cause) {
    return <p role="alert">{previzError(cause)}</p>;
  }
  const shot = doc.shots.find((item) => item.id === selection)?.id ?? doc.shots[0]!.id;
  const update = (transform: (source: PrevizDocument) => PrevizDocument) => {
    if (readOnly) return;
    try {
      onChange(parsePrevizDraft(transform(doc)));
      setError("");
    } catch (cause) {
      setError(previzError(cause));
    }
  };
  const state: PrevizEditingState = {
    doc,
    shot,
    dirty: false,
    canMigrate: false,
    update,
    change: (kind, id, field, value) =>
      update((source) => editPreviz(source, kind, id, field, value)),
  };
  if (!active) return null;
  return (
    <section className="storyboard-previz" aria-label={t("previz.title")}>
      <header>
        <h3>{t("previz.title")}</h3>
        <p className="ws-note">{t("previz.documentNote")}</p>
      </header>
      {error && <p role="alert">{error}</p>}
      <fieldset className="previz-document-fields" disabled={readOnly}>
        <PrevizEditorBody
          state={state}
          frame={frame}
          onFrame={setFrame}
          onShot={(id) => {
            select(id);
            setFrame(0);
          }}
        />
      </fieldset>
    </section>
  );
}
