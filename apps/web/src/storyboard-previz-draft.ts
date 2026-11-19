import { useEffect, useRef, useState } from "react";
import type { PrevizDocument } from "../../../packages/previz/src/index";
import { useAuthoringLeaveGuard } from "./authoring-leave";
import { downloadJson } from "./editor-model";
import { t, type MessageId } from "./ui/i18n";
import { editPreviz, parsePrevizDraft, readPrevizFile } from "./storyboard-previz-model";
export function previzError(error: unknown): string {
  const key =
    error instanceof Error && error.message.startsWith("previz.")
      ? error.message
      : "previz.geometryError";
  return t(key as MessageId);
}
function useDraftState(initial: PrevizDocument, initialShot: string) {
  const [doc, setDoc] = useState(initial),
    [shot, setShot] = useState(initialShot);
  const [error, setError] = useState(""),
    [dirty, setDirty] = useState(false),
    [downloaded, setDownloaded] = useState(false);
  const baseline = useRef(initial),
    revision = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  return {
    doc,
    setDoc,
    shot,
    setShot,
    error,
    setError,
    dirty,
    setDirty,
    downloaded,
    setDownloaded,
    baseline,
    revision,
    mounted,
  };
}
type State = ReturnType<typeof useDraftState>;
function checkDraft(state: State) {
  if (state.dirty) throw new Error(t("previz.pending"));
}
function replaceDraft(state: State, doc: PrevizDocument) {
  state.revision.current++;
  state.setDoc(doc);
  state.setShot(doc.shots[0]!.id);
  state.setDirty(false);
  state.setDownloaded(false);
  state.setError("");
}
async function importDraft(state: State, file: File) {
  const before = state.revision.current;
  try {
    checkDraft(state);
    const next = await readPrevizFile(file);
    if (!state.mounted.current) return;
    if (before !== state.revision.current) throw new Error("previz.pending");
    state.baseline.current = next;
    replaceDraft(state, next);
  } catch (cause) {
    if (state.mounted.current) state.setError(previzError(cause));
  }
}
function draftActions(state: State) {
  const change = (
    kind: "camera" | "actor",
    id: string,
    field: "x" | "y" | "z" | "yaw" | "fov",
    value: string,
  ) => {
    try {
      const next = editPreviz(state.doc, kind, id, field, value);
      state.revision.current++;
      state.setDoc(next);
      state.setDirty(true);
      state.setDownloaded(false);
      state.setError("");
    } catch (cause) {
      state.setError(previzError(cause));
    }
  };
  const exportFile = () => {
    try {
      downloadJson(`${state.doc.id}.previz.json`, state.doc);
      state.setDownloaded(true);
      state.setError("");
    } catch {
      state.setError(t("previz.invalidFile"));
    }
  };
  const discard = () => {
    if (window.confirm(t("previz.discardConfirm"))) replaceDraft(state, state.baseline.current);
  };
  const selectShot = (id: string) => {
    try {
      checkDraft(state);
      state.setShot(id);
    } catch (cause) {
      state.setError((cause as Error).message);
    }
  };
  return {
    change,
    exportFile,
    discard,
    selectShot,
    importFile: (file: File) => importDraft(state, file),
    confirmSaved: () => {
      if (!state.downloaded) return;
      state.baseline.current = state.doc;
      state.setDirty(false);
      state.setDownloaded(false);
    },
  };
}
function updateDraft(state: State, transform: (doc: PrevizDocument) => PrevizDocument) {
  try {
    const next = parsePrevizDraft(transform(state.doc));
    state.revision.current++;
    state.setDoc(next);
    state.setDirty(true);
    state.setDownloaded(false);
    state.setError("");
  } catch (cause) {
    state.setError(previzError(cause));
  }
}
export function usePrevizDraft(initial: PrevizDocument, projectId: string, initialShot: string) {
  const state = useDraftState(initial, initialShot);
  useAuthoringLeaveGuard(projectId, () => checkDraft(state));
  return {
    ...state,
    ...draftActions(state),
    update: (transform: (doc: PrevizDocument) => PrevizDocument) => updateDraft(state, transform),
  };
}
