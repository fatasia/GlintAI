import type { SceneScriptProject } from "@glintai/scenescript";
import { sceneDisplayTitle } from "./editor-model";
import { SceneTimelineControls } from "./SceneTimelineControls";
import { useSceneTimeline, type SceneTimelineState } from "./scene-timeline-state";
import { t } from "./ui/i18n";
import "./scene-timeline.css";

export interface TimelinePanelProps {
  project: SceneScriptProject;
  selectedSceneId: string;
  onChange(project: SceneScriptProject): void;
  onSelect?(id: string): void;
  compact?: boolean;
}

/** Scene-level operations still use editTimeline and the parent's existing commit. */
export function TimelinePanel(props: TimelinePanelProps) {
  const state = useSceneTimeline(props);
  const { timeline, feedback } = state;
  return (
    <section
      aria-label={t("st.title")}
      className={props.compact ? "timeline-panel is-compact" : "timeline-panel"}
    >
      <div className="scene-timeline-row">
        <strong>{t("st.title")}</strong>
        <span aria-label={t("st.duration")}>
          {t("st.total", {
            count: timeline.entries.length,
            seconds: (timeline.totalMs / 1000).toFixed(2),
          })}
        </span>
      </div>
      {!timeline.entries.length ? (
        <p>{t("st.empty")}</p>
      ) : (
        <>
          <SceneTimelineStrip state={state} />
          <details className="timeline-operations" open={!props.compact}>
            <summary>{t("st.operations")}</summary>
            <div className="timeline-operations-body">
              <SceneTimelineControls state={state} />
              <small>{t("st.hint")}</small>
            </div>
          </details>
        </>
      )}
      {feedback && (
        <p role={feedback.error ? "alert" : "status"} className="scene-timeline-feedback">
          {feedback.text}
        </p>
      )}
    </section>
  );
}

function SceneTimelineStrip({ state: { timeline, scene, select } }: { state: SceneTimelineState }) {
  return (
    <div role="group" aria-label={t("st.strip")} className="scene-timeline-scroll">
      <div
        className="scene-timeline-strip"
        style={{ minWidth: Math.max(480, timeline.entries.length * 80) }}
      >
        {timeline.entries.map((entry) => (
          <button
            key={entry.scene.id}
            type="button"
            className="scene-timeline-clip"
            aria-pressed={entry.scene.id === scene?.id}
            aria-label={t("st.select", { id: entry.scene.id })}
            title={t("st.tooltip", {
              id: entry.scene.id,
              start: (entry.startMs / 1000).toFixed(2),
              duration: (entry.durationMs / 1000).toFixed(2),
              lock: entry.scene.locked ? t("st.lockSuffix") : "",
            })}
            onClick={() => select(entry.scene.id)}
            style={{ flex: `${entry.durationMs} 0 0px` }}
          >
            <span>
              {String(entry.index + 1).padStart(2, "0")} · {sceneDisplayTitle(entry.scene)}
            </span>
            <small>
              {t("st.seconds", { value: (entry.durationMs / 1000).toFixed(2) })}
              {entry.scene.locked ? t("st.lockSuffix") : ""}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}
