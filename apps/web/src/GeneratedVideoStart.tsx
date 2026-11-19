import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { SceneScriptProject } from "@glintai/scenescript";
import type { ComposedWork, ComposeContext } from "./ProjectComposer";
import { createMediaWork, readVideoDuration, type VideoSelection } from "./media-work-start";
import { t } from "./ui/i18n";
import { Button } from "./ui/Button";
import "./creation-start.css";

const MediaWorkshop = lazy(() => import("./MediaWorkshop").then(module => ({ default: module.MediaWorkshop })));

export function GeneratedVideoStart({ disabled, beforeCreate, onCreated, onOpenSettings, onBusyChange }: {
  disabled?: boolean; beforeCreate?(): () => void; onCreated?(work: ComposedWork, context: ComposeContext): void | boolean;
  onOpenSettings?(): void; onBusyChange?(busy: boolean): void;
}) {
  const [title, setTitle] = useState(""), [aspect, setAspect] = useState<SceneScriptProject["aspect"]>("16:9");
  const [busy, setBusy] = useState(false), [taskBusy, setTaskBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null), accepting = useRef(false);
  useEffect(() => { onBusyChange?.(busy || taskBusy); }, [busy, taskBusy, onBusyChange]);
  useEffect(() => () => request.current?.abort(), []);
  const useVideo = async (asset: VideoSelection) => {
    if (disabled || accepting.current) return;
    accepting.current = true; setBusy(true); setError("");
    const controller = new AbortController(); request.current = controller;
    try {
      const verify = beforeCreate?.(), duration = await readVideoDuration(asset.url, controller.signal);
      if (controller.signal.aborted) return;
      verify?.();
      const work = createMediaWork(asset, duration, aspect, title, `video-${crypto.randomUUID()}`);
      if (!onCreated || onCreated(work, { input: work.source, mode: "source", template: "auto", theme: "glint-dark" }) === false) throw new Error(t("creation.notOpened"));
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("creation.notOpened")); }
    finally { accepting.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <section className="creation-start" aria-label={t("creation.generated")}>
    <p className="creation-explanation">{t("creation.generatedHint")}</p>
    <div className="creation-fields">
      <label>{t("creation.title")}<input className="g-field" aria-label={t("creation.title")} maxLength={120} value={title} disabled={disabled || busy} onChange={event => setTitle(event.target.value)} /></label>
      <label>{t("creation.aspect")}<select className="g-field" aria-label={t("creation.aspect")} value={aspect} disabled={disabled || busy} onChange={event => setAspect(event.target.value as SceneScriptProject["aspect"])}>{["16:9", "9:16", "1:1"].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    {onOpenSettings && <div><Button size="sm" variant="ghost" onClick={onOpenSettings}>{t("creation.settings")}</Button></div>}
    <Suspense fallback={<p role="status">{t("workspace.loading")}</p>}><MediaWorkshop initialType="video" disabled={disabled || busy} onUseVideo={useVideo} onBusyChange={setTaskBusy} /></Suspense>
    {busy && <p role="status">{t("creation.reading")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
