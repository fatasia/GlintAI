import { useState } from "react";
import { JOINT_NAMES, type PoseKey, type JointName } from "../../../packages/previz/src/index";
import type { PrevizEditingState } from "./previz-editor-state";
import { actorKeyEdit, migrateDraftCopy } from "./storyboard-previz-keys";
import { KeyFields, NumberField, VectorFields, numeric } from "./PrevizFields";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
type State = PrevizEditingState;
type KeyProps = { value: PoseKey; replace(transform: () => PoseKey): void };
function JointFields({ value, replace }: KeyProps) {
  const [joint, setJoint] = useState<JointName>("leftShoulder");
  const rotation = value.joints.find((item) => item.joint === joint)?.rotationDeg ?? [0, 0, 0];
  return (
    <details>
      <summary>{t("previz.joints")}</summary>
      <select
        className="g-field"
        aria-label={t("previz.joint")}
        value={joint}
        onChange={(event) => setJoint(event.target.value as JointName)}
      >
        {JOINT_NAMES.map((name) => (
          <option key={name} value={name}>
            {t(`previz.joint.${name}`)}
          </option>
        ))}
      </select>
      <VectorFields
        label={t("previz.rotation")}
        value={rotation}
        onChange={(index, text) =>
          replace(() => {
            const rotationDeg = [...rotation] as [number, number, number];
            rotationDeg[index] = numeric(text);
            return {
              ...value,
              joints: [
                ...value.joints.filter((item) => item.joint !== joint),
                { joint, rotationDeg },
              ],
            };
          })
        }
      />
      <Button
        size="sm"
        onClick={() =>
          replace(() => ({
            ...value,
            joints: value.joints.filter((item) => item.joint !== joint),
          }))
        }
      >
        {t("previz.resetJoint")}
      </Button>
    </details>
  );
}
function PoseFields({ value, replace }: KeyProps) {
  return (
    <>
      <KeyFields
        value={value}
        onChange={(transform) => replace(() => transform(value) as PoseKey)}
      />
      <label className="ws-label">
        {t("previz.pose")}
        <select
          className="g-field"
          aria-label={t("previz.pose")}
          value={value.pose}
          onChange={(event) =>
            replace(() => ({ ...value, pose: event.target.value as PoseKey["pose"] }))
          }
        >
          {(["stand", "sit", "walk"] as const).map((pose) => (
            <option key={pose} value={pose}>
              {t(`previz.${pose}`)}
            </option>
          ))}
        </select>
      </label>
      <NumberField
        label={t("previz.phase")}
        value={value.phase}
        onChange={(text) => replace(() => ({ ...value, phase: numeric(text) }))}
      />
      <VectorFields
        label={t("previz.actor")}
        value={value.position}
        onChange={(index, text) =>
          replace(() => {
            const position = [...value.position] as [number, number, number];
            position[index] = numeric(text);
            return { ...value, position };
          })
        }
      />
      <NumberField
        label={t("previz.yaw")}
        value={value.yawDeg}
        onChange={(text) => replace(() => ({ ...value, yawDeg: numeric(text) }))}
      />
      <JointFields value={value} replace={replace} />
    </>
  );
}
function ActorKeys({ state, actorId, timeMs }: { state: State; actorId: string; timeMs: number }) {
  const [selection, select] = useState(0);
  if (state.doc.schemaVersion !== 2) return null;
  const keys = state.doc.actorTracks.find((item) => item.actorId === actorId)?.keys ?? [];
  const index = Math.min(selection, Math.max(0, keys.length - 1)),
    key = keys[index];
  const replace = (transform: () => PoseKey) =>
    state.update((doc) => actorKeyEdit(doc, actorId, { action: "replace", index }, transform()));
  return (
    <>
      {keys.length > 0 && (
        <label className="ws-label">
          {t("previz.actorKey")}
          <select
            className="g-field"
            aria-label={t("previz.actorKey")}
            value={index}
            onChange={(event) => select(Number(event.target.value))}
          >
            {keys.map((entry, i) => (
              <option key={i} value={i}>
                {entry.tMs} ms
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="previz-actions">
        <Button
          size="sm"
          disabled={keys.length >= 200}
          onClick={() =>
            state.update((doc) => actorKeyEdit(doc, actorId, { action: "add", tMs: timeMs }))
          }
        >
          {t("previz.addPose")}
        </Button>
        <Button
          size="sm"
          disabled={!key}
          onClick={() =>
            state.update((doc) => actorKeyEdit(doc, actorId, { action: "remove", index }))
          }
        >
          {t("previz.removeKey")}
        </Button>
      </div>
      {key ? (
        <PoseFields value={key} replace={replace} />
      ) : (
        <p className="ws-note">{t("previz.staticActor")}</p>
      )}
    </>
  );
}
export function PrevizActorKeys({ state, timeMs }: { state: State; timeMs: number }) {
  const [selection, select] = useState("");
  const actor = state.doc.actors.find((item) => item.id === selection) ?? state.doc.actors[0];
  if (!actor) return null;
  return (
    <fieldset>
      <legend>{t("previz.actor")}</legend>
      <select
        className="g-field"
        aria-label={t("previz.actor")}
        value={actor.id}
        onChange={(event) => select(event.target.value)}
      >
        {state.doc.actors.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      {state.doc.schemaVersion === 2 ? (
        <ActorKeys key={actor.id} state={state} actorId={actor.id} timeMs={timeMs} />
      ) : (
        <>
          <VectorFields
            label={t("previz.actor")}
            value={actor.position}
            onChange={(i, text) =>
              state.change("actor", actor.id, (["x", "y", "z"] as const)[i]!, text)
            }
          />
          <NumberField
            label={t("previz.yaw")}
            value={actor.yawDeg}
            onChange={(text) => state.change("actor", actor.id, "yaw", text)}
          />
          <p className="ws-note">
            {t(state.canMigrate === false ? "previz.documentMigration" : "previz.migrationNote")}
          </p>
          {state.canMigrate !== false && (
            <Button
              disabled={state.dirty}
              onClick={() =>
                state.update((doc) => migrateDraftCopy(doc, `previz-${crypto.randomUUID()}`))
              }
            >
              {t("previz.migrate")}
            </Button>
          )}
        </>
      )}
    </fieldset>
  );
}
