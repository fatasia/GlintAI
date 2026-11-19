import { lazy, Suspense, useMemo } from "react";
import type { PrevizEditingState } from "./previz-editor-state";
import { previzPreview } from "./storyboard-previz-model";
import { PrevizCameraKeys } from "./PrevizCameraKeys";
import { PrevizActorKeys } from "./PrevizActorKeys";
import { t } from "./ui/i18n";
import { previzError } from "./storyboard-previz-draft";
const Preview = lazy(() => import("./StoryboardPrevizPreview"));
type Props = {
  state: PrevizEditingState;
  frame: number;
  onFrame(frame: number): void;
  onShot(id: string): void;
};
function Checks({ issues }: { issues: ReturnType<typeof previzPreview>["issues"] }) {
  return (
    <section aria-label={t("previz.checks")}>
      <h4>{t("previz.checks")}</h4>
      {issues.length ? (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${issue.code}:${index}`}>{issue.message}</li>
          ))}
        </ul>
      ) : (
        <p>{t("previz.noIssues")}</p>
      )}
    </section>
  );
}
function sample(state: PrevizEditingState, frame: number) {
  try {
    return { value: previzPreview(state.doc, state.shot, frame), error: "" };
  } catch (cause) {
    return { value: undefined, error: previzError(cause) };
  }
}
export function PrevizEditorBody({ state, frame, onFrame, onShot }: Props) {
  const shot = state.doc.shots.find((item) => item.id === state.shot)!;
  const frames = Math.max(1, Math.round(((shot.endMs - shot.startMs) * state.doc.fps) / 1000));
  const boundedFrame = Math.min(frame, frames - 1);
  const shown = useMemo(() => sample(state, boundedFrame), [state.doc, state.shot, boundedFrame]);
  const timeMs = Math.round((boundedFrame * 1000) / state.doc.fps);
  return (
    <>
      <label className="ws-label">
        {t("previz.shot")}
        <select
          className="g-field"
          aria-label={t("previz.shot")}
          value={state.shot}
          onChange={(event) => onShot(event.target.value)}
        >
          {state.doc.shots.map((item) => (
            <option key={item.id} value={item.id}>
              {item.dramaShotId ?? item.id}
            </option>
          ))}
        </select>
      </label>
      <div className="previz-layout">
        <div className="previz-preview">
          <Suspense fallback={<p>{t("previz.loading")}</p>}>
            {shown.value ? (
              <Preview scene={shown.value.project.scenes[0]!} aspect={state.doc.aspect} />
            ) : (
              <p role="alert">{shown.error}</p>
            )}
          </Suspense>
          <label className="ws-label">
            {t("previz.frame")} {boundedFrame}
            <input
              type="range"
              aria-label={t("previz.frame")}
              min={0}
              max={frames - 1}
              value={boundedFrame}
              onChange={(event) => onFrame(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="previz-parameters">
          <PrevizCameraKeys state={state} timeMs={timeMs} />
          <PrevizActorKeys state={state} timeMs={timeMs} />
        </div>
      </div>
      {shown.value && <Checks issues={shown.value.issues} />}
    </>
  );
}
