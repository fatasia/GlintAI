import { useState } from "react";
import type { CameraKey } from "../../../packages/previz/src/index";
import type { PrevizEditingState } from "./previz-editor-state";
import { cameraKeyEdit } from "./storyboard-previz-keys";
import { KeyFields, NumberField, VectorFields, numeric } from "./PrevizFields";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
type Props = { state: PrevizEditingState; timeMs: number };
type TargetProps = {
  value: CameraKey;
  state: Props["state"];
  onChange(transform: () => CameraKey): void;
};
function TargetFields({ value, state, onChange }: TargetProps) {
  const target = value.target,
    point = "point" in target ? target.point : (target.offset ?? [0, 0, 0]);
  return (
    <>
      <label className="ws-label">
        {t("previz.target")}
        <select
          className="g-field"
          aria-label={t("previz.target")}
          value={"point" in target ? "point" : target.actorId}
          onChange={(event) =>
            onChange(() => ({
              ...value,
              target:
                event.target.value === "point"
                  ? { point: [0, 1, 0] }
                  : { actorId: event.target.value },
            }))
          }
        >
          <option value="point">{t("previz.fixedTarget")}</option>
          {state.doc.actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name}
            </option>
          ))}
        </select>
      </label>
      <VectorFields
        label={t("point" in target ? "previz.target" : "previz.offset")}
        value={point}
        onChange={(index, text) =>
          onChange(() => {
            const vector = [...point] as [number, number, number];
            vector[index] = numeric(text);
            return {
              ...value,
              target:
                "point" in target ? { point: vector } : { actorId: target.actorId, offset: vector },
            };
          })
        }
      />
    </>
  );
}
function CameraActions({
  state,
  timeMs,
  cameraId,
  count,
  index,
}: Props & {
  cameraId: string;
  count: number;
  index: number;
}) {
  return (
    <div className="previz-actions">
      <Button
        size="sm"
        disabled={count >= 200}
        onClick={() =>
          state.update((doc) => cameraKeyEdit(doc, cameraId, { action: "add", tMs: timeMs }))
        }
      >
        {t("previz.addKey")}
      </Button>
      <Button
        size="sm"
        disabled={count <= 1}
        onClick={() =>
          state.update((doc) => cameraKeyEdit(doc, cameraId, { action: "remove", index }))
        }
      >
        {t("previz.removeKey")}
      </Button>
    </div>
  );
}
export function PrevizCameraKeys({ state, timeMs }: Props) {
  const [selection, select] = useState(0),
    shot = state.doc.shots.find((item) => item.id === state.shot)!;
  const camera = state.doc.cameras.find((item) => item.id === shot.cameraId)!;
  const index = Math.min(selection, camera.keys.length - 1),
    key = camera.keys[index]!;
  const replace = (transform: () => CameraKey) =>
    state.update((doc) => cameraKeyEdit(doc, camera.id, { action: "replace", index }, transform()));
  return (
    <fieldset>
      <legend>{t("previz.camera")}</legend>
      <p className="ws-note">{t("previz.keyNote")}</p>
      <label className="ws-label">
        {t("previz.cameraKey")}
        <select
          className="g-field"
          aria-label={t("previz.cameraKey")}
          value={index}
          onChange={(event) => select(Number(event.target.value))}
        >
          {camera.keys.map((entry, i) => (
            <option key={i} value={i}>
              {entry.tMs} ms
            </option>
          ))}
        </select>
      </label>
      <CameraActions
        state={state}
        timeMs={timeMs}
        cameraId={camera.id}
        count={camera.keys.length}
        index={index}
      />
      <KeyFields value={key} onChange={(transform) => replace(() => transform(key) as CameraKey)} />
      <VectorFields
        label={t("previz.camera")}
        value={key.position}
        onChange={(i, text) =>
          replace(() => {
            const position = [...key.position] as [number, number, number];
            position[i] = numeric(text);
            return { ...key, position };
          })
        }
      />
      <TargetFields value={key} state={state} onChange={replace} />
      <NumberField
        label={t("previz.fov")}
        value={camera.fovDeg}
        onChange={(value) => state.change("camera", camera.id, "fov", value)}
      />
    </fieldset>
  );
}
