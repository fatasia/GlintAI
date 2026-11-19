import type { NleProject } from "@glintai/scenescript";
import { nleRenderOptions } from "../server/nle-render-options";
import type { RenderMotion } from "./nle-render-client";
import { t } from "./ui/i18n";
import "./nle-render-options.css";
export function motionWarning(project: NleProject, value: RenderMotion): string {
  try {
    nleRenderOptions(project, value.motionSamples, value.shutterAngle);
    return "";
  } catch {
    return t(
      [1, 2, 4, 8].includes(value.motionSamples) &&
        value.shutterAngle > 0 &&
        value.shutterAngle <= 360
        ? "nleRender.limit"
        : "nleRender.invalid",
    );
  }
}
export function NleRenderOptions({
  project,
  value,
  onChange,
  disabled,
}: {
  project: NleProject;
  value: RenderMotion;
  onChange: (value: RenderMotion) => void;
  disabled: boolean;
}) {
  const warning = motionWarning(project, value);
  return (
    <fieldset className="nle-render-options" disabled={disabled}>
      <legend>{t("nleRender.options")}</legend>
      <label>
        {t("nleRender.samples")}
        <select
          className="g-field"
          aria-label={t("nleRender.samples")}
          value={value.motionSamples}
          onChange={(event) => onChange({ ...value, motionSamples: Number(event.target.value) })}
        >
          {[1, 2, 4, 8].map((count) => (
            <option key={count} value={count}>
              {count === 1 ? t("nleRender.off") : t("nleRender.sampleCount", { count })}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("nleRender.shutter")}
        <input
          className="g-field"
          aria-label={t("nleRender.shutter")}
          type="number"
          min="1"
          max="360"
          value={value.shutterAngle}
          disabled={value.motionSamples === 1}
          onChange={(event) => onChange({ ...value, shutterAngle: Number(event.target.value) })}
        />
      </label>
      <p>{t("nleRender.help")}</p>
      {warning && <p role="alert">{warning}</p>}
    </fieldset>
  );
}
