import { useState } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import { addAnimatedLabel, addMotionScene } from "./hybrid-scene-model";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./hybrid-scene-tools.css";

export function HybridSceneTools({ project, sceneId, onChange, onSelect, onInspect }: {
  project: SceneScriptProject; sceneId: string; onChange(project: SceneScriptProject): void;
  onSelect(id: string): void; onInspect(tab: "visual" | "generate"): void;
}) {
  const [error, setError] = useState("");
  const apply = (kind: "motion" | "label") => {
    try {
      const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
      onChange(kind === "motion" ? addMotionScene(project, id, t("hybrid.newMotion")) : addAnimatedLabel(project, sceneId, id, t("hybrid.newLabel")));
      if (kind === "motion") onSelect(id);
      onInspect("visual"); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("hybrid.cannotAdd")); }
  };
  const scene = project.scenes.find(item => item.id === sceneId);
  return <section className="hybrid-tools" aria-label={t("hybrid.tools")}>
    <div role="group" aria-label={t("hybrid.tools")}>
      <Button size="sm" disabled={project.frozen || scene?.locked} onClick={() => onInspect("generate")}>{t("hybrid.generate")}</Button>
      <Button size="sm" disabled={project.frozen || project.scenes.length >= 30} onClick={() => apply("motion")}>{t("hybrid.addMotion")}</Button>
      <Button size="sm" disabled={project.frozen || scene?.locked} onClick={() => apply("label")}>{t("hybrid.addLabel")}</Button>
    </div>
    <small>{t("hybrid.hint")}</small>{error && <p role="alert">{error}</p>}
  </section>;
}
