import type { SceneTimelineState } from "./scene-timeline-state";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";

export function SceneTimelineControls({ state }: { state: SceneTimelineState }) {
  const { scene, execute } = state;
  if (!scene) return null;
  return (
    <>
      <div className="scene-timeline-row">
        <strong>{t("st.current", { id: scene.id })}</strong>
        <span>{t(scene.locked ? "st.locked" : "st.unlocked")}</span>
        <Button
          size="sm"
          onClick={() =>
            execute(
              { type: "lock", sceneId: scene.id, locked: !scene.locked },
              t(scene.locked ? "st.didUnlock" : "st.didLock"),
            )
          }
        >
          {t(scene.locked ? "st.unlock" : "st.lock")}
        </Button>
      </div>
      {scene.locked && <small>{t("st.unlockHint")}</small>}
      <BoundaryControls state={state} />
      <SplitControls state={state} />
    </>
  );
}

function BoundaryControls({ state }: { state: SceneTimelineState }) {
  const { scene, execute } = state;
  if (!scene) return null;
  const actions = [
    [
      "st.trimMinus",
      { type: "trim", sceneId: scene.id, edge: "end", deltaMs: 100 },
      "st.didTrimMinus",
    ],
    [
      "st.trimPlus",
      { type: "trim", sceneId: scene.id, edge: "end", deltaMs: -100 },
      "st.didTrimPlus",
    ],
    ["st.rollMinus", { type: "roll", sceneId: scene.id, deltaMs: -100 }, "st.didRollMinus"],
    ["st.rollPlus", { type: "roll", sceneId: scene.id, deltaMs: 100 }, "st.didRollPlus"],
    ["st.delete", { type: "ripple-delete", sceneId: scene.id }, "st.didDelete"],
  ] as const;
  return (
    <fieldset
      disabled={scene.locked}
      title={scene.locked ? t("st.unlockFirst") : undefined}
      className="scene-timeline-actions"
    >
      <legend>{t("st.bounds")}</legend>
      {actions.map(([label, command, success]) => (
        <Button key={label} size="sm" onClick={() => execute(command, t(success))}>
          {t(label)}
        </Button>
      ))}
    </fieldset>
  );
}

function SplitControls({ state }: { state: SceneTimelineState }) {
  const { scene, splitMs, setSplitMs, duplicateText, setDuplicateText, split } = state;
  return (
    <fieldset
      disabled={scene?.locked}
      title={scene?.locked ? t("st.unlockFirst") : undefined}
      className="scene-timeline-actions"
    >
      <legend>{t("st.split")}</legend>
      <label className="scene-timeline-position">
        {t("st.position")}
        <input
          className="g-field"
          aria-label={t("st.positionLabel")}
          type="number"
          step={1}
          value={splitMs}
          onChange={(event) => setSplitMs(event.target.value)}
        />
      </label>
      <label className="scene-timeline-check">
        <input
          type="checkbox"
          checked={duplicateText}
          onChange={(event) => setDuplicateText(event.target.checked)}
        />
        {t("st.duplicate")}
      </label>
      <Button size="sm" onClick={split}>
        {t("st.splitHere")}
      </Button>
    </fieldset>
  );
}
