import { useEffect, useState } from "react";
import type { CameraKey, PoseKey, Vec3 } from "../../../packages/previz/src/index";
import { t } from "./ui/i18n";
export type MotionKey = CameraKey | PoseKey;
export function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: string): void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="ws-label">
      {label}
      <input
        className="g-field"
        type="number"
        step="0.1"
        aria-label={label}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value);
        }}
      />
    </label>
  );
}
export function numeric(value: string): number {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error("previz.invalidNumber");
  return Number(value);
}
export function VectorFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Vec3;
  onChange(index: number, value: string): void;
}) {
  return (
    <div className="previz-vector">
      {(["x", "y", "z"] as const).map((axis, index) => (
        <NumberField
          key={axis}
          label={`${label} ${t(`previz.${axis}`)}`}
          value={value[index]!}
          onChange={(text) => onChange(index, text)}
        />
      ))}
    </div>
  );
}
export function KeyFields({
  value,
  onChange,
}: {
  value: MotionKey;
  onChange(transform: (key: MotionKey) => MotionKey): void;
}) {
  return (
    <>
      <NumberField
        label={t("previz.keyTime")}
        value={value.tMs}
        onChange={(text) => onChange((key) => ({ ...key, tMs: numeric(text) }))}
      />
      <label className="ws-label">
        {t("previz.easing")}
        <select
          className="g-field"
          aria-label={t("previz.easing")}
          value={value.easing}
          onChange={(event) =>
            onChange((key) => ({ ...key, easing: event.target.value as MotionKey["easing"] }))
          }
        >
          <option value="linear">{t("previz.linear")}</option>
          <option value="ease-in-out">{t("previz.easeInOut")}</option>
        </select>
      </label>
    </>
  );
}
